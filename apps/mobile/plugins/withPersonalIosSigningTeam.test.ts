import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ConfigPlugin, ExportedConfig } from "expo/config-plugins";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const plugin = require("./withPersonalIosSigningTeam.cjs") as ConfigPlugin<{
  provisioningProfiles?: Readonly<Record<string, string>>;
}>;
const { IOSConfig } = require("expo/config-plugins") as typeof import("expo/config-plugins");

// The app and a share extension Expo left without a team, as prebuild writes them.
const target = (id: string, name: string, list: string) => `
		${id} /* ${name} */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${list};
			buildPhases = (
			);
			name = "${name}";
			productName = "${name}";
			productType = "com.apple.product-type.application";
		};`;
const configuration = (id: string, settings: string) => `
		${id} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
${settings}
			};
			name = Release;
		};`;
const list = (id: string, configurationId: string) => `
		${id} = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${configurationId} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};`;
const PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 54;
	objects = {
/* Begin PBXNativeTarget section */${target("A0000000000000000000000A", "SkaldCode", "A0000000000000000000000C")}${target("B0000000000000000000000A", "expo-sharing-extension", "B0000000000000000000000C")}
/* End PBXNativeTarget section */
/* Begin XCBuildConfiguration section */${configuration(
  "A0000000000000000000000B",
  '				DEVELOPMENT_TEAM = H6L3F33KRM;\n				PRODUCT_BUNDLE_IDENTIFIER = "tech.atli.skaldcode";',
)}${configuration("B0000000000000000000000B", '				PRODUCT_BUNDLE_IDENTIFIER = "tech.atli.skaldcode.sharing";')}
/* End XCBuildConfiguration section */
/* Begin XCConfigurationList section */${list("A0000000000000000000000C", "A0000000000000000000000B")}${list("B0000000000000000000000C", "B0000000000000000000000B")}
/* End XCConfigurationList section */
	};
	rootObject = A0000000000000000000000A;
}
`;

const signedSettings = async (provisioningProfiles?: Record<string, string>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "personal-ios-signing-"));
  try {
    const projectDir = NodePath.join(root, "ios", "SkaldCode.xcodeproj");
    NodeFS.mkdirSync(projectDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(projectDir, "project.pbxproj"), PBXPROJ);
    const project = IOSConfig.XcodeUtils.getPbxproj(root);
    const config = plugin(
      { name: "Skald Code", slug: "t3-code", ios: { appleTeamId: "H6L3F33KRM" } },
      { provisioningProfiles },
    ) as ExportedConfig;
    const mod = config.mods?.ios?.xcodeproj;
    if (!mod) throw new Error("Missing xcodeproj mod");
    await mod({
      ...config,
      modRawConfig: config,
      modResults: project,
      modRequest: {
        projectRoot: root,
        platformProjectRoot: NodePath.join(root, "ios"),
        projectName: "SkaldCode",
        platform: "ios",
        modName: "xcodeproj",
        introspect: false,
      },
    });
    return Object.fromEntries(
      IOSConfig.Target.getNativeTargets(project).map(([, nativeTarget]) => {
        const [release] = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
          project,
          nativeTarget.buildConfigurationList,
        );
        if (!release) throw new Error(`${nativeTarget.name} has no build configuration`);
        const { buildSettings } = release[1];
        return [String(buildSettings.PRODUCT_BUNDLE_IDENTIFIER).replaceAll('"', ""), buildSettings];
      }),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

it("gives the share extension the app's team, so run:ios does not re-sign with another", async () => {
  const settings = await signedSettings();
  expect(settings["tech.atli.skaldcode.sharing"]).toMatchObject({ DEVELOPMENT_TEAM: "H6L3F33KRM" });
  expect(settings["tech.atli.skaldcode.sharing"]?.CODE_SIGN_STYLE).toBeUndefined();
});

it("signs every target for the App Store with its own profile", async () => {
  const settings = await signedSettings({
    "tech.atli.skaldcode": "Skald Code App Store",
    "tech.atli.skaldcode.sharing": "Skald Code Sharing App Store",
  });
  for (const [bundleId, profile] of [
    ["tech.atli.skaldcode", '"Skald Code App Store"'],
    ["tech.atli.skaldcode.sharing", '"Skald Code Sharing App Store"'],
  ] as const) {
    expect(settings[bundleId], bundleId).toMatchObject({
      DEVELOPMENT_TEAM: "H6L3F33KRM",
      CODE_SIGN_STYLE: "Manual",
      CODE_SIGN_IDENTITY: '"Apple Distribution"',
      '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"': '"Apple Distribution"',
      PROVISIONING_PROFILE_SPECIFIER: profile,
    });
  }
});

it("refuses a target without an App Store profile", async () => {
  await expect(signedSettings({ "tech.atli.skaldcode": "Skald Code App Store" })).rejects.toThrow(
    "No App Store provisioning profile for tech.atli.skaldcode.sharing.",
  );
});
