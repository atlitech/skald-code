const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function androidCiMetroCacheDirectory(env = process.env) {
  if (env.T3CODE_ANDROID_BUILD_CACHE !== "1") return undefined;
  const directory = env.T3CODE_METRO_CACHE_DIR;
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error(
      "T3CODE_METRO_CACHE_DIR must be an absolute path when Android CI caching is enabled.",
    );
  }
  return path.join(directory, "app");
}

function androidCiMetroCacheVersion(projectRoot, publicConfig, env = process.env) {
  // Native manifests are regenerated separately; their version codes and temporary paths do not affect Android transforms.
  const javascriptConfig = Object.fromEntries(
    Object.entries(publicConfig).filter(
      ([name]) => !["android", "ios", "_internal"].includes(name),
    ),
  );
  const files = [
    "../../package.json",
    "../../pnpm-lock.yaml",
    "../../pnpm-workspace.yaml",
    "package.json",
    "metro.config.js",
    "babel.config.js",
    "app.config.ts",
    "global.css",
    "generated-uniwind-themes.css",
    "generated-uniwind-theme-names.json",
    "scripts/android-ci-metro-cache.cjs",
  ];
  const environment = Object.entries(env)
    .filter(
      ([name]) =>
        name.startsWith("EXPO_PUBLIC_") || ["NODE_ENV", "BABEL_ENV", "APP_VARIANT"].includes(name),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(
      JSON.stringify([
        "android-ci-metro-v1",
        process.versions.node,
        javascriptConfig,
        environment,
        files.map((file) => {
          const filename = path.resolve(projectRoot, file);
          return [file, fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null];
        }),
      ]),
    )
    .digest("hex");
}

function androidCiExpoArguments(args, env = process.env) {
  const platformIndex = args.indexOf("--platform");
  if (
    env.T3CODE_ANDROID_BUILD_CACHE !== "1" ||
    args[0] !== "export:embed" ||
    platformIndex === -1 ||
    args[platformIndex + 1] !== "android"
  ) {
    return args;
  }
  androidCiMetroCacheDirectory(env);
  return args.filter((argument) => argument !== "--reset-cache");
}

module.exports = {
  androidCiMetroCacheDirectory,
  androidCiMetroCacheVersion,
  androidCiExpoArguments,
};
