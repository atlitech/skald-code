// @ts-check
const fs = require("node:fs");
const path = require("node:path");

// Include the major version, which Expo ignores, to prevent OTAs reaching older store binaries.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
const version =
  process.env.T3CODE_MOBILE_VERSION ??
  appConfig.match(/^ {2}version: repoEnv\.T3CODE_MOBILE_VERSION \?\? "([^"]+)"/m)?.[1];
const majorVersion = version?.match(/^(\d+)\./)?.[1];
if (!majorVersion) {
  throw new Error("fingerprint.config.js could not read the app version from app.config.ts");
}

/** @type {import("expo/fingerprint").Config} */
module.exports = {
  nativeModuleSourceType: "files",
  extraSources: [
    {
      type: "contents",
      id: "appMajorVersion",
      contents: majorVersion,
      reasons: ["appMajorVersion"],
    },
  ],
  fileHookTransform(source, chunk) {
    if (source.type !== "contents" || source.id !== "expoConfig" || chunk == null) return chunk;
    /** @type {import("expo/config").ExpoConfig} */
    const config = JSON.parse(chunk.toString());
    // Signing profile names differ between local and TestFlight builds without changing native APIs.
    for (const plugin of config.plugins ?? []) {
      if (
        Array.isArray(plugin) &&
        plugin[0] === "./plugins/withPersonalIosSigningTeam.cjs" &&
        plugin[1]
      ) {
        delete plugin[1].provisioningProfiles;
      }
    }
    return JSON.stringify(config);
  },
};
