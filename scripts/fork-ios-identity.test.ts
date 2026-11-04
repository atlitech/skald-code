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
  infoPlist: { CFBundleIdentifier: "tech.atli.skaldcode", CFBundleVersion: "1007003" },
  app: { ...signed("tech.atli.skaldcode"), "aps-environment": "production" } as Record<
    string,
    unknown
  >,
  widgets: signed("tech.atli.skaldcode.widgets") as Record<string, unknown>,
  sharing: signed("tech.atli.skaldcode.sharing") as Record<string, unknown>,
  version,
});

it.effect("accepts the release's App Store-signed app and extensions", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* checkIosIdentity(archive()), {
      bundleId: "tech.atli.skaldcode",
      buildNumber: "1007003",
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
    ];
    for (const mutate of mutations) {
      const input = archive();
      mutate(input);
      const error = yield* Effect.flip(checkIosIdentity(input));
      assert.strictEqual(error._tag, "IosIdentityError");
      assert.strictEqual(error.problems.length, 1, error.message);
    }
    const unversioned = yield* Effect.flip(checkIosIdentity({ ...archive(), version: "0.1.7" }));
    assert.match(unversioned.message, /not a fork release version/);
  }),
);
