import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import {
  androidCiExpoArguments,
  androidCiMetroCacheDirectory,
  androidCiMetroCacheVersion,
} from "./android-ci-metro-cache.cjs";

const require = NodeModule.createRequire(import.meta.url);
const expoRequire = NodeModule.createRequire(require.resolve("expo/metro-config"));
const { default: Transformer } = expoRequire("@expo/metro/metro/DeltaBundler/Transformer");
const { FileStore } = expoRequire("@expo/metro/metro-cache");

it("keeps the persistent store after Uniwind config composition and excludes generated CSS transforms", () => {
  using temporary = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "t3-metro-store-"));
  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const crypto = require("node:crypto");
    Promise.resolve(require("./metro.config.js")).then(async (config) => {
      const store = config.cacheStores[0];
      const key = crypto.createHash("sha256").update(process.env.T3CODE_METRO_CACHE_DIR).digest();
      const cssKey = crypto.createHash("sha256").update(key).digest();
      await store.set(key, { source: "persistent" });
      await store.set(cssKey, { output: [{ data: { css: { skipCache: true } } }] });
      const root = path.join(process.env.T3CODE_METRO_CACHE_DIR, "app");
      const files = fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter(file => fs.statSync(path.join(root, file)).isFile()) : [];
      console.log("T3_CACHE_RESULT=" + JSON.stringify({ files: files.length, value: await store.get(key), css: await store.get(cssKey) }));
    });
  `;
  const stdout = NodeChildProcess.execFileSync(process.execPath, ["-e", script], {
    cwd: NodePath.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      APP_VARIANT: "personal",
      MOBILE_VERSION_POLICY: "appVersion",
      T3CODE_ANDROID_BUILD_CACHE: "1",
      T3CODE_METRO_CACHE_DIR: temporary.path,
    },
    encoding: "utf8",
  });
  const result = stdout.split("\n").find((line) => line.startsWith("T3_CACHE_RESULT="));
  expect(result).toBeDefined();
  expect(JSON.parse(result.slice("T3_CACHE_RESULT=".length))).toEqual({
    files: 1,
    value: { source: "persistent" },
    css: null,
  });
});

it("preserves normal Expo commands and requires a persistent directory before bypassing reset", () => {
  const args = ["export:embed", "--platform", "android", "--reset-cache", "--dev", "false"];
  const env = { T3CODE_ANDROID_BUILD_CACHE: "1", T3CODE_METRO_CACHE_DIR: "/tmp/metro-ci" };
  expect(androidCiExpoArguments(args, {})).toEqual(args);
  expect(androidCiMetroCacheDirectory({})).toBeUndefined();
  expect(androidCiExpoArguments(args, env)).toEqual([
    "export:embed",
    "--platform",
    "android",
    "--dev",
    "false",
  ]);
  expect(androidCiExpoArguments(["start", "--reset-cache"], env)).toEqual([
    "start",
    "--reset-cache",
  ]);
  const ios = ["export:embed", "--platform", "ios", "--reset-cache"];
  expect(androidCiExpoArguments(ios, env)).toEqual(ios);
  const noPlatform = ["export:embed", "--reset-cache"];
  expect(androidCiExpoArguments(noPlatform, env)).toEqual(noPlatform);
  for (const directory of [undefined, "relative/cache"]) {
    expect(() =>
      androidCiExpoArguments(args, { ...env, T3CODE_METRO_CACHE_DIR: directory }),
    ).toThrow("absolute path");
  }
});

it("reuses transforms across Metro instances and invalidates changed source, generated files, configuration and public env", async () => {
  using temporary = NodeFS.mkdtempDisposableSync(NodePath.join(NodeOS.tmpdir(), "t3-metro-cache-"));
  const projectRoot = NodePath.join(temporary.path, "apps/mobile");
  NodeFS.mkdirSync(projectRoot, { recursive: true });
  const source = NodePath.join(projectRoot, "index.js");
  const generated = NodePath.join(projectRoot, ".generated", "index.js");
  NodeFS.mkdirSync(NodePath.dirname(generated), { recursive: true });
  NodeFS.writeFileSync(source, "module.exports = 1;");
  NodeFS.writeFileSync(generated, "module.exports = 'generated';");
  const transformerPath = NodePath.join(temporary.path, "transformer.cjs");
  const calls = NodePath.join(temporary.path, "calls");
  NodeFS.writeFileSync(
    transformerPath,
    `
    const NodeFS = require("node:fs");
    exports.transform = (_config, _root, filename, data) => {
      NodeFS.appendFileSync(${JSON.stringify(calls)}, filename + "\\n");
      return { source: data.toString() };
    };
  `,
  );
  const env = {
    T3CODE_ANDROID_BUILD_CACHE: "1",
    T3CODE_METRO_CACHE_DIR: NodePath.join(temporary.path, "cache"),
    NODE_ENV: "production",
    EXPO_PUBLIC_API_URL: "https://first.example",
  };
  const publicConfig = {
    extra: { relay: { url: "https://relay.example" } },
    android: { versionCode: 100, googleServicesFile: "/tmp/run-one/google-services.json" },
    _internal: { projectRoot: "/tmp/run-one/project" },
  };
  const transform = async (filename = source) => {
    const store = new FileStore({ root: androidCiMetroCacheDirectory(env) });
    const writes = [];
    const transformer = new Transformer(
      {
        projectRoot,
        watchFolders: [projectRoot],
        transformerPath,
        transformer: {},
        maxWorkers: 1,
        cacheVersion: androidCiMetroCacheVersion(projectRoot, publicConfig, env),
        cacheStores: [
          {
            get: (key) => store.get(key),
            set: (key, value) => {
              const write = store.set(key, value);
              writes.push(write);
              return write;
            },
          },
        ],
        reporter: { update: () => {} },
      },
      {
        getOrComputeSha1: async (file) => {
          const content = NodeFS.readFileSync(file);
          return { content, sha1: NodeCrypto.createHash("sha1").update(content).digest("hex") };
        },
      },
    );
    try {
      const result = await transformer.transformFile(filename, {
        platform: "android",
        dev: false,
        type: "module",
      });
      await Promise.all(writes);
      return result.source;
    } finally {
      await transformer.end();
    }
  };
  const count = () => NodeFS.readFileSync(calls, "utf8").trim().split("\n").length;

  expect(await transform()).toBe("module.exports = 1;");
  expect(await transform()).toBe("module.exports = 1;");
  expect(count()).toBe(1);
  publicConfig.android.versionCode += 1;
  publicConfig.android.googleServicesFile = "/tmp/run-two/google-services.json";
  publicConfig._internal.projectRoot = "/tmp/run-two/project";
  expect(await transform()).toBe("module.exports = 1;");
  expect(count()).toBe(1);

  NodeFS.writeFileSync(source, "module.exports = 2;");
  expect(await transform()).toBe("module.exports = 2;");
  expect(count()).toBe(2);
  await transform(generated);
  NodeFS.writeFileSync(generated, "module.exports = 'updated';");
  expect(await transform(generated)).toBe("module.exports = 'updated';");
  expect(count()).toBe(4);

  env.EXPO_PUBLIC_API_URL = "https://second.example";
  await transform();
  expect(count()).toBe(5);
  publicConfig.extra.relay.url = "https://new-relay.example";
  await transform();
  expect(count()).toBe(6);

  for (const file of [
    "babel.config.js",
    "metro.config.js",
    "global.css",
    "generated-uniwind-themes.css",
    "../../pnpm-lock.yaml",
  ]) {
    const before = count();
    NodeFS.writeFileSync(NodePath.resolve(projectRoot, file), "changed configuration");
    await transform();
    expect(count(), file).toBe(before + 1);
    await transform();
    expect(count(), file).toBe(before + 1);
  }
});
