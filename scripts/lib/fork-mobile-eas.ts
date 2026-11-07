import * as Schema from "effect/Schema";

export const EAS_PROJECT_ID = "4dfd2e15-bc73-461a-a26f-ba1c7d559172";
export const MOBILE_CHANNEL = "personal-production";
export const MOBILE_PROFILE = "personal";
export const MOBILE_REPO = "atlitech/skald-code";
export const EASSubmission = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  iosConfig: Schema.NullOr(Schema.Struct({ ascAppIdentifier: Schema.NullOr(Schema.String) })),
});
export type EASSubmission = typeof EASSubmission.Type;

export const easJsonArgs = (args: readonly string[]) => [
  ...args,
  "--json",
  // These read-only commands in CLI 27.5 have JSON flags but no non-interactive flag.
  ...(["build:view", "update:view"].includes(args[0] ?? "") ? [] : ["--non-interactive"]),
];

export const EASBuild = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  platform: Schema.Literals(["ANDROID", "IOS"]),
  message: Schema.NullOr(Schema.String),
  app: Schema.Struct({ id: Schema.String }),
  buildProfile: Schema.NullOr(Schema.String),
  appIdentifier: Schema.NullOr(Schema.String),
  appVersion: Schema.NullOr(Schema.String),
  appBuildVersion: Schema.NullOr(Schema.String),
  gitCommitHash: Schema.NullOr(Schema.String),
  distribution: Schema.String,
  isForIosSimulator: Schema.Boolean,
  updateChannel: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  runtime: Schema.NullOr(Schema.Struct({ version: Schema.String })),
  fingerprint: Schema.NullOr(Schema.Struct({ hash: Schema.String })),
  artifacts: Schema.NullOr(
    Schema.Struct({ applicationArchiveUrl: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
  submissions: Schema.optionalKey(Schema.Array(EASSubmission)),
});
export type EASBuild = typeof EASBuild.Type;

export function assertBuild(
  build: EASBuild,
  expected: {
    platform: "android" | "ios";
    sha: string;
    runtimeVersion: string;
    appVersion: string;
    previousBuildVersion?: string;
  },
) {
  if (
    build.status !== "FINISHED" ||
    build.platform.toLowerCase() !== expected.platform ||
    build.app.id !== EAS_PROJECT_ID ||
    build.buildProfile !== MOBILE_PROFILE ||
    build.appIdentifier !== "tech.atli.skaldcode" ||
    build.appVersion !== expected.appVersion ||
    build.gitCommitHash !== expected.sha ||
    build.updateChannel?.name !== MOBILE_CHANNEL ||
    build.runtime?.version !== expected.runtimeVersion ||
    build.fingerprint?.hash !== expected.runtimeVersion ||
    build.isForIosSimulator ||
    (expected.platform === "ios" && build.distribution !== "STORE") ||
    !build.appBuildVersion ||
    !/^[1-9]\d*$/.test(build.appBuildVersion) ||
    (expected.previousBuildVersion !== undefined &&
      BigInt(build.appBuildVersion) <= BigInt(expected.previousBuildVersion)) ||
    !build.artifacts?.applicationArchiveUrl
  )
    throw new Error(`EAS build ${build.id} does not match the approved mobile intent.`);
}

export function selectBuild(builds: readonly EASBuild[], message: string): EASBuild | undefined {
  const matching = builds.filter((build) => build.message === message);
  if (matching.length > 1)
    throw new Error("Multiple EAS builds match this release; reconcile exact IDs before retrying.");
  const build = matching[0];
  if (build && ["ERRORED", "CANCELED"].includes(build.status)) {
    throw new Error(
      `EAS build ${build.id} ${build.status}; inspect it before a new release attempt.`,
    );
  }
  return build;
}

export const EASUpdate = Schema.Struct({
  id: Schema.String,
  group: Schema.String,
  branch: Schema.String,
  platform: Schema.String,
  runtimeVersion: Schema.String,
  gitCommitHash: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  isRollBackToEmbedded: Schema.Boolean,
});
export type EASUpdate = typeof EASUpdate.Type;
export function assertUpdate(
  update: EASUpdate,
  expected: {
    sha: string;
    platform: string;
    runtimeVersion: string;
    message: string;
  },
) {
  if (
    update.branch !== MOBILE_CHANNEL ||
    update.platform !== expected.platform ||
    update.runtimeVersion !== expected.runtimeVersion ||
    update.gitCommitHash !== expected.sha ||
    update.message !== expected.message ||
    update.isRollBackToEmbedded
  ) {
    throw new Error(`Update ${update.id} does not match the approved mobile intent.`);
  }
}

export function assertNotSuperseded(
  publishedAt: string,
  delivered: readonly { publishedAt?: string }[],
) {
  if (!Number.isFinite(Date.parse(publishedAt)))
    throw new Error("Invalid release publication time.");
  if (
    delivered.some(
      (record) => record.publishedAt && !Number.isFinite(Date.parse(record.publishedAt)),
    )
  ) {
    throw new Error("Invalid recorded mobile publication time.");
  }
  if (
    delivered.some(
      (record) => record.publishedAt && Date.parse(record.publishedAt) > Date.parse(publishedAt),
    )
  ) {
    throw new Error("A newer release has mobile delivery records. Refusing an implicit rollback.");
  }
}

export function selectUpdate(
  updates: readonly EASUpdate[],
  message: string,
  requestAlreadyRecorded = false,
): EASUpdate | undefined {
  const matching = updates.filter((update) => update.message === message);
  if (matching.length > 1)
    throw new Error(
      "Multiple OTA updates match this release; reconcile exact IDs before retrying.",
    );
  if (!matching[0] && requestAlreadyRecorded) {
    throw new Error(
      "Previous OTA request has no recoverable update ID yet. Reconcile EAS history before publishing again.",
    );
  }
  return matching[0];
}

export function selectSubmission(submissions: readonly EASSubmission[], appId: string) {
  if (
    submissions.length > 1 ||
    submissions.some((submission) => submission.iosConfig?.ascAppIdentifier !== appId)
  ) {
    throw new Error("Unexpected EAS submission history; reconcile before retrying.");
  }
  return submissions[0];
}

export const parseEasJson = (output: string): unknown => {
  // CLI 27.5 loads --environment before redirecting notices away from JSON stdout.
  const notice =
    /^(?:Environment variables with visibility "Plain text" and "Sensitive" loaded from the "[^"\r\n]+" environment on EAS: [^\r\n]*|No environment variables with visibility "Plain text" and "Sensitive" found for the "[^"\r\n]+" environment on EAS\.)\r?\n\s*/;
  return JSON.parse(output.trimStart().replace(notice, ""));
};
