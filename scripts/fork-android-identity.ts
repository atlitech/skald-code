#!/usr/bin/env node

// Validate the EAS APK against its selected native version, runtime, and installed signing identity.
// The fingerprint must match installed personal builds. See docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

export const PERSONAL_ANDROID_PACKAGE = "tech.atli.skaldcode";

// The skill sits at a fixed place relative to this script in the repository.
const DEFAULT_SKILL = `${import.meta.dirname}/../.agents/skills/develop-t3-personal-android/SKILL.md`;

export interface AndroidBadging {
  readonly packageName: string | undefined;
  readonly versionCode: string | undefined;
  readonly versionName: string | undefined;
}

/** Reads the `package:` line of `aapt dump badging` output. */
export const parseBadging = (output: string): AndroidBadging => {
  const line = /^package: (.*)$/m.exec(output)?.[1] ?? "";
  const attribute = (name: string) => new RegExp(`(?:^| )${name}='([^']*)'`).exec(line)?.[1];
  return {
    packageName: attribute("name"),
    versionCode: attribute("versionCode"),
    versionName: attribute("versionName"),
  };
};

/** Lowercase hex without colons or whitespace, so differently printed digests compare. */
export const normalizeSha256 = (fingerprint: string): string =>
  fingerprint.replace(/[\s:]/g, "").toLowerCase();

/** Each signer's certificate SHA-256 from `apksigner verify --print-certs` output. */
export const parseSignerSha256 = (output: string): ReadonlyArray<string> =>
  Array.from(
    output.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9A-Fa-f:]+)\s*$/gm),
    (match) => normalizeSha256(match[1]!),
  );

/** The `SHA-256:` fingerprint the personal Android skill records for the signing key. */
export const readRecordedSha256 = (skill: string): string | undefined => {
  const recorded = Array.from(skill.matchAll(/^SHA-256: ([0-9A-Fa-f:]+)\s*$/gm), (match) =>
    normalizeSha256(match[1]!),
  );
  return recorded.length === 1 ? recorded[0] : undefined;
};

export class AndroidIdentityError extends Schema.TaggedError<AndroidIdentityError>()(
  "AndroidIdentityError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The APK is not the release's personal Android app: ${this.problems.join(" ")}`;
  }
}

const checkSigner = (certs: string, skill: string): string | undefined => {
  const recorded = readRecordedSha256(skill);
  if (recorded === undefined) {
    return "the personal Android skill does not record exactly one SHA-256 fingerprint.";
  }
  const signers = parseSignerSha256(certs);
  if (signers.length !== 1) return `apksigner reports ${signers.length} signers, not one.`;
  if (signers[0] !== recorded) {
    return `the signing certificate SHA-256 is ${signers[0]}, not the recorded ${recorded}.`;
  }
  return undefined;
};

const checkVersionCode = (versionCode: string | undefined, expected: string) => {
  if (!/^[1-9]\d*$/.test(expected) || Number(expected) > 2_100_000_000) {
    return { expected: undefined, problem: "the EAS Android build number is invalid." };
  }
  return {
    expected,
    problem:
      versionCode === expected
        ? undefined
        : `versionCode is '${versionCode ?? "missing"}', not the selected EAS build's '${expected}'.`,
  };
};

const UPDATE_URL = "https://u.expo.dev/4dfd2e15-bc73-461a-a26f-ba1c7d559172";

const aaptString = (value: string): string => {
  const raw = /\(Raw: "(.*)"\)$/.exec(value)?.[1];
  const quoted = raw ?? /^"(.*)"$/.exec(value)?.[1];
  if (quoted === undefined) return value;
  try {
    return JSON.parse(`"${quoted}"`) as string;
  } catch {
    return quoted;
  }
};

const resourceValues = (output: string) => {
  const values = new Map<string, Array<string>>();
  let id: string | undefined;
  for (const line of output.split("\n")) {
    const resource = /^\s*resource (0x[0-9a-f]+) /i.exec(line);
    if (resource) id = resource[1]!.toLowerCase();
    const value = /^\s*\(string(?:8|16)\) (.*)$/.exec(line);
    if (id && value) values.set(id, [...(values.get(id) ?? []), aaptString(value[1]!)]);
  }
  return values;
};

const checkAndroidUpdates = (input: {
  readonly manifest: string;
  readonly resources: string;
  readonly runtimeVersion: string;
  readonly embeddedFingerprint: string;
  readonly channel: string;
}): ReadonlyArray<string> => {
  const resources = resourceValues(input.resources);
  const metadata = new Map<string, Array<string>>();
  const elements: Array<{ depth: number; name: string }> = [];
  let name: string | undefined;
  let value: string | undefined;
  let inMetadata = false;
  const flush = () => {
    if (inMetadata && name !== undefined && value !== undefined) {
      metadata.set(name, [...(metadata.get(name) ?? []), value]);
    }
  };
  for (const line of input.manifest.split("\n")) {
    const element = /^(\s*)E: ([^ ]+)/.exec(line);
    if (element) {
      flush();
      const depth = element[1]!.length;
      while (elements.length && elements.at(-1)!.depth >= depth) elements.pop();
      inMetadata = element[2] === "meta-data" && elements.at(-1)?.name === "application";
      elements.push({ depth, name: element[2]! });
      name = undefined;
      value = undefined;
      continue;
    }
    if (!inMetadata) continue;
    const attribute = /^\s*A: android:(name|value)\([^)]*\)=(.*)$/.exec(line);
    if (attribute?.[1] === "name") name = aaptString(attribute[2]!);
    if (attribute?.[1] === "value") value = aaptString(attribute[2]!);
  }
  flush();
  const read = (key: string) => {
    const values = metadata.get(`expo.modules.updates.${key}`);
    if (values?.length !== 1) return undefined;
    const value = values[0]!;
    if (!value.startsWith("@")) return value;
    const resolved = resources.get(value.slice(1).toLowerCase());
    return resolved?.length && resolved.every((item) => item === resolved[0])
      ? resolved[0]
      : undefined;
  };
  let channel: unknown;
  try {
    const headers: unknown = JSON.parse(
      read("UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY") ?? "null",
    );
    if (headers !== null && typeof headers === "object" && "expo-channel-name" in headers) {
      channel = headers["expo-channel-name"];
    }
  } catch {
    /* Malformed embedded headers fail the comparison below. */
  }
  const runtime = read("EXPO_RUNTIME_VERSION");
  const embeddedRuntime = runtime === "file:fingerprint" ? input.embeddedFingerprint : runtime;
  return [
    read("ENABLED") === "(type 0x12)0xffffffff" || read("ENABLED") === "true"
      ? undefined
      : "embedded Expo updates are not enabled.",
    read("EXPO_UPDATE_URL") === UPDATE_URL
      ? undefined
      : "the embedded update URL is not the fork project.",
    embeddedRuntime === input.runtimeVersion && input.runtimeVersion.length > 0
      ? undefined
      : "the embedded runtime differs from the selected EAS runtime.",
    channel === input.channel && input.channel.length > 0
      ? undefined
      : "the embedded update channel differs from the selected EAS channel.",
  ].filter((problem): problem is string => problem !== undefined);
};

export const checkAndroidIdentity = Effect.fn("checkAndroidIdentity")(function* (input: {
  readonly badging: string;
  readonly certs: string;
  readonly version: string;
  readonly skill: string;
  readonly appBuildVersion: string;
  readonly appVersion: string;
  readonly runtimeVersion: string;
  readonly embeddedFingerprint: string;
  readonly channel: string;
  readonly manifest: string;
  readonly resources: string;
}) {
  const badging = parseBadging(input.badging);
  const versionCode = checkVersionCode(badging.versionCode, input.appBuildVersion);
  const problems = [
    badging.packageName === PERSONAL_ANDROID_PACKAGE
      ? undefined
      : `the package is '${badging.packageName ?? "missing"}', not '${PERSONAL_ANDROID_PACKAGE}'.`,
    versionCode.problem,
    checkSigner(input.certs, input.skill),
    badging.versionName === input.appVersion
      ? undefined
      : "the APK app version differs from EAS metadata.",
    /^native-code: 'arm64-v8a'\s*$/m.test(input.badging) ? undefined : "the APK is not ARM64-only.",
    /^application-debuggable/m.test(input.badging) ? "the APK is debuggable." : undefined,
    ...checkAndroidUpdates(input),
  ].filter((problem): problem is string => problem !== undefined);
  if (problems.length > 0 || versionCode.expected === undefined) {
    return yield* new AndroidIdentityError({ problems });
  }
  return {
    packageName: PERSONAL_ANDROID_PACKAGE,
    versionCode: versionCode.expected,
    version: input.version,
  } as const;
});

const command = Command.make(
  "fork-android-identity",
  {
    badging: Flag.String("badging").pipe(
      Flag.withDescription("Output of `aapt dump badging <apk>`."),
    ),
    certs: Flag.String("certs").pipe(
      Flag.withDescription("Output of `apksigner verify --print-certs <apk>`."),
    ),
    // `--version` is the runner's own flag.
    version: Flag.String("release-version").pipe(
      Flag.withDescription("Fork version, for example 0.0.46-atli.1."),
    ),
    appBuildVersion: Flag.String("app-build-version"),
    appVersion: Flag.String("app-version"),
    runtimeVersion: Flag.String("runtime-version"),
    embeddedFingerprint: Flag.String("embedded-fingerprint").pipe(
      Flag.withDescription("APK assets/fingerprint extracted without modification."),
    ),
    channel: Flag.String("channel"),
    manifest: Flag.String("manifest").pipe(
      Flag.withDescription("Output of aapt dump xmltree APK AndroidManifest.xml."),
    ),
    resources: Flag.String("resources").pipe(
      Flag.withDescription("Output of aapt dump --values resources APK."),
    ),
    skill: Flag.String("skill").pipe(
      Flag.withDescription("The personal Android skill that records the signing fingerprint."),
      Flag.withDefault(DEFAULT_SKILL),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const identity = yield* checkAndroidIdentity({
        badging: yield* fs.readFileString(options.badging),
        certs: yield* fs.readFileString(options.certs),
        version: options.version,
        appBuildVersion: options.appBuildVersion,
        appVersion: options.appVersion,
        runtimeVersion: options.runtimeVersion,
        embeddedFingerprint: yield* fs.readFileString(options.embeddedFingerprint),
        channel: options.channel,
        manifest: yield* fs.readFileString(options.manifest),
        resources: yield* fs.readFileString(options.resources),
        skill: yield* fs.readFileString(options.skill),
      });
      yield* Effect.log(
        `${identity.packageName} ${identity.version} (versionCode ${identity.versionCode}), signed by the recorded personal key: the release's APK.`,
      );
    }),
).pipe(
  Command.withDescription(
    "Check the fork personal Android APK's package, versionCode and signing certificate.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
