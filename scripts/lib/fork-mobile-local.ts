import * as Schema from "effect/Schema";
import {
  MOBILE_APP_IDENTIFIER,
  MOBILE_PROJECT_ID,
  type NativeBaseline,
  type GitHubNativeBuild,
  type PlatformDelivery,
} from "./fork-mobile-release-model.ts";

export const LocalBuildMetadata = Schema.Struct({
  platform: Schema.Literals(["android", "ios"]),
  projectId: Schema.Literal(MOBILE_PROJECT_ID),
  appIdentifier: Schema.Literal(MOBILE_APP_IDENTIFIER),
  appBuildVersion: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  appVersion: Schema.String,
  runtimeVersion: Schema.String,
  fingerprintHash: Schema.String,
  sourceSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  profile: Schema.Literals(["personal", "personal-pilot"]),
  channel: Schema.Literals(["personal-production", "personal-pilot"]),
  credentialsSource: Schema.Literal("remote"),
  cliVersion: Schema.Literal("27.5.0"),
  dirty: Schema.Literal(false),
});
export type LocalBuildMetadata = typeof LocalBuildMetadata.Type;
const decodeMetadata = Schema.decodeUnknownSync(LocalBuildMetadata);

const readPath = (input: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined,
    input,
  );

// EAS's envelope contains private keys: only this allowlist may reach disk or error output.
export function publicLocalMetadata(envelope: unknown): LocalBuildMetadata {
  const get = (key: string) => readPath(envelope, ["metadata", key]);
  try {
    const metadata = decodeMetadata({
      platform: readPath(envelope, ["job", "platform"]),
      projectId: readPath(envelope, ["job", "appId"]),
      appIdentifier: get("appIdentifier"),
      appBuildVersion: get("appBuildVersion"),
      appVersion: get("appVersion"),
      runtimeVersion: get("runtimeVersion"),
      fingerprintHash: get("fingerprintHash"),
      sourceSha: get("gitCommitHash"),
      profile: get("buildProfile"),
      channel: get("channel"),
      credentialsSource: get("credentialsSource"),
      cliVersion: get("cliVersion"),
      dirty: get("isGitWorkingTreeDirty"),
    });
    const nativeNumber = readPath(envelope, [
      "job",
      "version",
      metadata.platform === "android" ? "versionCode" : "buildNumber",
    ]);
    if (
      String(nativeNumber) !== metadata.appBuildVersion ||
      get("distribution") !== "store" ||
      (metadata.profile === "personal") !== (metadata.channel === "personal-production") ||
      get("simulator") === true ||
      get("developmentClient") === true
    )
      throw new Error("Invalid native job");
    return metadata;
  } catch {
    throw new Error("Invalid EAS local build metadata; credential-bearing input suppressed.");
  }
}

export function assertLocalBuild(
  metadata: LocalBuildMetadata,
  expected: {
    platform: string;
    sourceSha: string;
    runtimeVersion: string;
    appVersion: string;
    channel: string;
    minimumBuildVersion: string;
  },
) {
  if (
    metadata.platform !== expected.platform ||
    metadata.sourceSha !== expected.sourceSha ||
    metadata.runtimeVersion !== expected.runtimeVersion ||
    metadata.fingerprintHash !== expected.runtimeVersion ||
    metadata.appVersion !== expected.appVersion ||
    metadata.channel !== expected.channel ||
    BigInt(metadata.appBuildVersion) <= BigInt(expected.minimumBuildVersion)
  ) {
    throw new Error(
      "Local build metadata differs from the approved source/runtime or does not increase the native counter.",
    );
  }
}

export const ActionsArtifact = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  expired: Schema.Boolean,
  workflow_run: Schema.Struct({ id: Schema.Number, head_sha: Schema.String }),
});
export type ActionsArtifact = typeof ActionsArtifact.Type;
export function selectNativeArtifact(
  artifacts: readonly ActionsArtifact[],
  expected: {
    runId: string;
    artifactName: string;
    workflowSha: string;
    artifactId?: string;
  },
  allowExpired = false,
) {
  const candidates = artifacts.filter(
    (artifact) =>
      artifact.name === expected.artifactName &&
      (!expected.artifactId || String(artifact.id) === expected.artifactId),
  );
  if (candidates.length > 1) throw new Error("Ambiguous native build artifact.");
  const artifact = candidates[0];
  if (!artifact) return undefined;
  if (
    String(artifact.workflow_run.id) !== expected.runId ||
    artifact.workflow_run.head_sha !== expected.workflowSha
  )
    throw new Error("Native artifact expired or has different source provenance.");
  if (artifact.expired) {
    if (allowExpired) return undefined;
    throw new Error("Native artifact expired; explicit rebuild-native is required.");
  }
  return artifact;
}

export function shouldUploadToApple(
  history: readonly { phase: string; buildId?: string }[],
  buildId: string,
  appleBuildExists: boolean,
) {
  if (appleBuildExists) return false;
  if (
    history.some(
      (record) => record.buildId === buildId && ["submitting", "submitted"].includes(record.phase),
    )
  ) {
    throw new Error(
      "An earlier Apple upload may have succeeded. Wait for the exact build in App Store Connect; do not upload duplicate bytes.",
    );
  }
  return true;
}

export function assertRetainedNative(
  baseline: NativeBaseline,
  expected: {
    reference: GitHubNativeBuild;
    platform: string;
    sourceSha: string;
    tag: string;
    intent: PlatformDelivery;
    file: string;
    sha256: string;
    size: number;
  },
) {
  const { reference, platform, intent } = expected;
  if (
    !baseline.github ||
    baseline.sourceSha !== expected.sourceSha ||
    baseline.releaseTag !== expected.tag ||
    baseline.github.runId !== reference.runId ||
    baseline.github.runAttempt !== reference.runAttempt ||
    baseline.github.artifactName !== reference.artifactName ||
    baseline.github.workflowSha !== reference.workflowSha ||
    baseline.buildId !== `github:${reference.runId}:${reference.runAttempt}:${platform}` ||
    baseline.runtimeVersion !== intent.runtimeVersion ||
    baseline.appVersion !== intent.appVersion ||
    baseline.artifact?.file !== expected.file
  ) {
    throw new Error("Native artifact metadata differs from the approved release.");
  }
  if (baseline.artifact.sha256 !== expected.sha256 || baseline.artifact.size !== expected.size) {
    throw new Error("Native artifact digest mismatch.");
  }
}

export function artifactLookupHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return undefined;
  const stderr = String(error.stderr);
  const status = /HTTP (\d{3})/.exec(stderr)?.[1];
  return status === undefined ? undefined : Number(status);
}

export async function waitForNativeArtifact(
  reference: GitHubNativeBuild,
  lookup: () => Promise<ActionsArtifact | undefined>,
  wait: (milliseconds: number) => Promise<unknown>,
): Promise<ActionsArtifact> {
  const delays = [2_000, 4_000, 8_000, 16_000, 30_000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const artifact = await lookup();
      if (artifact !== undefined) return artifact;
    } catch (error) {
      const status = artifactLookupHttpStatus(error);
      const rateLimited =
        status === 403 &&
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        /rate limit/i.test(String(error.stderr));
      if (
        status !== 404 &&
        status !== 429 &&
        !(status !== undefined && status >= 500 && status <= 599) &&
        !rateLimited
      )
        throw error;
    }
    if (attempt < delays.length) await wait(delays[attempt]!);
  }
  throw new Error(
    `GitHub artifact ${reference.artifactId ?? reference.artifactName} in run ${reference.runId} was unavailable after 6 attempts over 60 seconds of backoff. Re-run failed jobs to recover the retained build; do not rebuild or allocate another native version.`,
  );
}

const decodeArtifact = Schema.decodeUnknownSync(ActionsArtifact);
const decodeArtifactPages = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ artifacts: Schema.Array(ActionsArtifact) })),
);

export async function lookupNativeArtifact(
  reference: GitHubNativeBuild,
  request: (path: string, paginate: boolean) => Promise<unknown>,
  allowExpired = false,
) {
  if (reference.artifactId) {
    let response: unknown;
    try {
      response = await request(`actions/artifacts/${reference.artifactId}`, false);
    } catch (error) {
      if (artifactLookupHttpStatus(error) === 404) return undefined;
      throw error;
    }
    const artifact = decodeArtifact(response);
    if (artifact.name !== reference.artifactName || String(artifact.id) !== reference.artifactId)
      throw new Error("Native artifact identity differs from the retained build.");
    return selectNativeArtifact([artifact], reference, allowExpired);
  }
  const pages = decodeArtifactPages(
    await request(`actions/runs/${reference.runId}/artifacts?per_page=100`, true),
  );
  return selectNativeArtifact(
    pages.flatMap((page) => page.artifacts),
    reference,
    allowExpired,
  );
}
