#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - Standalone release CLI coordinates external GitHub, EAS and Apple APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeReleaseManifestJson } from "./fork-release-manifest.ts";
import {
  chooseMobileDelivery,
  MobileReleaseIntent,
  NativeBaseline,
  validateMobileIntent,
} from "./lib/fork-mobile-release-model.ts";
import {
  assertBuild,
  assertNotSuperseded,
  assertUpdate,
  easJsonArgs,
  EASBuild,
  EASSubmission,
  EASUpdate,
  selectSubmission,
  selectUpdate,
  EAS_PROJECT_ID,
  MOBILE_CHANNEL,
  MOBILE_PROFILE,
  MOBILE_REPO,
  selectBuild,
} from "./lib/fork-mobile-eas.ts";

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
  return json(await run("eas", easJsonArgs(args), mobile));
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
        expirationDate: Schema.String,
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
const decodeSubmissions = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      builds: Schema.Struct({
        byId: Schema.Struct({
          id: Schema.String,
          app: Schema.Struct({ id: Schema.String }),
          submissions: Schema.Array(EASSubmission),
        }),
      }),
    }),
  }),
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
const decodeBuild = Schema.decodeUnknownSync(EASBuild);
const decodeBuilds = Schema.decodeUnknownSync(Schema.Array(EASBuild));
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
const decodeSubmitConfig = Schema.decodeUnknownSync(
  Schema.Struct({ submit: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
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
  const expiresAt = build.attributes.expirationDate;
  if (!Number.isFinite(Date.parse(expiresAt)))
    throw new Error("Invalid TestFlight expiration date.");
  if (build.attributes.expired || build.attributes.processingState !== "VALID")
    return { id: build.id, expiresAt, available: false };
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

async function submissionsFor(buildId: string) {
  const response = await fetch("https://api.expo.dev/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${required("EXPO_TOKEN")}`,
    },
    body: JSON.stringify({
      query: `query SkaldBuildSubmissions($id: ID!) { builds { byId(buildId: $id) { id app { id } submissions { id status iosConfig { ascAppIdentifier } } } } }`,
      variables: { id: buildId },
    }),
  });
  if (!response.ok) throw new Error(`Expo submission lookup failed (${response.status}).`);
  const result = decodeSubmissions(await response.json());
  const build = result.data.builds.byId;
  if (build.id !== buildId || build.app.id !== EAS_PROJECT_ID)
    throw new Error("Submission query returned a different project/build.");
  return build.submissions;
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
async function prepare(sha: string, tag: string, out: string, force: string) {
  await appleIdentity();
  const old = (await records("ios")).find(
    (item) => item.payload.tag === tag && item.payload.intent,
  );
  if (old) {
    if (old.payload.sha !== sha) throw new Error("Release planning SHA changed.");
    await write(out, old.payload.intent);
    return;
  }
  const config = await checkConfig();
  const decisions = {} as Record<Platform, ReturnType<typeof chooseMobileDelivery>>;
  for (const platform of ["android", "ios"] as const) {
    let baseline = (await records(platform)).find((item) => item.payload.phase === "distributed")
      ?.payload.baseline;
    if (baseline && platform === "ios") {
      const availability = await appleAvailability(baseline);
      baseline = availability?.available
        ? { ...baseline, expiresAt: availability.expiresAt }
        : undefined;
    }
    decisions[platform] = chooseMobileDelivery({
      platform,
      runtimeVersion: await fingerprint(platform),
      appVersion: config.version,
      ...(baseline ? { baseline } : {}),
      forceNative: force === "all" || force === platform,
      now: Date.now(),
    });
  }
  const intent: MobileReleaseIntent = { channel: MOBILE_CHANNEL, ...decisions };
  await record({ schemaVersion: 1, tag, sha, platform: "ios", phase: "planned", intent });
  await write(out, intent);
}

async function buildFor(
  platform: Platform,
  sha: string,
  tag: string,
  intent: MobileReleaseIntent,
  publishedAt?: string,
) {
  const history = await records(platform);
  const checkpoint = history.find((item) => item.payload.tag === tag && item.payload.buildId);
  const previous = checkpoint?.payload;
  if (checkpoint) activeDeployments.set(platform, checkpoint.id);
  if (previous && previous.sha !== sha)
    throw new Error("Recorded build belongs to a different release SHA.");
  const message = `skald:${tag}:${platform}:${sha}`;
  let build: EASBuild | undefined;
  if (previous?.buildId) build = decodeBuild(await eas(["build:view", previous.buildId]));
  else {
    const builds: EASBuild[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = decodeBuilds(
        await eas([
          "build:list",
          "--platform",
          platform,
          "--build-profile",
          MOBILE_PROFILE,
          "--git-commit-hash",
          sha,
          "--limit",
          "50",
          "--offset",
          String(offset),
        ]),
      );
      builds.push(...page);
      if (page.length < 50) break;
    }
    build = selectBuild(builds, message);
    if (!build) {
      if (history.some((item) => item.payload.tag === tag && item.payload.phase === "requesting")) {
        throw new Error(
          "A previous EAS build request has no recoverable ID yet. Reconcile it in EAS before another request.",
        );
      }
      await record({
        schemaVersion: 1,
        tag,
        sha,
        platform,
        phase: "requesting",
        ...(publishedAt ? { publishedAt } : {}),
      });
      const created = decodeBuilds(
        await eas([
          "build",
          "--platform",
          platform,
          "--profile",
          MOBILE_PROFILE,
          "--message",
          message,
          "--no-wait",
          "--freeze-credentials",
        ]),
      );
      if (created.length !== 1) throw new Error("Expected one newly requested EAS build.");
      build = created[0]!;
    }
    await record({
      schemaVersion: 1,
      tag,
      sha,
      platform,
      phase: "building",
      buildId: build.id,
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  // A cancelled runner resumes this exact ID; it never allocates a replacement counter.
  for (let attempt = 0; build.status !== "FINISHED" && attempt < 240; attempt++) {
    if (["ERRORED", "CANCELED"].includes(build.status))
      throw new Error(`EAS build ${build.id} ${build.status}.`);
    await NodeTimersPromises.setTimeout(30_000);
    build = decodeBuild(await eas(["build:view", build.id]));
  }
  const priorNumbers = history.flatMap((item) =>
    item.payload.phase === "distributed" && item.payload.baseline
      ? [BigInt(item.payload.baseline.appBuildVersion)]
      : [],
  );
  const maximum = priorNumbers.reduce((max, number) => (number > max ? number : max), 0n);
  assertBuild(build, {
    platform,
    sha,
    ...intent[platform],
    previousBuildVersion: maximum.toString(),
  });
  return build;
}
async function download(url: string, file: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Artifact URL must use HTTPS.");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Artifact download failed (${response.status}).`);
  await NodeFSP.writeFile(file, new Uint8Array(await response.arrayBuffer()));
}
async function digest(file: string) {
  const bytes = await NodeFSP.readFile(file);
  return {
    size: bytes.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  };
}
function baselineFor(
  build: EASBuild,
  sha: string,
  tag: string,
  intent: MobileReleaseIntent,
  platform: Platform,
): NativeBaseline {
  return {
    buildId: build.id,
    sourceSha: sha,
    profile: MOBILE_PROFILE,
    releaseTag: tag,
    appBuildVersion: build.appBuildVersion!,
    appVersion: intent[platform].appVersion,
    runtimeVersion: intent[platform].runtimeVersion,
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
async function android(sha: string, tag: string, file: string, dir: string) {
  const intent = await readIntent(file);
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-apk-"));
  try {
    if (intent.android.mode === "ota") {
      await verifyPublishedAPK(intent.android.baseline!, temp);
      return;
    }
    const build = await buildFor("android", sha, tag, intent);
    await NodeFSP.mkdir(dir, { recursive: true });
    const name = `T3-Code-${tag.replace(/^v/, "")}-android-arm64-v8a.apk`;
    const apk = NodePath.resolve(dir, name);
    await download(build.artifacts!.applicationArchiveUrl!, apk);
    const baseline = baselineFor(build, sha, tag, intent, "android");
    await verifyAPK(apk, baseline, temp);
    const verified = {
      ...baseline,
      artifact: {
        file: name,
        url: `https://github.com/${MOBILE_REPO}/releases/download/${tag}/${name}`,
        ...(await digest(apk)),
      },
    };
    await record({
      schemaVersion: 1,
      tag,
      sha,
      platform: "android",
      phase: "verified",
      buildId: build.id,
      baseline: verified,
    });
    await write(file, { ...intent, android: { ...intent.android, baseline: verified } });
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
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
async function deliver(platform: Platform, tag: string) {
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
    await buildFor(platform, sha, tag, intent, publishedAt);
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

async function iosVerify(tag: string) {
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
    (item) => item.payload.tag === tag && item.payload.buildId,
  )?.payload;
  if (!selected?.buildId) throw new Error("No exact iOS EAS build ID has been recorded.");
  const build = decodeBuild(await eas(["build:view", selected.buildId]));
  assertBuild(build, { platform: "ios", sha, ...intent.ios });
  const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skald-ipa-"));
  let baseline = baselineFor(build, sha, tag, intent, "ios");
  try {
    const ipa = NodePath.join(temp, "app.ipa");
    await download(build.artifacts!.applicationArchiveUrl!, ipa);
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
    baseline = {
      ...baseline,
      artifact: {
        file: "app.ipa",
        url: `https://expo.dev/accounts/atlitech/projects/skald-code/builds/${build.id}`,
        ...(await digest(ipa)),
      },
    };
    await record({
      schemaVersion: 1,
      tag,
      sha,
      platform: "ios",
      phase: "verified",
      publishedAt,
      baseline,
      buildId: build.id,
    });
    await appleIdentity();
    let submission = selectSubmission(await submissionsFor(build.id), ascAppId());
    if (!submission) {
      // A lost submit response is ambiguous until EAS associates a submission with this exact build.
      if (history.some((item) => item.payload.tag === tag && item.payload.phase === "submitting"))
        throw new Error(
          "Previous submission has no EAS record yet. Reconcile in EAS before retrying; do not upload twice.",
        );
      await record({
        schemaVersion: 1,
        tag,
        sha,
        platform: "ios",
        phase: "submitting",
        publishedAt,
        baseline,
        buildId: build.id,
      });
      const configPath = NodePath.join(mobile, "eas.json");
      const original = await NodeFSP.readFile(configPath, "utf8");
      const config = decodeSubmitConfig(json(original));
      const originalObject = decodeObject(json(original));
      await write(configPath, {
        ...originalObject,
        submit: {
          ...config.submit,
          personal: { ios: { appleTeamId: "H6L3F33KRM", ascAppId: ascAppId() } },
        },
      });
      try {
        await run(
          "eas",
          [
            "submit",
            "--platform",
            "ios",
            "--profile",
            MOBILE_PROFILE,
            "--id",
            build.id,
            "--non-interactive",
            "--wait",
          ],
          mobile,
        );
      } finally {
        await NodeFSP.writeFile(configPath, original);
      }
      submission = selectSubmission(await submissionsFor(build.id), ascAppId());
    }
    if (!submission)
      throw new Error("Submission ID is not available yet; retry after checking EAS.");
    await record({
      schemaVersion: 1,
      tag,
      sha,
      platform: "ios",
      phase: "submitted",
      publishedAt,
      baseline,
      buildId: build.id,
      submissionId: submission.id,
    });
    if (submission.status !== "FINISHED")
      throw new Error(
        `EAS submission ${submission.id}: ${submission.status}. Retry this release after resolving it.`,
      );
    const availability = await appleAvailability(baseline);
    if (!availability?.available)
      throw new Error(
        "IPA submitted, but Apple has not made it available to testers. Retry this release after processing and group assignment.",
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
        buildId: build.id,
        submissionId: submission.id,
        appleBuildId: availability.id,
      },
      "success",
    );
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}
async function assertCheckout(sha: string) {
  if (!/^[0-9a-f]{40}$/.test(sha) || (await run("git", ["rev-parse", "HEAD"])).trim() !== sha)
    throw new Error("Checkout is not the approved exact SHA.");
  if ((await run("git", ["status", "--porcelain", "--untracked-files=normal"])).trim())
    throw new Error("EAS publication requires a clean source checkout.");
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
    },
  });
  const command = positionals[0];
  const tag = values.tag ?? "";
  if (!/^v?\d+\.\d+\.\d+-atli\.\d+$/.test(tag))
    throw new Error("Pass a published fork release tag or approved candidate tag.");
  if (
    NodeProcess.env.GITHUB_REPOSITORY !== MOBILE_REPO ||
    NodeProcess.env.GITHUB_REF !== "refs/heads/atli"
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
  if (command === "prepare") {
    await assertCheckout(values.sha ?? "");
    await prepare(values.sha!, tag, values.out!, values.force!);
  } else if (command === "android") {
    await assertCheckout(values.sha ?? "");
    await android(values.sha!, tag, values.intent!, values.dir!);
  } else if (command === "deliver") await deliver(decodePlatform(values.platform), tag);
  else if (command === "ios-verify") await iosVerify(tag);
  else throw new Error("Expected prepare, android, resolve, deliver, or ios-verify.");
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
