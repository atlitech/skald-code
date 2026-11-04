#!/usr/bin/env node

// Validate the signed personal iOS archive before the TestFlight upload: bundle ID, build number,
// team, App Store signing, and the App Group the extensions share. An archive signed without a
// profile keeps none of its entitlements. See docs/operations/fork-server.md.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { androidVersionCode } from "./lib/android-version-code.ts";

export const PERSONAL_IOS_BUNDLE_ID = "tech.atli.skaldcode";
export const PERSONAL_APPLE_TEAM_ID = "H6L3F33KRM";
const APP_GROUP = `group.${PERSONAL_IOS_BUNDLE_ID}`;

type Plist = Readonly<Record<string, unknown>>;

export class IosIdentityError extends Schema.TaggedError<IosIdentityError>()("IosIdentityError", {
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `The archive is not the release's personal iOS app: ${this.problems.join(" ")}`;
  }
}

const checkBundle = (name: string, bundleId: string, entitlements: Plist) => {
  const problems: Array<string> = [];
  const applicationId = `${PERSONAL_APPLE_TEAM_ID}.${bundleId}`;
  if (entitlements["application-identifier"] !== applicationId) {
    problems.push(
      `${name} is signed as '${String(entitlements["application-identifier"])}', not '${applicationId}'.`,
    );
  }
  if (entitlements["get-task-allow"] !== false || entitlements["beta-reports-active"] !== true) {
    problems.push(`${name} is not signed with an App Store profile.`);
  }
  const groups = entitlements["com.apple.security.application-groups"];
  if (!Array.isArray(groups) || !groups.includes(APP_GROUP)) {
    problems.push(`${name} lacks the App Group ${APP_GROUP}.`);
  }
  return problems;
};

const expectedBuildNumber = (version: string) => {
  try {
    return { buildNumber: String(androidVersionCode(version)), problem: undefined };
  } catch (error) {
    return { buildNumber: undefined, problem: (error as Error).message };
  }
};

export const checkIosIdentity = Effect.fn("checkIosIdentity")(function* (input: {
  readonly infoPlist: Plist;
  readonly app: Plist;
  readonly widgets: Plist;
  readonly sharing: Plist;
  readonly version: string;
}) {
  const problems: Array<string> = [];
  const bundleId = input.infoPlist.CFBundleIdentifier;
  if (bundleId !== PERSONAL_IOS_BUNDLE_ID) {
    problems.push(`the bundle ID is '${String(bundleId)}', not '${PERSONAL_IOS_BUNDLE_ID}'.`);
  }
  const { buildNumber, problem } = expectedBuildNumber(input.version);
  if (problem) problems.push(problem);
  if (buildNumber !== undefined && input.infoPlist.CFBundleVersion !== buildNumber) {
    problems.push(
      `the build number is '${String(input.infoPlist.CFBundleVersion)}', not '${buildNumber}' for ${input.version}.`,
    );
  }
  problems.push(...checkBundle("the app", PERSONAL_IOS_BUNDLE_ID, input.app));
  problems.push(
    ...checkBundle("the widget extension", `${PERSONAL_IOS_BUNDLE_ID}.widgets`, input.widgets),
  );
  problems.push(
    ...checkBundle("the share extension", `${PERSONAL_IOS_BUNDLE_ID}.sharing`, input.sharing),
  );
  if (input.app["aps-environment"] !== "production") {
    problems.push(
      `the app's push environment is '${String(input.app["aps-environment"])}', not 'production'.`,
    );
  }
  if (problems.length > 0 || buildNumber === undefined) {
    return yield* new IosIdentityError({ problems });
  }
  return { bundleId: PERSONAL_IOS_BUNDLE_ID, buildNumber, version: input.version } as const;
});

const decodePlistJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const readPlistJson = Effect.fn("readPlistJson")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* decodePlistJson(yield* fs.readFileString(path)).pipe(
    Effect.mapError(() => new IosIdentityError({ problems: [`'${path}' is not a JSON object.`] })),
  );
});

const plistFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description));

const command = Command.make(
  "fork-ios-identity",
  {
    infoPlist: plistFlag(
      "info-plist",
      "The app's Info.plist, as JSON from `plutil -convert json`.",
    ),
    app: plistFlag("app-entitlements", "The app's signed entitlements, as JSON."),
    widgets: plistFlag(
      "widgets-entitlements",
      "The widget extension's signed entitlements, as JSON.",
    ),
    sharing: plistFlag(
      "sharing-entitlements",
      "The share extension's signed entitlements, as JSON.",
    ),
    // `--version` is the runner's own flag.
    version: Flag.String("release-version").pipe(
      Flag.withDescription("Fork version, for example 0.0.46-atli.1."),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const identity = yield* checkIosIdentity({
        infoPlist: yield* readPlistJson(options.infoPlist),
        app: yield* readPlistJson(options.app),
        widgets: yield* readPlistJson(options.widgets),
        sharing: yield* readPlistJson(options.sharing),
        version: options.version,
      });
      yield* Effect.log(
        `${identity.bundleId} ${identity.version} (build ${identity.buildNumber}), App Store-signed by ${PERSONAL_APPLE_TEAM_ID} with its App Group: the release's iOS app.`,
      );
    }),
).pipe(
  Command.withDescription(
    "Check the fork personal iOS archive's bundle ID, build number, signing and entitlements.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
