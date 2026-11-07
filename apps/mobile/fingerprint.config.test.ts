import { expect, it } from "vite-plus/test";

import fingerprintConfig from "./fingerprint.config.js";

it("matches local and TestFlight signing while retaining native compatibility inputs", () => {
  const transform = (config: object) =>
    fingerprintConfig.fileHookTransform!(
      { type: "contents", id: "expoConfig" },
      JSON.stringify(config),
      true,
      "utf8",
    );
  const local = {
    ios: { appleTeamId: "H6L3F33KRM", entitlements: { "aps-environment": "production" } },
    plugins: [["./plugins/withPersonalIosSigningTeam.cjs", {}]],
  };
  const store = {
    ...local,
    plugins: [
      [
        "./plugins/withPersonalIosSigningTeam.cjs",
        { provisioningProfiles: { "tech.atli.skaldcode": "Skald Code App Store" } },
      ],
    ],
  };
  expect(transform(store)).toBe(transform(local));
  expect(transform({ ...store, ios: { ...store.ios, appleTeamId: "OTHER" } })).not.toBe(
    transform(local),
  );
  expect(transform({ ...store, plugins: [...store.plugins, "new-native-module"] })).not.toBe(
    transform(local),
  );
});
