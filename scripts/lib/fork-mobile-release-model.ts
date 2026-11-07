import * as Schema from "effect/Schema";

export const MOBILE_PROJECT_ID = "4dfd2e15-bc73-461a-a26f-ba1c7d559172";
export const MOBILE_CHANNEL = "personal-production";
export const MOBILE_PROFILE = "personal";
export const MOBILE_APP_IDENTIFIER = "tech.atli.skaldcode";

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Nonempty = Schema.String.check(Schema.isPattern(/\S/));

export const GitHubNativeBuild = Schema.Struct({
  workflowSha: Sha,
  runId: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  runAttempt: Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)),
  artifactName: Nonempty,
  artifactId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[1-9]\d*$/))),
});
export type GitHubNativeBuild = typeof GitHubNativeBuild.Type;

export const NativeBaseline = Schema.Struct({
  buildId: Nonempty,
  github: Schema.optionalKey(GitHubNativeBuild),
  sourceSha: Sha,
  profile: Schema.Literal(MOBILE_PROFILE),
  appBuildVersion: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
  runtimeVersion: Nonempty,
  appVersion: Nonempty,
  releaseTag: Schema.String.check(Schema.isPattern(/^v?\d+\.\d+\.\d+-atli\.\d+$/)),
  artifact: Schema.optionalKey(
    Schema.Struct({
      file: Nonempty,
      url: Nonempty,
      sha256: Digest,
      size: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  expiresAt: Schema.optionalKey(Nonempty),
});
export type NativeBaseline = typeof NativeBaseline.Type;

export const PlatformDelivery = Schema.Struct({
  mode: Schema.Literals(["native", "ota"]),
  runtimeVersion: Nonempty,
  appVersion: Nonempty,
  baseline: Schema.optionalKey(NativeBaseline),
});
export type PlatformDelivery = typeof PlatformDelivery.Type;

export const MobileReleaseIntent = Schema.Struct({
  channel: Schema.Literal(MOBILE_CHANNEL),
  android: PlatformDelivery,
  ios: PlatformDelivery,
});
export type MobileReleaseIntent = typeof MobileReleaseIntent.Type;

// The caller supplies only a distributed baseline; a FINISHED EAS build is not one.
export const chooseMobileDelivery = (input: {
  readonly platform: "android" | "ios";
  readonly runtimeVersion: string;
  readonly appVersion: string;
  readonly baseline?: NativeBaseline;
  readonly forceNative?: boolean;
  readonly now: number;
}): PlatformDelivery => {
  const { baseline, runtimeVersion, appVersion } = input;
  const native: PlatformDelivery = { mode: "native", runtimeVersion, appVersion };
  if (!Number.isFinite(input.now)) throw new Error("Release decision needs a valid current time.");
  if (!baseline || input.forceNative) return native;
  if (baseline.runtimeVersion !== runtimeVersion || baseline.appVersion !== appVersion)
    return native;
  if (input.platform === "android" && !baseline.artifact) {
    throw new Error("A distributed Android baseline needs its original APK reference.");
  }
  if (input.platform === "ios") {
    const expiresAt = baseline.expiresAt === undefined ? NaN : Date.parse(baseline.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new Error("A TestFlight baseline needs its current App Store Connect expiration.");
    }
    if (expiresAt - input.now <= 14 * 24 * 60 * 60 * 1000) return native;
  }
  return { mode: "ota", runtimeVersion, appVersion, baseline };
};

export const validateMobileIntent = (
  intent: MobileReleaseIntent,
  release: {
    readonly commit: string;
    readonly version: string;
    readonly assets: ReadonlyArray<{
      readonly platform: string;
      readonly file: string;
      readonly size: number;
      readonly sha256: string;
    }>;
  },
): string | undefined => {
  for (const platform of ["android", "ios"] as const) {
    const delivery = intent[platform];
    const baseline = delivery.baseline;
    if (
      baseline?.github &&
      (!baseline.github.artifactId ||
        baseline.buildId !==
          `github:${baseline.github.runId}:${baseline.github.runAttempt}:${platform}`)
    ) {
      return `${platform} GitHub native provenance is incomplete or inconsistent.`;
    }
    if (delivery.mode === "ota" && !baseline)
      return `${platform} OTA needs a distributed baseline.`;
    if (
      baseline &&
      (baseline.runtimeVersion !== delivery.runtimeVersion ||
        baseline.appVersion !== delivery.appVersion)
    ) {
      return `${platform} baseline does not match the intended runtime and app version.`;
    }
  }
  const android = intent.android;
  const baseline = android.baseline;
  const artifact = baseline?.artifact;
  if (!baseline || !artifact)
    return "Android delivery needs its original APK and native build reference.";
  const version = baseline.releaseTag.replace(/^v/, "");
  if (artifact.file !== `T3-Code-${version}-android-arm64-v8a.apk`) {
    return "Android baseline filename must retain its original release version.";
  }
  const url = `https://github.com/atlitech/skald-code/releases/download/${baseline.releaseTag}/${artifact.file}`;
  if (artifact.url !== url)
    return "Android baseline URL must name the original fork release asset.";
  const assets = release.assets.filter((asset) => asset.platform === "android");
  if (android.mode === "ota") {
    if (assets.length !== 0)
      return "An Android OTA release must reference, not republish, its baseline APK.";
    if (version === release.version)
      return "An Android OTA baseline must already belong to a prior release.";
  } else {
    if (baseline.sourceSha !== release.commit || version !== release.version) {
      return "The native Android build must come from this exact release commit and tag.";
    }
    const asset = assets[0];
    if (
      assets.length !== 1 ||
      asset?.file !== artifact.file ||
      asset.sha256 !== artifact.sha256 ||
      asset.size !== artifact.size
    ) {
      return "The native Android baseline must match the newly published APK's name, size and digest.";
    }
  }
  return undefined;
};
