import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkIosIdentity } from "./fork-ios-identity.ts";

const version = "0.1.7-atli.1";
const signed = (bundleId: string) => ({
  "application-identifier": `H6L3F33KRM.${bundleId}`,
  "beta-reports-active": true,
  "get-task-allow": false,
  "com.apple.security.application-groups": ["group.tech.atli.skaldcode"],
});
// Each case mutates a fresh copy of an App Store-signed release archive.
const archive = () => ({
  infoPlist: {
    CFBundleIdentifier: "tech.atli.skaldcode",
    CFBundleVersion: "1007010",
    CFBundleShortVersionString: "2.0.0",
  },
  app: { ...signed("tech.atli.skaldcode"), "aps-environment": "production" } as Record<
    string,
    unknown
  >,
  widgets: signed("tech.atli.skaldcode.widgets") as Record<string, unknown>,
  sharing: signed("tech.atli.skaldcode.sharing") as Record<string, unknown>,
  version,
  appBuildVersion: "1007010",
  appVersion: "2.0.0",
  runtimeVersion: "a".repeat(40),
  embeddedFingerprint: "a".repeat(40),
  channel: "personal-production",
  expoPlist: {
    EXUpdatesEnabled: true,
    EXUpdatesURL: "https://u.expo.dev/4dfd2e15-bc73-461a-a26f-ba1c7d559172",
    EXUpdatesRuntimeVersion: "file:fingerprint",
    EXUpdatesRequestHeaders: { "expo-channel-name": "personal-production" },
  },
});

it.effect("accepts the release's App Store-signed app and extensions", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* checkIosIdentity(archive()), {
      bundleId: "tech.atli.skaldcode",
      buildNumber: "1007010",
      version,
    });
  }),
);

it.effect("refuses a wrong identity, build number, signature, or lost entitlement", () =>
  Effect.gen(function* () {
    const mutations: ReadonlyArray<(input: ReturnType<typeof archive>) => void> = [
      (input) => (input.infoPlist.CFBundleIdentifier = "com.elvis.t3code"),
      (input) => (input.infoPlist.CFBundleVersion = "1"),
      (input) => (input.app["application-identifier"] = "ARK85ZXQ4Z.tech.atli.skaldcode"),
      // Development-signed.
      (input) => (input.widgets["get-task-allow"] = true),
      // Signed at export from an unsigned archive: the identity survives, the App Group does not.
      (input) => delete input.sharing["com.apple.security.application-groups"],
      (input) => (input.app["aps-environment"] = "development"),
      (input) => (input.infoPlist.CFBundleShortVersionString = "1.0.0"),
      (input) => (input.expoPlist.EXUpdatesEnabled = false),
      (input) => (input.embeddedFingerprint = "b".repeat(40)),
      (input) => (input.expoPlist.EXUpdatesURL = "https://u.expo.dev/upstream"),
      (input) => (input.expoPlist.EXUpdatesRuntimeVersion = "b".repeat(40)),
      (input) => (input.expoPlist.EXUpdatesRequestHeaders["expo-channel-name"] = "production"),
    ];
    for (const mutate of mutations) {
      const input = archive();
      mutate(input);
      const error = yield* Effect.flip(checkIosIdentity(input));
      assert.strictEqual(error._tag, "IosIdentityError");
      assert.strictEqual(error.problems.length, 1, error.message);
    }
    const independentVersion = yield* checkIosIdentity({ ...archive(), version: "0.1.8-atli.1" });
    assert.strictEqual(independentVersion.buildNumber, "1007010");
    const invalid = archive();
    invalid.appBuildVersion = "-1";
    invalid.infoPlist.CFBundleVersion = "-1";
    const error = yield* Effect.flip(checkIosIdentity(invalid));
    assert.match(error.message, /EAS iOS build number is invalid/);
  }),
);
