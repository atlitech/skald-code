import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
const environment = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => environment.values,
}));

afterEach(() => {
  environment.values = {};
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function config(values: Record<string, string>) {
  environment.values = values;
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  return (await import("./app.config.ts")).default;
}

describe("personal iOS configuration", () => {
  it("isolates signing, keychain, links and updates from the official app", async () => {
    const result = await config({
      APP_VARIANT: "development",
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.personal",
      T3CODE_MOBILE_UPDATES_ENABLED: "1",
    });
    expect(result.name).toBe("T3 Code Personal");
    expect(result.scheme).toBe("t3code-com.example.personal");
    expect(result.ios?.bundleIdentifier).toBe("com.example.personal");
    expect(result.ios?.appleTeamId).toBeUndefined();
    expect(result.ios?.associatedDomains).toEqual([]);
    expect(result.ios?.entitlements?.["keychain-access-groups"]).toEqual([
      "$(AppIdentifierPrefix)com.example.personal",
    ]);
    expect(result.updates?.enabled).toBe(false);
    expect(result.updates?.url).toBeUndefined();
    expect(result.owner).toBeUndefined();
    expect(result.extra?.eas).toBeUndefined();
    const plugins = result.plugins?.map((plugin) =>
      typeof plugin === "string" ? plugin : plugin[0],
    );
    expect(plugins).not.toContain("expo-widgets");
    expect(plugins).toContain("./plugins/withoutIosPersonalTeamCapabilities.cjs");
  });

  it("signs the personal variant with the fork's paid team and keeps team capabilities", async () => {
    const result = await config({ APP_VARIANT: "personal" });
    expect(result.ios?.appleTeamId).toBe("H6L3F33KRM");
    expect(result.updates?.enabled).toBe(false);
    expect(result.extra?.eas).toBeUndefined();
    const plugins = result.plugins?.map((plugin) =>
      typeof plugin === "string" ? plugin : plugin[0],
    );
    expect(plugins).toContain("expo-widgets");
    expect(plugins?.[0]).toBe("./plugins/withPersonalIosSigningTeam.cjs");
    expect(plugins).not.toContain("./plugins/withoutIosPersonalTeamCapabilities.cjs");
    const clerk = result.plugins?.find((plugin) => plugin[0] === "@clerk/expo");
    expect(clerk?.[1]).toMatchObject({ appleSignIn: false });
  });

  it.each([
    [undefined, 1],
    ["0.1.7-atli.1", 1007003],
  ])("gives personal release %j one build code on iOS and Android", async (version, code) => {
    const result = await config({
      APP_VARIANT: "personal",
      ...(version ? { T3CODE_RELEASE_VERSION: version } : {}),
    });
    expect(result.ios?.buildNumber).toBe(String(code));
    expect(result.android?.versionCode).toBe(code);
  });

  it("hands the TestFlight job's App Store profiles to the signing plugin", async () => {
    const profiles = { "tech.atli.skaldcode": "Skald Code App Store" };
    const result = await config({
      APP_VARIANT: "personal",
      T3CODE_IOS_PROVISIONING_PROFILES: JSON.stringify(profiles),
    });
    expect(result.plugins?.[0]).toEqual([
      "./plugins/withPersonalIosSigningTeam.cjs",
      { provisioningProfiles: profiles },
    ]);
  });

  it.each(['["Skald Code App Store"]', '{"tech.atli.skaldcode": 1}'])(
    "rejects provisioning profiles %s",
    async (value) => {
      await expect(
        config({ APP_VARIANT: "personal", T3CODE_IOS_PROVISIONING_PROFILES: value }),
      ).rejects.toThrow("T3CODE_IOS_PROVISIONING_PROFILES");
    },
  );

  it("preserves the official production identity and update service", async () => {
    const result = await config({ APP_VARIANT: "production" });
    expect(result.ios?.bundleIdentifier).toBe("com.t3tools.t3code");
    expect(result.ios?.appleTeamId).toBe("ARK85ZXQ4Z");
    expect(result.scheme).toBe("t3code");
    expect(result.updates?.enabled).toBe(true);
    expect(result.extra?.eas?.projectId).toBe("d763fcb8-d37c-41ea-a773-b54a0ab4a454");
  });

  it.each(["", "not a bundle", "com..example"])(
    "rejects invalid personal identifier %j",
    async (id) => {
      await expect(
        config({
          T3CODE_IOS_PERSONAL_TEAM: "1",
          T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: id,
        }),
      ).rejects.toThrow("T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID");
    },
  );
});

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(config({ APP_VARIANT: value })).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["personal", "tech.atli.skaldcode"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const result = await config(value === undefined ? {} : { APP_VARIANT: value });
  expect(result.ios?.bundleIdentifier).toBe(identifier);
  expect(result.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(result.ios?.associatedDomains).toContain(`applinks:${host}`);
  if (value !== "personal")
    expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
      `${result.ios?.appleTeamId}.${identifier}`,
    );
  expect(result.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  if (value !== "personal")
    expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});
