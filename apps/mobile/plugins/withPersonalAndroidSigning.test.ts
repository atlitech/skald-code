import * as NodeModule from "node:module";
import type { ConfigPlugin, ExportedConfig } from "expo/config-plugins";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const plugin = require("./withPersonalAndroidSigning.cjs") as ConfigPlugin<{
  unsigned?: boolean;
}>;
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;

async function buildGradle(unsigned?: boolean, contents = TEMPLATE) {
  const config = plugin({ name: "Skald Code", slug: "t3-code" }, { unsigned }) as ExportedConfig;
  const mod = config.mods?.android?.appBuildGradle;
  if (!mod) throw new Error("Missing app/build.gradle mod");
  const result = await mod({
    ...config,
    modRawConfig: config,
    modResults: {
      path: "/tmp/personal/android/app/build.gradle",
      language: "groovy",
      contents,
    },
    modRequest: {
      projectRoot: "/tmp/personal",
      platformProjectRoot: "/tmp/personal/android",
      projectName: "SkaldCode",
      platform: "android",
      modName: "appBuildGradle",
      introspect: false,
    },
  });
  return result.modResults.contents;
}

it("keeps release signing mandatory by default, without falling back to the debug key", async () => {
  const contents = await buildGradle();
  expect(contents).toContain("release {\n            signingConfig signingConfigs.personal");
  expect(contents).not.toContain("release {\n            signingConfig signingConfigs.debug");
  expect(contents).toContain("if (value == null || value.trim().isEmpty()) {");
  expect(contents).toContain(
    'throw new GradleException("Missing required T3 Code Personal signing variable: " + name)',
  );
  for (const name of ["KEYSTORE_FILE", "KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD"]) {
    expect(contents).toContain(`t3PersonalSigningValue("T3CODE_PERSONAL_ANDROID_${name}")`);
  }
  expect(await buildGradle(undefined, contents)).toBe(contents);
});

it("builds an explicitly unsigned release without evaluating signing credentials", async () => {
  const contents = await buildGradle(true);
  expect(contents).toContain("release {\n            signingConfig null");
  expect(contents).not.toContain("release {\n            signingConfig signingConfigs.debug");
  expect(contents).not.toContain("signingConfigs.personal");
  expect(contents).not.toContain("t3PersonalSigningValue");
  expect(contents).not.toContain("T3CODE_PERSONAL_ANDROID_");
  expect(await buildGradle(true, contents)).toBe(contents);
  await expect(buildGradle(true, await buildGradle())).rejects.toThrow();
  await expect(buildGradle(undefined, contents)).rejects.toThrow();
});
