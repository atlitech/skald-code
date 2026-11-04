const { IOSConfig, withXcodeProject } = require("expo/config-plugins");

const unquote = (value) => (typeof value === "string" ? value.replace(/^"|"$/g, "") : value);

// Expo applies appleTeamId before plugins add the share extension. An unsigned target makes
// `expo run:ios` re-sign every target with the first local certificate, often a free team's.
// With provisioningProfiles (bundle ID -> profile name), every target signs for the App Store.
module.exports = function withPersonalIosSigningTeam(config, { provisioningProfiles } = {}) {
  return withXcodeProject(config, (modConfig) => {
    const project = modConfig.modResults;
    const appleTeamId = modConfig.ios?.appleTeamId;
    if (appleTeamId) {
      IOSConfig.DevelopmentTeam.updateDevelopmentTeamForPbxproj(project, appleTeamId);
    }
    if (!provisioningProfiles) return modConfig;
    for (const [, target] of IOSConfig.Target.getNativeTargets(project)) {
      const configurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
        project,
        target.buildConfigurationList,
      );
      for (const [, { buildSettings }] of configurations) {
        const bundleIdentifier = unquote(buildSettings.PRODUCT_BUNDLE_IDENTIFIER);
        const profile = provisioningProfiles[bundleIdentifier];
        if (!profile) {
          throw new Error(`No App Store provisioning profile for ${bundleIdentifier}.`);
        }
        buildSettings.CODE_SIGN_STYLE = "Manual";
        buildSettings.CODE_SIGN_IDENTITY = '"Apple Distribution"';
        buildSettings['"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'] = '"Apple Distribution"';
        buildSettings.PROVISIONING_PROFILE_SPECIFIER = JSON.stringify(profile);
      }
    }
    return modConfig;
  });
};
