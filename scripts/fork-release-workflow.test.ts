// @effect-diagnostics nodeBuiltinImport:off - Reads the committed release workflow as text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { FORK_VERIFICATION_SCOPE } from "./fork-release-manifest.ts";

// A fork release is dispatched from atli, guarded before any build, admitted
// by upgrading over the prior release's data, and published once: the tag and
// an immutable release. GitHub attests its own builds; EAS mobile provenance
// is recorded in the manifest and delivery history.
const workflow = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", ".github", "workflows", "fork-server-release.yml"),
  "utf8",
);
const mobileDelivery = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", ".github", "workflows", "fork-mobile-delivery.yml"),
  "utf8",
);
const mobileRetry = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", ".github", "workflows", "fork-mobile-update.yml"),
  "utf8",
);

const topLevelBlock = (key: string, text = workflow): ReadonlyArray<string> => {
  const lines = text.split("\n");
  const start = lines.indexOf(`${key}:`);
  expect(start, key).toBeGreaterThan(-1);
  const block: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block;
};

const jobs = (text = workflow): ReadonlyMap<string, ReadonlyArray<string>> => {
  const result = new Map<string, Array<string>>();
  let current: Array<string> | undefined;
  for (const line of topLevelBlock("jobs", text)) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      current = [];
      result.set(job[1]!, current);
      continue;
    }
    current?.push(line);
  }
  return result;
};

const job = (name: string, text = workflow): ReadonlyArray<string> => {
  const body = jobs(text).get(name);
  expect(body, name).toBeDefined();
  return body!;
};

// The `key:` block directly under a job, as `name: value` pairs.
const jobMap = (body: ReadonlyArray<string>, key: string): ReadonlyMap<string, string> => {
  const start = body.indexOf(`    ${key}:`);
  const entries = new Map<string, string>();
  if (start === -1) return entries;
  for (const line of body.slice(start + 1)) {
    if (/^ {6}#/.test(line)) continue;
    const entry = /^ {6}([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (!entry) break;
    entries.set(entry[1]!, entry[2]!);
  }
  return entries;
};

const needsOf = (body: ReadonlyArray<string>): ReadonlyArray<string> => {
  const inline = body.map((line) => /^ {4}needs:\s*(.+?)\s*$/.exec(line)?.[1]).find(Boolean);
  if (!inline) return [];
  const list = /^\[(.*)\]$/.exec(inline)?.[1] ?? inline;
  return list
    .split(",")
    .map((need) => need.trim())
    .filter((need) => need.length > 0);
};

// Each step as its own text, from its `- ` line to the next.
const stepsOf = (body: ReadonlyArray<string>): ReadonlyArray<string> => {
  const steps: Array<Array<string>> = [];
  for (const line of body) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length > 0 && /^ {8}/.test(line)) steps.at(-1)!.push(line);
    else if (steps.length > 0 && !/^\s*$/.test(line)) steps.push([]);
  }
  return steps.filter((step) => step.length > 0).map((step) => step.join("\n"));
};

const runsOn = (body: ReadonlyArray<string>): string | undefined =>
  body.map((line) => /^ {4}runs-on:\s*(.+?)\s*$/.exec(line)?.[1]).find(Boolean);

const buildJobs = (): ReadonlyArray<string> =>
  [...jobs().keys()].filter((name) => name.startsWith("build-"));

const ATTEST = /uses: actions\/attest-build-provenance@/;

const ifOf = (body: ReadonlyArray<string>): string | undefined =>
  body.map((line) => /^ {4}if:\s*(.+?)\s*$/.exec(line)?.[1]).find(Boolean);

const stepIndex = (steps: ReadonlyArray<string>, pattern: RegExp): number => {
  const index = steps.findIndex((step) => pattern.test(step));
  expect(index, String(pattern)).toBeGreaterThan(-1);
  return index;
};

const CONFIG_CHECK =
  /node scripts\/fork-android-config\.ts --config "\$RUNNER_TEMP\/expo-config\.json"/;
const ANDROID_DELIVERY = /node scripts\/fork-mobile-release\.ts android /;
const UPLOAD = /uses: actions\/upload-artifact@/;

describe("fork server release workflow", () => {
  it("runs only on a dispatch, never on a pushed tag", () => {
    const triggers = topLevelBlock("on")
      .map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1])
      .filter((trigger): trigger is string => trigger !== undefined);
    expect(triggers).toEqual(["workflow_dispatch"]);
    expect(workflow).not.toMatch(/^\s*tags:/m);
  });

  it("reads only contents at the workflow level", () => {
    const permissions = topLevelBlock("permissions").filter((line) => line.trim().length > 0);
    expect(permissions).toEqual(["  contents: read"]);
  });

  it("guards, builds, and publishes in separate jobs", () => {
    const names = [...jobs().keys()];
    expect(names).toEqual(expect.arrayContaining(["guard", "build-linux", "build-mac", "publish"]));
    expect(buildJobs().length).toBeGreaterThan(0);
  });

  it("runs the guard before every build, and checks out the guarded commit", () => {
    expect(needsOf(job("guard"))).toEqual([]);
    expect(job("guard").join("\n")).toMatch(/node scripts\/fork-release-guard\.ts/);
    for (const name of buildJobs()) {
      const body = job(name);
      expect(needsOf(body), name).toContain("guard");
      expect(body.join("\n"), name).toMatch(/ref: \$\{\{ needs\.guard\.outputs\.sha \}\}/);
    }
  });

  it("publishes only after the guard and every build", () => {
    const needs = needsOf(job("publish"));
    expect(needs).toContain("guard");
    for (const name of buildJobs()) expect(needs, name).toContain(name);
  });

  it("publishes only after the full test suite passed on the guarded commit", () => {
    const body = job("test-full").join("\n");
    expect(needsOf(job("test-full"))).toEqual(["guard"]);
    expect(body).toMatch(/uses: \.\/\.github\/workflows\/fork-full-suite\.yml/);
    expect(body).toMatch(/ref: \$\{\{ needs\.guard\.outputs\.sha \}\}/);
    expect(needsOf(job("publish"))).toContain("test-full");
  });

  it("publishes nothing unless the Mac desktop app built", () => {
    expect(needsOf(job("publish"))).toEqual(
      expect.arrayContaining(["guard", "build-linux", "admission", "build-mac"]),
    );
  });

  it("builds the Mac arm64 DMG from the guarded commit on a GitHub-hosted macOS runner", () => {
    const body = job("build-mac");
    const text = body.join("\n");
    expect(runsOn(body)).toMatch(/^macos-\d+$/);
    expect(needsOf(body)).toContain("guard");
    expect(text).toMatch(/ref: \$\{\{ needs\.guard\.outputs\.sha \}\}/);

    const rust = stepsOf(body).find((step) => /uses: dtolnay\/rust-toolchain@/.test(step));
    expect(rust).toBeDefined();
    const pinned = /uses: (dtolnay\/rust-toolchain@[0-9a-f]{40})\b/.exec(rust!)?.[1];
    expect(pinned).toBeDefined();
    expect(job("build-linux").join("\n")).toContain(pinned!);
    expect(rust).toMatch(/toolchain: stable/);
    expect(rust).toMatch(/targets: aarch64-apple-darwin/);

    const env = jobMap(body, "env");
    for (const name of [
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      "T3CODE_CLERK_JWT_TEMPLATE",
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      "T3CODE_RELAY_URL",
    ]) {
      expect(env.get(name), name).toBe(`\${{ vars.${name} }}`);
      expect(jobMap(job("build-linux"), "env").get(name), name).toBe(env.get(name));
    }
    expect(env.get("T3CODE_DESKTOP_VERSION")).toBe("${{ needs.guard.outputs.version }}");

    const build = stepsOf(body).findIndex((step) =>
      /run: vp run dist:desktop:dmg:arm64$/m.test(step),
    );
    expect(build).toBeGreaterThan(stepsOf(body).indexOf(rust!));
  });

  it("builds the Linux web client with the fork release source", () => {
    expect(job("build-linux").join("\n")).toMatch(/run: vp run --filter t3 build$/m);
  });

  it("signs and notarizes the Mac app with the owner's Developer ID, only from atli", () => {
    const body = job("build-mac");
    expect(ifOf(body)).toBe(
      "github.repository_id == '1406026313' && github.ref == 'refs/heads/atli'",
    );
    expect(body.join("\n")).toMatch(/^ {4}environment: personal-macos-signing$/m);
    const env = jobMap(body, "env");
    expect(env.get("T3CODE_DESKTOP_SIGNED")).toBe('"true"');
    expect(env.get("T3CODE_DESKTOP_UPDATE_REPOSITORY")).toBe("atlitech/skald-code");
    for (const [name, value] of env) expect(value, name).not.toMatch(/secrets\./);

    const steps = stepsOf(body);
    const write = stepIndex(
      steps,
      /T3CODE_MACOS_PROVISIONING_PROFILE=\$RUNNER_TEMP\/skald-code\.provisionprofile" >> "\$GITHUB_ENV"/,
    );
    const build = stepIndex(steps, /vp run dist:desktop:dmg:arm64$/m);
    expect(write).toBeLessThan(build);
    expect(steps[write]).toMatch(/APPLE_API_KEY=\$RUNNER_TEMP\/AuthKey\.p8" >> "\$GITHUB_ENV"/);
    // The certificate and its password reach only the build.
    for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD"]) {
      const holders = steps.flatMap((step, index) => (step.includes(`${name}:`) ? [index] : []));
      expect(holders, name).toEqual([build]);
    }
  });

  it("checks the Mac app's identity, then attests and uploads the DMG", () => {
    const steps = stepsOf(job("build-mac"));
    const dmg = "release/T3-Code-${{ needs.guard.outputs.version }}-arm64.dmg";
    const build = steps.findIndex((step) => /run: vp run dist:desktop:dmg:arm64$/m.test(step));
    const identity = steps.findIndex((step) => /node scripts\/fork-mac-identity\.ts/.test(step));
    const attest = steps.findIndex((step) => ATTEST.test(step));
    const upload = steps.findIndex((step) => /uses: actions\/upload-artifact@/.test(step));
    expect(build).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(build);
    expect(attest).toBeGreaterThan(identity);
    expect(upload).toBeGreaterThan(attest);

    const check = steps[identity]!;
    expect(check).toMatch(
      /hdiutil attach "release\/T3-Code-\$VERSION-arm64\.dmg" -nobrowse -readonly/,
    );
    expect(check).toMatch(/plutil -convert xml1 -o - /);
    expect(check).toMatch(/codesign -dv --verbose=2 [^\n]*2>&1 \|\| true/);
    expect(check).toMatch(/--release-version "\$VERSION"/);
    expect(check).toMatch(/hdiutil detach/);
    // Both distributables must carry the fork feed and the same signed identity.
    expect(check).toMatch(/Contents\/Resources\/app-update\.yml/);

    expect(steps[attest]).toContain(dmg);
    expect(check).toContain("--app-update-yml");
    expect(check).toContain("codesign --verify --deep --strict");
    expect(check).toContain('ditto -x -k "release/T3-Code-$VERSION-arm64.zip"');
    expect(steps[upload]).toMatch(/name: release-darwin-arm64\n/);
    expect(steps[upload]).toContain(dmg);
    for (const step of [steps[attest], steps[upload]]) {
      expect(step).toContain("release/atli-mac.yml");
      expect(step).toContain("release/T3-Code-${{ needs.guard.outputs.version }}-arm64.zip");
      expect(step).toContain("release/T3-Code-${{ needs.guard.outputs.version }}-arm64.*.blockmap");
    }
    expect(steps[upload]).toMatch(/if-no-files-found: error/);
  });

  it("never uploads to an existing release or replaces an asset", () => {
    expect(workflow).not.toMatch(/--clobber/);
    expect(workflow).not.toMatch(/gh\s+release\s+upload/);
    expect(workflow.match(/gh release edit [^\n]+/g)).toEqual([
      'gh release edit "$TAG" --draft=false',
    ]);
    const publish = stepsOf(job("publish")).find((step) => step.includes("gh release create"))!;
    expect(publish).toContain("--draft --prerelease");
    expect(publish.indexOf("gh release edit")).toBeGreaterThan(publish.indexOf("--notes-file"));
    const creates = workflow.match(/gh release create /g) ?? [];
    expect(creates).toHaveLength(1);
    expect(job("publish").join("\n")).toMatch(
      /gh release create "\$TAG" release\/\* \\\n\s+--target "\$SHA"/,
    );
  });

  it("attests GitHub-built artifacts and the manifest under job-level OIDC permissions", () => {
    const githubBuilds = buildJobs().filter((name) => name !== "build-android");
    for (const name of [...githubBuilds, "publish"]) {
      const body = job(name);
      const permissions = jobMap(body, "permissions");
      expect(permissions.get("id-token"), name).toBe("write");
      expect(permissions.get("attestations"), name).toBe("write");
      expect(body.join("\n"), name).toMatch(ATTEST);
    }
    for (const name of githubBuilds) {
      const steps = stepsOf(job(name));
      const attest = steps.findIndex((step) => ATTEST.test(step));
      const upload = steps.findIndex((step) => /uses: actions\/upload-artifact@/.test(step));
      expect(upload, name).toBeGreaterThan(-1);
      const subject = /subject-path: (.+)/.exec(steps[attest]!)?.[1];
      expect(steps[upload], name).toContain(`path: ${subject}`);
    }
  });

  it("attests SHA256SUMS and manifest.json before creating the release", () => {
    const steps = stepsOf(job("publish"));
    const attest = steps.findIndex(
      (step) =>
        ATTEST.test(step) &&
        step.includes("release/SHA256SUMS") &&
        step.includes("release/manifest.json"),
    );
    const create = steps.findIndex((step) => /gh release create /.test(step));
    expect(attest).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(attest);
    const manifest = steps.findIndex((step) =>
      /node scripts\/fork-release-manifest\.ts/.test(step),
    );
    expect(manifest).toBeGreaterThan(-1);
    expect(manifest).toBeLessThan(attest);
  });

  it("admits the built Linux archive before publish", () => {
    const admission = job("admission");
    expect(needsOf(admission)).toEqual(expect.arrayContaining(["guard", "build-linux"]));
    expect(needsOf(job("publish"))).toContain("admission");
    const text = admission.join("\n");
    expect(text).toMatch(/ref: \$\{\{ needs\.guard\.outputs\.sha \}\}/);
    expect(text).toMatch(
      /uses: actions\/download-artifact@[^\n]*\n\s+with:\n\s+name: release-linux-x64\n/,
    );
    expect(text).toMatch(/bash scripts\/linux-admission\/run-admission\.sh/);
  });

  it("checks the admitted archive against the digest its build reported", () => {
    expect(jobMap(job("build-linux"), "outputs").get("archive-sha256")).toBe(
      "${{ steps.digest.outputs.sha256 }}",
    );
    const digest = stepsOf(job("build-linux")).find((step) => /id: digest/.test(step));
    expect(digest).toMatch(/sha256sum "release-cli\/t3-\$VERSION-linux-x64\.tar\.gz"/);
    expect(job("admission").join("\n")).toMatch(
      /EXPECTED_SHA256: \$\{\{ needs\.build-linux\.outputs\.archive-sha256 \}\}/,
    );
  });

  it("gives the admission job no write permission", () => {
    expect([...jobMap(job("admission"), "permissions")]).toEqual([["contents", "read"]]);
  });

  it("takes the first admission's prior release only from the dispatch input, through env", () => {
    expect(workflow).toMatch(
      /^ {6}admission-bootstrap-prior:\n(?: {8}.*\n)*? {8}required: false\n/m,
    );
    const prior = stepsOf(job("admission")).find((step) =>
      /node scripts\/linux-admission\/prior-release\.ts/.test(step),
    );
    expect(prior).toMatch(/BOOTSTRAP: \$\{\{ inputs\.admission-bootstrap-prior \}\}/);
    expect(prior).toMatch(/--bootstrap "\$BOOTSTRAP"/);
  });

  it("ships ADMISSION.json from the admission artifact, downloaded before the manifest", () => {
    const upload = stepsOf(job("admission")).find((step) =>
      /uses: actions\/upload-artifact@/.test(step),
    );
    expect(upload).toMatch(/name: admission\n/);
    expect(upload).toMatch(/path: .+\/ADMISSION\.json\n/);
    expect(upload).toMatch(/if-no-files-found: error/);

    const steps = stepsOf(job("publish"));
    const manifest = steps.findIndex((step) =>
      /node scripts\/fork-release-manifest\.ts/.test(step),
    );
    const download = steps.findIndex(
      (step) =>
        /uses: actions\/download-artifact@/.test(step) &&
        /name: admission\n/.test(`${step}\n`) &&
        /path: release\b/.test(step),
    );
    expect(download).toBeGreaterThan(-1);
    expect(manifest).toBeGreaterThan(download);
    // The manifest step checks the Linux archive against it and leaves it out
    // of SHA256SUMS and the assets.
    expect(steps[manifest]).toMatch(
      /node scripts\/fork-release-manifest\.ts --dir release --commit "\$SHA" --release-version "\$VERSION" --admission release\/ADMISSION\.json --mobile-intent "\$RUNNER_TEMP\/mobile-intent\.json"\n/,
    );
  });

  it("checks the verification scope after the manifest and before attesting it", () => {
    const steps = stepsOf(job("publish"));
    const manifest = stepIndex(steps, /node scripts\/fork-release-manifest\.ts/);
    const scope = stepIndex(
      steps,
      /run: node scripts\/fork-release-scope\.ts --manifest release\/manifest\.json --admission release\/ADMISSION\.json$/m,
    );
    const attest = stepIndex(steps, ATTEST);
    expect(scope).toBeGreaterThan(manifest);
    expect(attest).toBeGreaterThan(scope);
  });

  it("creates the release with notes generated from the manifest, written outside release/", () => {
    const steps = stepsOf(job("publish"));
    const attest = stepIndex(steps, ATTEST);
    const notes = stepIndex(steps, /node scripts\/fork-release-notes\.ts/);
    const create = stepIndex(steps, /gh release create /);
    expect(notes).toBeGreaterThan(attest);
    expect(create).toBeGreaterThan(notes);
    const out =
      /node scripts\/fork-release-notes\.ts --manifest release\/manifest\.json --out "([^"]+)"/.exec(
        steps[notes]!,
      )?.[1];
    expect(out).toBe("$RUNNER_TEMP/release-notes.md");
    expect(out).not.toMatch(/^release\//);
    expect(steps[create]).toContain(`--notes-file "${out}"`);
    expect(steps[create]).not.toMatch(/--notes /);
  });

  it("runs every check the verification scope claims, as a step of the named job", () => {
    const stepNames = (name: string) =>
      stepsOf(job(name)).map((step) => /^ {6}- name: (.+)$/m.exec(step)?.[1]);
    for (const platform of FORK_VERIFICATION_SCOPE) {
      expect(platform.checks.length, platform.platform).toBeGreaterThan(0);
      for (const check of platform.checks) {
        expect(stepNames(check.job), `${platform.platform}: ${check.job}`).toContain(check.step);
      }
    }
  });

  it("attests ADMISSION.json before creating the release with it", () => {
    const steps = stepsOf(job("publish"));
    const download = steps.findIndex((step) => /name: admission\n/.test(`${step}\n`));
    const attest = steps.findIndex(
      (step) => ATTEST.test(step) && step.includes("release/ADMISSION.json"),
    );
    const create = steps.findIndex((step) => /gh release create "\$TAG" release\/\* \\/.test(step));
    expect(download).toBeGreaterThan(-1);
    expect(attest).toBeGreaterThan(download);
    expect(create).toBeGreaterThan(attest);
  });

  it("admits the Android build or original baseline only from protected atli source", () => {
    const body = job("build-android");
    expect(needsOf(body)).toEqual(["guard", "mobile-plan"]);
    expect(ifOf(body)).toContain("github.ref == 'refs/heads/atli'");
    expect(ifOf(body)).toContain("github.repository_id == '1406026313'");
    expect(body).toContain("    environment: personal-android-signing");
    expect(needsOf(job("publish"))).toContain("build-android");
    expect(job("guard").join("\n")).toContain('if [ "$SKALD_EAS_READY" != true ]; then');
    for (const name of ["mobile-plan", "build-android"]) {
      const text = job(name).join("\n");
      expect(text).toContain("ref: ${{ needs.guard.outputs.sha }}");
      expect(text).toContain("fetch-depth: 0");
      expect(text).not.toMatch(/sparse-checkout|filter: blob:none/);
      expect(text).not.toMatch(/gradlew|expo prebuild|xcodebuild/);
      const env = jobMap(job(name), "env");
      expect(env.get("APP_VARIANT")).toBe("personal");
      expect(env.get("T3CODE_MOBILE_CHANNEL")).toBe("personal-production");
      expect(env.has("T3CODE_RELEASE_VERSION")).toBe(false);
      for (const [key, value] of env) expect(value, key).not.toMatch(/secrets\./);
    }
  });

  it("checks remote public config and APK identity before uploading only a newly built APK", () => {
    const steps = stepsOf(job("build-android"));
    const config = stepIndex(steps, CONFIG_CHECK);
    const identity = stepIndex(steps, ANDROID_DELIVERY);
    const upload = stepIndex(steps, UPLOAD);
    expect(identity).toBeGreaterThan(config);
    expect(upload).toBeGreaterThan(identity);
    expect(steps[config]).toContain("eas env:exec production");
    expect(steps[identity]).toContain(
      '--sha "$SHA" --tag "$TAG" --intent "$RUNNER_TEMP/mobile-intent.json"',
    );
    expect(steps[upload]).toContain("if: needs.mobile-plan.outputs.android-mode == 'native'");
    expect(steps[upload]).toContain("name: release-android-arm64-v8a");
    expect(steps[upload]).toContain("if-no-files-found: error");
    expect(job("build-android").join("\n")).not.toMatch(ATTEST);
    const publish = stepsOf(job("publish"));
    const intent = stepIndex(publish, /name: mobile-intent-verified/);
    expect(publish[intent]).toContain("path: ${{ runner.temp }}");
    expect(intent).toBeLessThan(stepIndex(publish, /node scripts\/fork-release-manifest\.ts/));
  });
});

describe("fork mobile delivery and retry", () => {
  it("starts iOS and OTA delivery only after immutable release publication", () => {
    const body = job("mobile-delivery");
    expect(needsOf(body)).toEqual(["guard", "publish"]);
    expect(body.join("\n")).toContain("uses: ./.github/workflows/fork-mobile-delivery.yml");
    expect(body.join("\n")).toContain("tag: ${{ needs.guard.outputs.tag }}");
    expect(needsOf(job("publish"))).not.toContain("mobile-delivery");
    expect(job("resolve", mobileDelivery).join("\n")).toContain(
      'node scripts/fork-mobile-release.ts resolve --tag "$TAG"',
    );
    for (const name of ["deliver", "testflight"]) {
      const body = job(name, mobileDelivery);
      const text = body.join("\n");
      expect(needsOf(body)).toContain("resolve");
      expect(text).toContain("ref: ${{ needs.resolve.outputs.sha }}");
      expect(text).toContain("fetch-depth: 0");
      expect(text).not.toMatch(/sparse-checkout|filter: blob:none/);
      expect(text).not.toMatch(
        /uses: actions\/(?:upload-artifact|attest-build-provenance)@|--latest|xcodebuild/,
      );
    }
    expect(needsOf(job("testflight", mobileDelivery))).toContain("deliver");
    expect(job("testflight", mobileDelivery).join("\n")).toContain(
      'node scripts/fork-mobile-release.ts ios-verify --tag "$TAG"',
    );
    expect(runsOn(job("testflight", mobileDelivery))).toMatch(/^macos-\d+$/);
  });

  it("retries only a named published tag through the same guarded delivery workflow", () => {
    expect(topLevelBlock("on", mobileRetry).filter((line) => /^ {2}\S/.test(line))).toEqual([
      "  workflow_dispatch:",
    ]);
    expect(mobileRetry).toMatch(/^ {6}tag:\n(?: {8}.*\n)*? {8}required: true/m);
    const body = job("retry", mobileRetry);
    expect(ifOf(body)).toContain("github.repository_id == '1406026313'");
    expect(ifOf(body)).toContain("github.ref == 'refs/heads/atli'");
    expect(body.join("\n")).toContain("uses: ./.github/workflows/fork-mobile-delivery.yml");
    expect(body.join("\n")).toContain("tag: ${{ inputs.tag }}");
    expect(mobileRetry).not.toMatch(
      /eas update|actions\/checkout|ref: atli|inputs\.(?:ref|sha|runtime)/,
    );
  });

  it("holds one non-cancelling production lock across release and retry without nested acquisition", () => {
    for (const text of [workflow, mobileRetry]) {
      expect(topLevelBlock("concurrency", text).filter((line) => line.trim())).toEqual([
        "  group: skald-production-publication",
        "  cancel-in-progress: false",
      ]);
    }
    expect(mobileDelivery).not.toMatch(/^\s*concurrency:/m);
    expect(topLevelBlock("on", mobileDelivery).filter((line) => /^ {2}\S/.test(line))).toEqual([
      "  workflow_call:",
    ]);
  });
});
