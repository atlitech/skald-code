#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - Standalone release CLI coordinates external GitHub, EAS and Apple APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeReleaseManifestJson } from "./fork-release-manifest.ts";
import {
  chooseMobileDelivery,
  GitHubNativeBuild,
  PlatformDelivery,
  MobileReleaseIntent,
  NativeBaseline,
  validateMobileIntent,
} from "./lib/fork-mobile-release-model.ts";
import {
  assertNotSuperseded,
  assertUpdate,
  easJsonArgs,
  parseEasJson,
  EASUpdate,
  selectUpdate,
  EAS_PROJECT_ID,
  MOBILE_CHANNEL,
  MOBILE_PROFILE,
  MOBILE_REPO,
} from "./lib/fork-mobile-eas.ts";

import {
  ActionsArtifact,
  LocalBuildMetadata,
  assertLocalBuild,
  assertRetainedNative,
  selectNativeArtifact,
  shouldUploadToApple,
} from "./lib/fork-mobile-local.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const mobile = NodePath.join(root, "apps/mobile");
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const Platform = Schema.Literals(["android", "ios"]);
type Platform = typeof Platform.Type;
const DeliveryRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  tag: Schema.String,
  sha: Schema.String,
  platform: Platform,
  phase: Schema.Literals([
    "planned",
    "requesting",
    "building",
    "verified",
    "submitting",
    "submitted",
    "distributed",
    "updating",
  ]),
  publishedAt: Schema.optionalKey(Schema.String),
  intent: Schema.optionalKey(MobileReleaseIntent),
  platformIntent: Schema.optionalKey(PlatformDelivery),
  nativeRun: Schema.optionalKey(GitHubNativeBuild),
  buildId: Schema.optionalKey(Schema.String),
  baseline: Schema.optionalKey(NativeBaseline),
  updateGroupId: Schema.optionalKey(Schema.String),
  updateId: Schema.optionalKey(Schema.String),
  submissionId: Schema.optionalKey(Schema.String),
  appleBuildId: Schema.optionalKey(Schema.String),
});
type DeliveryRecord = typeof DeliveryRecord.Type;
const Deployment = Schema.Struct({ id: Schema.Number, payload: DeliveryRecord });
type Deployment = typeof Deployment.Type;
const activeDeployments = new Map<Platform, number>();

async function run(command: string, args: readonly string[], cwd = root, input?: string) {
  // Arguments are passed directly; release labels and API payloads never become shell source.
  if (input !== undefined) {
    return await new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(command, [...args], {
        cwd,
        env: NodeProcess.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => {
        stdout += text;
      });
      child.stderr.on("data", (chunk: Buffer) => NodeProcess.stderr.write(chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (${code}).`)),
      );
      child.stdin.end(input);
    });
  }
  const result = await execFile(command, [...args], {
    cwd,
    env: NodeProcess.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stderr) NodeProcess.stderr.write(result.stderr);
  return result.stdout;
}
const json = (text: string): unknown => JSON.parse(text);
async function gh(path: string, body?: unknown): Promise<unknown> {
  return json(
    await run(
      "gh",
      ["api", path, ...(body === undefined ? [] : ["--method", "POST", "--input", "-"])],
      root,
      body === undefined ? undefined : JSON.stringify(body),
    ),
  );
}
async function eas(args: readonly string[]): Promise<unknown> {
  return parseEasJson(await run("eas", easJsonArgs(args), mobile));
}
function required(name: string) {
  const value = NodeProcess.env[name];
  if (!value)
    throw new Error(`Missing ${name}; complete the EAS migration setup before publication.`);
  return value;
}
const repoPath = `repos/${MOBILE_REPO}`;
async function records(platform: Platform): Promise<readonly Deployment[]> {
  const pages = decodeDeploymentPages(
    json(
      await run("gh", [
        "api",
        `${repoPath}/deployments?environment=skald-mobile-${platform}&per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    ),
  );
  return pages.flat();
}
async function record(payload: DeliveryRecord, state: "in_progress" | "success" = "in_progress") {
  const deployment = decodeDeploymentId(
    await gh(`${repoPath}/deployments`, {
      ref: payload.sha,
      environment: `skald-mobile-${payload.platform}`,
      auto_merge: false,
      required_contexts: [],
      transient_environment: false,
      production_environment: true,
      payload,
      description: `${payload.tag}: ${payload.phase}`,
    }),
  );
  const previous = activeDeployments.get(payload.platform);
  activeDeployments.set(payload.platform, deployment.id);
  await gh(`${repoPath}/deployments/${deployment.id}/statuses`, {
    state,
    auto_inactive: false,
    log_url: `https://github.com/${MOBILE_REPO}/actions/runs/${required("GITHUB_RUN_ID")}`,
    description: `${payload.tag}: ${payload.phase}`,
  });
  if (previous && previous !== deployment.id) {
    await gh(`${repoPath}/deployments/${previous}/statuses`, {
      state: "inactive",
      auto_inactive: false,
      description: "Phase completed; delivery advanced to its next record.",
    });
  }
  if (state === "success") activeDeployments.delete(payload.platform);
  return deployment.id;
}
async function write(file: string, value: unknown) {
  await NodeFSP.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function readIntent(file: string) {
  return decodeIntent(json(await NodeFSP.readFile(file, "utf8")));
}

async function apple(path: string): Promise<unknown> {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64({ alg: "ES256", kid: required("ASC_KEY_ID"), typ: "JWT" });
  const claims = b64({
    iss: required("ASC_ISSUER_ID"),
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  });
  const data = `${header}.${claims}`;
  const key = NodeCrypto.createPrivateKey(Buffer.from(required("ASC_KEY_BASE64"), "base64"));
  const signature = NodeCrypto.sign("sha256", Buffer.from(data), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1/${path}`, {
    headers: { authorization: `Bearer ${data}.${signature}` },
  });
  if (!response.ok) throw new Error(`App Store Connect lookup failed (${response.status}).`);
  return await response.json();
}
function ascAppId() {
  const id = required("SKALD_ASC_APP_ID");
  if (!/^\d+$/.test(id) || id === "6787819824")
    throw new Error("Configure the fork's numeric App Store Connect app ID.");
  return id;
}
async function appleIdentity() {
  const app = decodeAppleApp(await apple(`apps/${ascAppId()}`));
  if (app.data.attributes.bundleId !== "tech.atli.skaldcode")
    throw new Error("App Store Connect app is not Skald Code.");
}
const AppleBuilds = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      attributes: Schema.Struct({
        version: Schema.String,
        expirationDate: Schema.NullOr(Schema.String),
        expired: Schema.Boolean,
        processingState: Schema.String,
      }),
      relationships: Schema.Struct({
        preReleaseVersion: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
      }),
    }),
  ),
  included: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        type: Schema.String,
        attributes: Schema.Struct({ version: Schema.optionalKey(Schema.String) }),
      }),
    ),
  ),
});
const decodeDeploymentPages = Schema.decodeUnknownSync(Schema.Array(Schema.Array(Deployment)));
const decodeDeploymentId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Number }));
const decodeIntent = Schema.decodeUnknownSync(MobileReleaseIntent);
const decodeAppleApp = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({ attributes: Schema.Struct({ bundleId: Schema.String }) }),
  }),
);
const decodeAppleBuilds = Schema.decodeUnknownSync(AppleBuilds);
const decodeBetaDetail = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      attributes: Schema.Struct({
        internalBuildState: Schema.String,
        externalBuildState: Schema.String,
      }),
    }),
  }),
);
const decodeAppleIds = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);
const decodeFingerprint = Schema.decodeUnknownSync(
  Schema.Struct({
    hash: Schema.String,
    sources: Schema.Array(
      Schema.Struct({ reasons: Schema.optionalKey(Schema.Array(Schema.String)) }),
    ),
  }),
);
const decodeExpoConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.String,
    slug: Schema.String,
    owner: Schema.String,
    extra: Schema.Struct({ eas: Schema.Struct({ projectId: Schema.String }) }),
  }),
);
const decodeRelease = Schema.decodeUnknownSync(
  Schema.Struct({
    draft: Schema.Boolean,
    tag_name: Schema.String,
    published_at: Schema.NullOr(Schema.String),
  }),
);
const decodeGitRef = Schema.decodeUnknownSync(
  Schema.Struct({ object: Schema.Struct({ type: Schema.String, sha: Schema.String }) }),
);
const decodeChannel = Schema.decodeUnknownSync(
  Schema.Struct({
    currentPage: Schema.Struct({
      isPaused: Schema.Boolean,
      branchMapping: Schema.String,
      updateBranches: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    }),
  }),
);
const decodeBranchMapping = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({ branchId: Schema.String, branchMappingLogic: Schema.String }),
    ),
  }),
);
const decodeUpdatePage = Schema.decodeUnknownSync(
  Schema.Struct({ currentPage: Schema.Array(Schema.Struct({ group: Schema.String })) }),
);
const decodeUpdates = Schema.decodeUnknownSync(Schema.Array(EASUpdate));
const decodePersonalProfile = Schema.decodeUnknownSync(
  Schema.Struct({
    build: Schema.Struct({
      personal: Schema.Struct({
        env: Schema.Record(Schema.String, Schema.String),
        environment: Schema.Literal("production"),
        channel: Schema.Literal(MOBILE_CHANNEL),
      }),
    }),
  }),
);
const decodePlatform = Schema.decodeUnknownSync(Platform);

async function appleAvailability(baseline: NativeBaseline) {
  const query = new URLSearchParams({
    "filter[app]": ascAppId(),
    "filter[version]": baseline.appBuildVersion,
    include: "preReleaseVersion",
    limit: "200",
  });
  const result = decodeAppleBuilds(await apple(`builds?${query}`));
  const builds = result.data.filter((build) =>
    result.included?.some(
      (item) =>
        item.type === "preReleaseVersions" &&
        item.id === build.relationships.preReleaseVersion.data.id &&
        item.attributes.version === baseline.appVersion,
    ),
  );
  if (builds.length > 1) throw new Error("Ambiguous App Store Connect native build.");
  const build = builds[0];
  if (!build) return undefined;
  const expiresAt = build.attributes.expirationDate ?? "";
  if (build.attributes.expired || build.attributes.processingState !== "VALID")
    return { id: build.id, expiresAt, available: false };
  if (!Number.isFinite(Date.parse(expiresAt))) return { id: build.id, expiresAt, available: false };
  const detail = decodeBetaDetail(await apple(`builds/${build.id}/buildBetaDetail`));
  const state = detail.data.attributes;
  if (
    state.internalBuildState !== "IN_BETA_TESTING" &&
    state.externalBuildState !== "IN_BETA_TESTING"
  )
    return { id: build.id, expiresAt, available: false };
  const groups = decodeAppleIds(await apple(`builds/${build.id}/betaGroups?limit=200`));
  for (const group of groups.data) {
    const testers = decodeAppleIds(await apple(`betaGroups/${group.id}/betaTesters?limit=1`));
    if (testers.data.length) return { id: build.id, expiresAt, available: true };
  }
  return { id: build.id, expiresAt, available: false };
}

async function fingerprint(platform: Platform, profile = true) {
  const result = decodeFingerprint(
    await eas([
      "fingerprint:generate",
      "--platform",
      platform,
      ...(profile ? ["--build-profile", MOBILE_PROFILE] : ["--environment", "production"]),
    ]),
  );
  const reason = platform === "ios" ? "expoAutolinkingIos" : "expoAutolinkingAndroid";
  if (!result.hash || !result.sources.some((source) => source.reasons?.includes(reason)))
    throw new Error(`Incomplete ${platform} native fingerprint.`);
  return result.hash;
}
async function checkConfig() {
  const configText = await run(
    "eas",
    ["env:exec", "production", "vp exec expo config --type public --json", "--non-interactive"],
    mobile,
  );
  const config = decodeExpoConfig(json(configText));
  if (
    config.slug !== "skald-code" ||
    config.owner !== "atlitech" ||
    config.extra.eas.projectId !== EAS_PROJECT_ID
  )
    throw new Error("Resolved Expo project differs from the fork.");
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-config-"));
  try {
    const file = NodePath.join(temp, "config.json");
    await NodeFSP.writeFile(file, configText);
    await run("node", ["scripts/fork-android-config.ts", "--config", file]);
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
  return config;
}
async function prepare(platform: Platform, sha: string, tag: string, out: string, force: string) {
  if (platform === "ios") await appleIdentity();
  const history = await records(platform);
  const old = history.find((item) => item.payload.tag === tag && item.payload.platformIntent);
  if (old) {
    if (old.payload.sha !== sha) throw new Error("Release planning SHA changed.");
    await write(out, old.payload.platformIntent);
    return;
  }
  const config = await checkConfig();
  let baseline = history.find((item) => item.payload.phase === "distributed")?.payload.baseline;
  if (baseline && platform === "ios") {
    const availability = await appleAvailability(baseline);
    baseline = availability?.available
      ? { ...baseline, expiresAt: availability.expiresAt }
      : undefined;
  }
  const platformIntent = chooseMobileDelivery({
    platform,
    runtimeVersion: await fingerprint(platform),
    appVersion: config.version,
    ...(baseline ? { baseline } : {}),
    forceNative: force === "all" || force === platform,
    now: Date.now(),
  });
  await record({ schemaVersion: 1, tag, sha, platform, phase: "planned", platformIntent });
  await write(out, platformIntent);
}

const decodeArtifactPages = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ artifacts: Schema.Array(ActionsArtifact) })),
);
const decodeBaseline = Schema.decodeUnknownSync(NativeBaseline);
const decodeLocalMetadata = Schema.decodeUnknownSync(LocalBuildMetadata);
async function output(name: string, value: string) {
  await NodeFSP.appendFile(required("GITHUB_OUTPUT"), `${name}=${value}\n`);
}
async function nativeArtifact(reference: GitHubNativeBuild, allowExpired = false) {
  const pages = decodeArtifactPages(
    json(
      await run("gh", [
        "api",
        `${repoPath}/actions/runs/${reference.runId}/artifacts?per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    ),
  );
  return selectNativeArtifact(
    pages.flatMap((page) => page.artifacts),
    reference,
    allowExpired,
  );
}
async function recoverNative(
  reference: GitHubNativeBuild,
  platform: Platform,
  sha: string,
  tag: string,
  intent: MobileReleaseIntent,
  dir: string,
  allowExpired = false,
) {
  const artifact = await nativeArtifact(reference, allowExpired);
  if (!artifact) return undefined;
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-native-"));
  try {
    const archive = NodePath.join(temp, "artifact.zip");
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        "gh",
        ["api", `${repoPath}/actions/artifacts/${artifact.id}/zip`],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("Native artifact download failed."));
          return;
        }
        NodeFSP.writeFile(archive, Buffer.concat(chunks)).then(resolve, reject);
      });
    });
    const entries = (await run("unzip", ["-Z1", archive])).trim().split("\n");
    const name =
      platform === "android" ? `T3-Code-${tag.replace(/^v/, "")}-android-arm64-v8a.apk` : "app.ipa";
    if (entries.length !== 2 || !entries.includes("baseline.json") || !entries.includes(name)) {
      throw new Error("Native artifact must contain only its binary and baseline.json.");
    }
    await run("unzip", ["-q", archive, "-d", temp]);
    const baseline = decodeBaseline(
      json(await NodeFSP.readFile(NodePath.join(temp, "baseline.json"), "utf8")),
    );
    const binary = NodePath.join(temp, name);
    assertRetainedNative(baseline, {
      reference,
      platform,
      sourceSha: sha,
      tag,
      intent: intent[platform],
      file: name,
      ...(await digest(binary)),
    });
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.copyFile(binary, NodePath.join(dir, name));
    const recovered = { ...baseline, github: { ...reference, artifactId: String(artifact.id) } };
    await write(NodePath.join(dir, "baseline.json"), recovered);
    return recovered;
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}
async function localBuild(
  platform: Platform,
  sha: string,
  tag: string,
  intent: MobileReleaseIntent,
  dir: string,
  rebuild: boolean,
  publishedAt?: string,
) {
  const history = await records(platform);
  const previous = history.find(
    (item) => item.payload.tag === tag && item.payload.nativeRun,
  )?.payload;
  if (previous?.sha !== undefined && previous.sha !== sha)
    throw new Error("Native build source changed.");
  if (previous?.nativeRun) {
    const recovered = await recoverNative(
      previous.nativeRun,
      platform,
      sha,
      tag,
      intent,
      dir,
      rebuild,
    );
    if (recovered) {
      await output("native", "true");
      await output("upload-native", "false");
      return recovered;
    }
    if (!rebuild)
      throw new Error(
        "Previous native build has no retained artifact. Explicitly request rebuild-native to reserve a higher number; never reuse a lost build number.",
      );
  }
  if ((await fingerprint(platform)) !== intent[platform].runtimeVersion)
    throw new Error("Native planning/build fingerprints disagree.");
  await NodeFSP.mkdir(dir, { recursive: true });
  const nativeRun: GitHubNativeBuild = {
    runId: required("GITHUB_RUN_ID"),
    runAttempt: required("GITHUB_RUN_ATTEMPT"),
    workflowSha: required("GITHUB_SHA"),
    artifactName: `mobile-native-${platform}-${tag}-${required("GITHUB_RUN_ATTEMPT")}`,
  };
  if (
    previous?.nativeRun?.runId === nativeRun.runId &&
    previous.nativeRun.runAttempt === nativeRun.runAttempt
  )
    throw new Error("Cannot repeat a native build in the same run attempt.");
  const buildId = `github:${nativeRun.runId}:${nativeRun.runAttempt}:${platform}`;
  await record({
    schemaVersion: 1,
    tag,
    sha,
    platform,
    phase: "building",
    buildId,
    nativeRun,
    ...(publishedAt ? { publishedAt } : {}),
  });
  const minimum = history
    .flatMap((item) =>
      item.payload.baseline ? [BigInt(item.payload.baseline.appBuildVersion)] : [],
    )
    .reduce((max, n) => (n > max ? n : max), 0n)
    .toString();
  const name =
    platform === "android" ? `T3-Code-${tag.replace(/^v/, "")}-android-arm64-v8a.apk` : "app.ipa";
  const binary = NodePath.resolve(dir, name);
  const metadataFile = NodePath.resolve(dir, "local-metadata.json");
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "eas",
      [
        "build",
        "--local",
        "--platform",
        platform,
        "--profile",
        MOBILE_PROFILE,
        "--output",
        binary,
        "--freeze-credentials",
        "--non-interactive",
      ],
      {
        cwd: mobile,
        stdio: "inherit",
        env: {
          ...NodeProcess.env,
          EAS_LOCAL_BUILD_PLUGIN_PATH: NodePath.join(root, "scripts/fork-mobile-local-worker.ts"),
          EAS_LOCAL_BUILD_WORKINGDIR: NodePath.join(
            required("RUNNER_TEMP"),
            `eas-${platform}-${nativeRun.runAttempt}`,
          ),
          SKALD_LOCAL_METADATA_FILE: metadataFile,
          SKALD_LOCAL_PLATFORM: platform,
          SKALD_LOCAL_SHA: sha,
          SKALD_LOCAL_RUNTIME: intent[platform].runtimeVersion,
          SKALD_LOCAL_APP_VERSION: intent[platform].appVersion,
          SKALD_LOCAL_MINIMUM_NUMBER: minimum,
        },
      },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `EAS local ${platform} build failed (${code}); its reserved number remains consumed.`,
            ),
          ),
    );
  });
  const metadata = decodeLocalMetadata(json(await NodeFSP.readFile(metadataFile, "utf8")));
  assertLocalBuild(metadata, {
    platform,
    sourceSha: sha,
    ...intent[platform],
    channel: MOBILE_CHANNEL,
    minimumBuildVersion: minimum,
  });
  return {
    buildId,
    github: nativeRun,
    sourceSha: sha,
    profile: MOBILE_PROFILE,
    releaseTag: tag,
    appBuildVersion: metadata.appBuildVersion,
    appVersion: metadata.appVersion,
    runtimeVersion: metadata.runtimeVersion,
    artifact: {
      file: name,
      url:
        platform === "android"
          ? `https://github.com/${MOBILE_REPO}/releases/download/${tag}/${name}`
          : `https://github.com/${MOBILE_REPO}/actions/runs/${nativeRun.runId}`,
      ...(await digest(binary)),
    },
  } satisfies NativeBaseline;
}

async function registerNative(
  platform: Platform,
  sha: string,
  tag: string,
  dir: string,
  intentFile?: string,
  publishedAt?: string,
) {
  const baseline = decodeBaseline(
    json(await NodeFSP.readFile(NodePath.join(dir, "baseline.json"), "utf8")),
  );
  if (!baseline.github || baseline.sourceSha !== sha || baseline.releaseTag !== tag)
    throw new Error("Invalid local build provenance.");
  const artifact = await nativeArtifact(baseline.github);
  if (!artifact) throw new Error("Verified native artifact has not been retained by GitHub.");
  const stored = { ...baseline, github: { ...baseline.github, artifactId: String(artifact.id) } };
  await record({
    schemaVersion: 1,
    tag,
    sha,
    platform,
    phase: "verified",
    buildId: baseline.buildId,
    nativeRun: stored.github,
    baseline: stored,
    ...(publishedAt ? { publishedAt } : {}),
  });
  await write(NodePath.join(dir, "baseline.json"), stored);
  if (intentFile) {
    const intent = await readIntent(intentFile);
    await write(intentFile, { ...intent, [platform]: { ...intent[platform], baseline: stored } });
  }
}

async function digest(file: string) {
  const bytes = await NodeFSP.readFile(file);
  return {
    size: bytes.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  };
}
function identityArgs(baseline: NativeBaseline) {
  return [
    "--release-version",
    baseline.releaseTag.replace(/^v/, ""),
    "--app-build-version",
    baseline.appBuildVersion,
    "--app-version",
    baseline.appVersion,
    "--runtime-version",
    baseline.runtimeVersion,
    "--channel",
    MOBILE_CHANNEL,
  ];
}
async function verifyAPK(file: string, baseline: NativeBaseline, temp: string) {
  const sdk = NodePath.join(required("ANDROID_HOME"), "build-tools", "36.0.0");
  for (const [name, args] of [
    ["badging", ["dump", "badging", file]],
    ["manifest", ["dump", "xmltree", file, "AndroidManifest.xml"]],
    ["resources", ["dump", "--values", "resources", file]],
  ] as const) {
    await NodeFSP.writeFile(
      NodePath.join(temp, `${name}.txt`),
      await run(NodePath.join(sdk, "aapt"), args),
    );
  }
  await NodeFSP.writeFile(
    NodePath.join(temp, "certs.txt"),
    await run(NodePath.join(sdk, "apksigner"), ["verify", "--print-certs", file]),
  );
  const entries = (await run("unzip", ["-Z1", file])).split("\n");
  if (
    !entries.some((entry) => /(?:index.android.bundle|app.manifest|assets\/.*\.hbc)$/.test(entry))
  )
    throw new Error("APK has no embedded JavaScript/update bundle.");
  const embeddedFingerprint = NodePath.join(temp, "fingerprint");
  await NodeFSP.writeFile(
    embeddedFingerprint,
    await run("unzip", ["-p", file, "assets/fingerprint"]),
  );
  await run("node", [
    "scripts/fork-android-identity.ts",
    ...identityArgs(baseline),
    "--embedded-fingerprint",
    embeddedFingerprint,
    ...["badging", "certs", "manifest", "resources"].flatMap((key) => [
      `--${key}`,
      NodePath.join(temp, `${key}.txt`),
    ]),
  ]);
}
async function verifyPublishedAPK(baseline: NativeBaseline, temp: string) {
  const artifact = baseline.artifact;
  if (!artifact) throw new Error("Android baseline has no APK.");
  await run("gh", [
    "release",
    "download",
    baseline.releaseTag,
    "--repo",
    MOBILE_REPO,
    "--pattern",
    artifact.file,
    "--dir",
    temp,
  ]);
  const actual = await digest(NodePath.join(temp, artifact.file));
  if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size)
    throw new Error("Published baseline APK checksum changed.");
}
async function android(sha: string, tag: string, file: string, dir: string, rebuild: boolean) {
  const intent = await readIntent(file);
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-apk-"));
  try {
    if (intent.android.mode === "ota") {
      await verifyPublishedAPK(intent.android.baseline!, temp);
      return;
    }
    const baseline = await localBuild("android", sha, tag, intent, dir, rebuild);
    await verifyAPK(NodePath.resolve(dir, baseline.artifact!.file), baseline, temp);
    await finishLocalArtifact(baseline, dir);
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}
async function finishLocalArtifact(baseline: NativeBaseline, dir: string) {
  await write(NodePath.join(dir, "baseline.json"), baseline);
  await output("native", "true");
  await output("upload-native", baseline.github?.artifactId ? "false" : "true");
  await output("artifact-name", baseline.github!.artifactName);
}

async function published(tag: string) {
  const release = decodeRelease(await gh(`${repoPath}/releases/tags/${tag}`));
  if (release.draft || !release.published_at || release.tag_name !== tag)
    throw new Error("Delivery requires an already published fork release.");
  let ref = decodeGitRef(await gh(`${repoPath}/git/ref/tags/${tag}`)).object;
  if (ref.type === "tag") ref = decodeGitRef(await gh(`${repoPath}/git/tags/${ref.sha}`)).object;
  if (ref.type !== "commit") throw new Error("Release tag does not resolve to a commit.");
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-release-"));
  try {
    await run("gh", [
      "release",
      "download",
      tag,
      "--repo",
      MOBILE_REPO,
      "--pattern",
      "manifest.json",
      "--dir",
      temp,
    ]);
    const manifest = await Effect.runPromise(
      decodeReleaseManifestJson(
        await NodeFSP.readFile(NodePath.join(temp, "manifest.json"), "utf8"),
      ),
    );
    if (
      manifest.commit !== ref.sha ||
      manifest.version !== tag.replace(/^v/, "") ||
      !manifest.mobile
    )
      throw new Error("Release manifest/tag mismatch or no EAS delivery intent.");
    const mismatch = validateMobileIntent(manifest.mobile, manifest);
    if (mismatch) throw new Error(mismatch);
    return { sha: manifest.commit, intent: manifest.mobile, publishedAt: release.published_at };
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}

async function publishOTA(
  platform: Platform,
  sha: string,
  tag: string,
  intent: MobileReleaseIntent,
  publishedAt: string,
) {
  if (
    (await fingerprint(platform)) !== intent[platform].runtimeVersion ||
    (await fingerprint(platform, false)) !== intent[platform].runtimeVersion
  )
    throw new Error("Release/build/update environment fingerprint changed; refusing OTA.");
  const mapping = decodeChannel(await eas(["channel:view", MOBILE_CHANNEL]));
  const branch = mapping.currentPage.updateBranches;
  const rules = decodeBranchMapping(json(mapping.currentPage.branchMapping));
  if (
    mapping.currentPage.isPaused ||
    branch.length !== 1 ||
    branch[0]?.name !== MOBILE_CHANNEL ||
    rules.data.length !== 1 ||
    rules.data[0]?.branchId !== branch[0]?.id ||
    rules.data[0]?.branchMappingLogic !== "true"
  )
    throw new Error("Production channel must point entirely at the personal-production branch.");
  const message = `skald:${tag}:${platform}:${sha}`;
  const history = await records(platform);
  const checkpoint = history.find((item) => item.payload.tag === tag && item.payload.updateGroupId);
  if (checkpoint) activeDeployments.set(platform, checkpoint.id);
  let group = checkpoint?.payload.updateGroupId;
  if (!group) {
    const candidates: EASUpdate[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = decodeUpdatePage(
        await eas([
          "update:list",
          "--branch",
          MOBILE_CHANNEL,
          "--platform",
          platform,
          "--runtime-version",
          intent[platform].runtimeVersion,
          "--limit",
          "50",
          "--offset",
          String(offset),
        ]),
      );
      // update:list formats and truncates messages; only update:view has the exact source metadata.
      for (const item of page.currentPage) {
        const updates = decodeUpdates(await eas(["update:view", item.group]));
        candidates.push(...updates.filter((update) => update.platform === platform));
      }
      if (page.currentPage.length < 50) break;
    }
    group = selectUpdate(
      candidates,
      message,
      history.some((item) => item.payload.tag === tag && item.payload.phase === "updating"),
    )?.group;
  }
  if (!group) {
    await record({
      schemaVersion: 1,
      tag,
      sha,
      platform,
      phase: "updating",
      publishedAt,
      baseline: intent[platform].baseline!,
    });
    // EAS writes runtime and source metadata; inspect those before recording delivery success.
    const updates = decodeUpdates(
      await eas([
        "update",
        "--channel",
        MOBILE_CHANNEL,
        "--environment",
        "production",
        "--platform",
        platform,
        "--message",
        message,
      ]),
    );
    if (updates.length !== 1) throw new Error("Expected one platform update.");
    group = updates[0]!.group;
    await record({
      schemaVersion: 1,
      tag,
      sha,
      platform,
      phase: "updating",
      publishedAt,
      baseline: intent[platform].baseline!,
      updateGroupId: group,
      updateId: updates[0]!.id,
    });
  }
  const updates = decodeUpdates(await eas(["update:view", group]));
  const update = updates.find((item) => item.platform === platform);
  if (!update) throw new Error("Published group is missing the requested platform.");
  assertUpdate(update, { sha, platform, runtimeVersion: intent[platform].runtimeVersion, message });
  await record(
    {
      schemaVersion: 1,
      tag,
      sha,
      platform,
      phase: "distributed",
      publishedAt,
      baseline: intent[platform].baseline!,
      updateGroupId: update.group,
      updateId: update.id,
    },
    "success",
  );
}
async function deliver(platform: Platform, tag: string, dir: string, rebuild: boolean) {
  const { sha, intent, publishedAt } = await published(tag);
  await assertCheckout(sha);
  const history = await records(platform);
  assertNotSuperseded(
    publishedAt,
    history.map((item) => item.payload),
  );
  if (history.some((item) => item.payload.tag === tag && item.payload.phase === "distributed"))
    return;
  if (intent[platform].mode === "ota") {
    if (platform === "ios") {
      await appleIdentity();
      const available = await appleAvailability(intent.ios.baseline!);
      if (!available?.available || Date.parse(available.expiresAt) <= Date.now())
        throw new Error(
          "Intended TestFlight baseline is no longer available; trigger a native refresh release.",
        );
    }
    await checkConfig();
    await publishOTA(platform, sha, tag, intent, publishedAt);
    return;
  }
  if (platform === "ios") {
    const verified = history.find(
      (item) => item.payload.tag === tag && item.payload.phase === "verified",
    )?.payload.baseline;
    if (verified) {
      await appleIdentity();
      const exists = await appleAvailability(verified);
      if (
        !shouldUploadToApple(
          history.map((item) => item.payload),
          verified.buildId,
          exists !== undefined,
        )
      )
        return;
    }
    const baseline = await localBuild(platform, sha, tag, intent, dir, rebuild, publishedAt);
    await verifyIPA(NodePath.join(dir, "app.ipa"), baseline);
    await finishLocalArtifact(baseline, dir);
    return;
  }
  const baseline = intent.android.baseline!;
  const verified = history.find(
    (item) => item.payload.tag === tag && item.payload.phase === "verified",
  )?.payload;
  if (
    verified?.sha !== sha ||
    verified.buildId !== baseline.buildId ||
    verified.baseline?.artifact?.sha256 !== baseline.artifact?.sha256
  )
    throw new Error("Native APK lacks a matching verification record.");
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-published-"));
  try {
    await verifyPublishedAPK(baseline, temp);
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
  await record(
    {
      schemaVersion: 1,
      tag,
      sha,
      platform,
      phase: "distributed",
      publishedAt,
      baseline,
      buildId: baseline.buildId,
    },
    "success",
  );
}

async function verifyIPA(ipa: string, baseline: NativeBaseline) {
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-ipa-"));
  try {
    await run("ditto", ["-x", "-k", ipa, temp]);
    const apps = (await NodeFSP.readdir(NodePath.join(temp, "Payload"))).filter((name) =>
      name.endsWith(".app"),
    );
    if (apps.length !== 1) throw new Error("Expected one IPA application.");
    const app = NodePath.join(temp, "Payload", apps[0]!);
    await run("codesign", ["--verify", "--deep", "--strict", app]);
    for (const [name, source] of [
      ["info-plist", "Info.plist"],
      ["expo-plist", "Expo.plist"],
    ]) {
      await run("plutil", [
        "-convert",
        "json",
        "-o",
        NodePath.join(temp, `${name}.json`),
        NodePath.join(app, source!),
      ]);
    }
    for (const [name, suffix] of [
      ["app", ""],
      ["widgets", "PlugIns/ExpoWidgetsTarget.appex"],
      ["sharing", "PlugIns/expo-sharing-extension.appex"],
    ]) {
      const xml = await run("codesign", [
        "-d",
        "--entitlements",
        ":-",
        NodePath.join(app, suffix!),
      ]);
      const file = NodePath.join(temp, `${name}-entitlements.json`);
      await NodeFSP.writeFile(file, xml);
      await run("plutil", ["-convert", "json", file]);
    }
    await run("node", [
      "scripts/fork-ios-identity.ts",
      ...identityArgs(baseline),
      "--embedded-fingerprint",
      NodePath.join(app, "EXUpdates.bundle", "fingerprint"),
      ...[
        "info-plist",
        "expo-plist",
        "app-entitlements",
        "widgets-entitlements",
        "sharing-entitlements",
      ].flatMap((key) => [`--${key}`, NodePath.join(temp, `${key}.json`)]),
    ]);
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}
async function iosSubmit(tag: string, dir: string) {
  const { sha, intent, publishedAt } = await published(tag);
  await assertCheckout(sha);
  if (intent.ios.mode === "ota") return;
  const history = await records("ios");
  assertNotSuperseded(
    publishedAt,
    history.map((item) => item.payload),
  );
  if (history.some((item) => item.payload.tag === tag && item.payload.phase === "distributed"))
    return;
  const selected = history.find(
    (item) => item.payload.tag === tag && item.payload.phase === "verified",
  )?.payload;
  const baseline = selected?.baseline;
  if (!baseline?.github?.artifactId || baseline.sourceSha !== sha)
    throw new Error("No retained verified IPA for this release.");
  await appleIdentity();
  let availability = await appleAvailability(baseline);
  if (
    shouldUploadToApple(
      history.map((item) => item.payload),
      baseline.buildId,
      availability !== undefined,
    )
  ) {
    if (!(await recoverNative(baseline.github, "ios", sha, tag, intent, dir)))
      throw new Error("Retained IPA is missing; refusing upload.");
    const ipa = NodePath.join(dir, "app.ipa");
    await verifyIPA(ipa, baseline);
    await record({
      schemaVersion: 1,
      tag,
      sha,
      platform: "ios",
      phase: "submitting",
      publishedAt,
      baseline,
      buildId: baseline.buildId,
      nativeRun: baseline.github,
    });
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-apple-key-"));
    try {
      const keyId = required("ASC_KEY_ID");
      if (!/^[A-Z0-9]+$/.test(keyId)) throw new Error("Invalid Apple key identifier.");
      await NodeFSP.writeFile(
        NodePath.join(temp, `AuthKey_${keyId}.p8`),
        Buffer.from(required("ASC_KEY_BASE64"), "base64"),
        { mode: 0o600 },
      );
      const result = await execFile(
        "xcrun",
        [
          "altool",
          "--upload-app",
          "--type",
          "ios",
          "--file",
          ipa,
          "--apiKey",
          keyId,
          "--apiIssuer",
          required("ASC_ISSUER_ID"),
          "--output-format",
          "json",
        ],
        {
          cwd: root,
          env: { ...NodeProcess.env, API_PRIVATE_KEYS_DIR: temp },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      // Apple's successful exit acknowledges upload; only its build API proves tester availability.
      if (!result.stdout)
        throw new Error(
          "Apple uploader returned no receipt; reconcile App Store Connect before retrying.",
        );
      await record({
        schemaVersion: 1,
        tag,
        sha,
        platform: "ios",
        phase: "submitted",
        publishedAt,
        baseline,
        buildId: baseline.buildId,
        nativeRun: baseline.github,
      });
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
    availability = await appleAvailability(baseline);
  }
  if (!availability?.available)
    throw new Error(
      "Apple has not made this exact build available to testers. Retry after processing and group assignment; the IPA will not be uploaded twice.",
    );
  await record(
    {
      schemaVersion: 1,
      tag,
      sha,
      platform: "ios",
      phase: "distributed",
      publishedAt,
      baseline: { ...baseline, expiresAt: availability.expiresAt },
      buildId: baseline.buildId,
      nativeRun: baseline.github,
      appleBuildId: availability.id,
    },
    "success",
  );
}
async function assertCheckout(sha: string) {
  if (!/^[0-9a-f]{40}$/.test(sha) || (await run("git", ["rev-parse", "HEAD"])).trim() !== sha)
    throw new Error("Checkout is not the approved exact SHA.");
  if ((await run("git", ["status", "--porcelain", "--untracked-files=normal"])).trim())
    throw new Error("Mobile delivery requires a clean source checkout.");
  if (
    (await run("git", ["config", "--get", "core.sparseCheckout"]).catch(() => "false")).trim() ===
    "true"
  )
    throw new Error("EAS requires a full checkout.");
}
async function main() {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      sha: { type: "string" },
      tag: { type: "string" },
      out: { type: "string" },
      intent: { type: "string" },
      dir: { type: "string" },
      platform: { type: "string" },
      force: { type: "string", default: "none" },
      "rebuild-native": { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  const tag = values.tag ?? "";
  if (!/^v?\d+\.\d+\.\d+-atli\.\d+$/.test(tag))
    throw new Error("Pass a published fork release tag or approved candidate tag.");
  if (
    NodeProcess.env.GITHUB_REPOSITORY !== MOBILE_REPO ||
    NodeProcess.env.GITHUB_REF !== "refs/heads/atli" ||
    NodeProcess.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
  )
    throw new Error(
      "Mobile publication runs only in the fork's manually dispatched atli workflow.",
    );
  if (command === "resolve") {
    const release = await published(tag);
    await NodeFSP.appendFile(required("GITHUB_OUTPUT"), `sha=${release.sha}\n`);
    return;
  }
  if (required("SKALD_EAS_READY") !== "true")
    throw new Error("EAS cutover prerequisites are not approved.");
  const profileConfig = decodePersonalProfile(
    json(await NodeFSP.readFile(NodePath.join(mobile, "eas.json"), "utf8")),
  );
  Object.assign(NodeProcess.env, profileConfig.build.personal.env);
  if (
    NodeProcess.env.APP_VARIANT !== "personal" ||
    NodeProcess.env.T3CODE_MOBILE_CHANNEL !== MOBILE_CHANNEL ||
    NodeProcess.env.EXPO_NO_DOTENV !== "1"
  ) {
    throw new Error(
      "The personal build profile must fix the fork variant, channel and dotenv policy.",
    );
  }
  if (command === "assemble") {
    const decode = Schema.decodeUnknownSync(PlatformDelivery);
    const androidIntent = decode(
      json(await NodeFSP.readFile(NodePath.join(values.dir!, "android-intent.json"), "utf8")),
    );
    const iosIntent = decode(
      json(await NodeFSP.readFile(NodePath.join(values.dir!, "ios-intent.json"), "utf8")),
    );
    await write(values.out!, { channel: MOBILE_CHANNEL, android: androidIntent, ios: iosIntent });
  } else if (command === "prepare") {
    await assertCheckout(values.sha ?? "");
    await prepare(decodePlatform(values.platform), values.sha!, tag, values.out!, values.force!);
  } else if (command === "android") {
    await assertCheckout(values.sha ?? "");
    await android(values.sha!, tag, values.intent!, values.dir!, values["rebuild-native"]!);
  } else if (command === "register-native") {
    const release = values.sha ? { sha: values.sha, publishedAt: undefined } : await published(tag);
    await assertCheckout(release.sha);
    await registerNative(
      decodePlatform(values.platform),
      release.sha,
      tag,
      values.dir!,
      values.intent,
      release.publishedAt,
    );
  } else if (command === "deliver")
    await deliver(decodePlatform(values.platform), tag, values.dir!, values["rebuild-native"]!);
  else if (command === "ios-submit") await iosSubmit(tag, values.dir!);
  else
    throw new Error(
      "Expected prepare, assemble, android, register-native, resolve, deliver, or ios-submit.",
    );
}
if (import.meta.main) {
  try {
    await main();
    for (const id of activeDeployments.values()) {
      await gh(`${repoPath}/deployments/${id}/statuses`, {
        state: "inactive",
        auto_inactive: false,
        description: "Phase completed; distribution is recorded separately.",
      });
    }
    activeDeployments.clear();
  } catch (error) {
    const description =
      error instanceof Error ? error.message.slice(0, 140) : "Mobile delivery failed.";
    for (const id of activeDeployments.values()) {
      try {
        await gh(`${repoPath}/deployments/${id}/statuses`, {
          state: "failure",
          auto_inactive: false,
          description,
        });
      } catch {
        NodeProcess.stderr.write(`Could not persist failure status for deployment ${id}.\n`);
      }
    }
    throw error;
  }
}
