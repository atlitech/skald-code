// @effect-diagnostics nodeBuiltinImport:off - Reads committed aapt and apksigner fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  checkAndroidIdentity,
  parseBadging,
  parseSignerSha256,
  readRecordedSha256,
} from "./fork-android-identity.ts";

// Fixtures use aapt/apksigner build-tools 36.0.0 output from the personal APK.
// The unversioned fixture has code 1; EAS allocates the independently increasing build number.
const fixture = (name: string): string =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "fixtures", "fork-android-identity", name),
    "utf8",
  );

const recordedSha256 = "8be8ce453295854ea7d25ace67081dd59a924ec1ae8ae111721e8c2446b37e8e";
const version = "0.0.46-atli.4";
const capturedBadging = fixture("badging.txt");
const badging = capturedBadging.replace("versionCode='1'", `versionCode='47000'`);
const certs = fixture("certs.txt");
const skill = NodeFS.readFileSync(
  NodePath.join(
    import.meta.dirname,
    "..",
    ".agents",
    "skills",
    "develop-t3-personal-android",
    "SKILL.md",
  ),
  "utf8",
);

const native = {
  appBuildVersion: "47000",
  appVersion: "2.0.0",
  runtimeVersion: "a".repeat(40),
  embeddedFingerprint: "a".repeat(40),
  channel: "personal-production",
  manifest: `E: manifest (line=1)
  E: application (line=2)
    E: meta-data (line=3)
      A: android:name(0x01010003)="expo.modules.updates.ENABLED"
      A: android:value(0x01010024)=(type 0x12)0xffffffff
    E: meta-data (line=4)
      A: android:name(0x01010003)="expo.modules.updates.EXPO_UPDATE_URL"
      A: android:value(0x01010024)="https://u.expo.dev/4dfd2e15-bc73-461a-a26f-ba1c7d559172"
    E: meta-data (line=5)
      A: android:name(0x01010003)="expo.modules.updates.EXPO_RUNTIME_VERSION"
      A: android:value(0x01010024)=@0x7f120001
    E: meta-data (line=6)
      A: android:name(0x01010003)="expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY"
      A: android:value(0x01010024)=${JSON.stringify(JSON.stringify({ "expo-channel-name": "personal-production" }))}
`,
  resources: `    resource 0x7f120001 tech.atli.skaldcode:string/expo_runtime_version: t=0x03
      (string8) "file:fingerprint"
`,
};

it("reads the package line, the signer digests, and the recorded fingerprint", () => {
  assert.deepStrictEqual(parseBadging(capturedBadging), {
    packageName: "tech.atli.skaldcode",
    versionCode: "1",
    versionName: "2.0.0",
  });
  assert.deepStrictEqual(parseSignerSha256(certs), [recordedSha256]);
  assert.strictEqual(readRecordedSha256(skill), recordedSha256);
  assert.strictEqual(readRecordedSha256("SHA-256: 8B:E8\n"), "8be8");
  assert.strictEqual(readRecordedSha256("no fingerprint here\n"), undefined);
});

it.effect("accepts the recorded personal identity", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* checkAndroidIdentity({ badging, certs, version, skill, ...native }),
      {
        packageName: "tech.atli.skaldcode",
        versionCode: "47000",
        version,
      },
    );
  }),
);

it.effect("refuses a wrong package, certificate, signer count, or versionCode", () =>
  Effect.gen(function* () {
    const refused = [
      {
        badging: badging.replace("name='tech.atli.skaldcode'", "name='com.t3tools.t3code'"),
        certs,
      },
      { badging, certs: certs.replace(recordedSha256, "0".repeat(64)) },
      {
        badging,
        certs: `${certs}Signer #2 certificate SHA-256 digest: ${recordedSha256}\n`,
      },
      { badging: capturedBadging, certs },
    ];
    for (const input of refused) {
      const error = yield* Effect.flip(
        checkAndroidIdentity({ ...native, ...input, version, skill }),
      );
      assert.strictEqual(error._tag, "AndroidIdentityError");
      assert.strictEqual(error.problems.length, 1, error.message);
    }
    const invalidNative: ReadonlyArray<Partial<typeof native>> = [
      { appBuildVersion: "0" },
      { appBuildVersion: "2100000001" },
      { appVersion: "3.0.0" },
      { runtimeVersion: "b".repeat(40) },
      { embeddedFingerprint: "b".repeat(40) },
      { channel: "production" },
      { manifest: native.manifest.replace("0xffffffff", "0x0") },
      { manifest: native.manifest.replace("4dfd2e15-bc73-461a-a26f-ba1c7d559172", "upstream") },
      { manifest: native.manifest.replace("UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY", "missing") },
      { resources: "" },
      {
        manifest: `${native.manifest}    E: meta-data (line=7)\n      A: android:name(0x01010003)="expo.modules.updates.EXPO_RUNTIME_VERSION"\n      A: android:value(0x01010024)=@0x7f120001\n`,
      },
      {
        resources: native.resources + native.resources.replace("file:fingerprint", "b".repeat(40)),
      },
    ];
    for (const input of invalidNative) {
      const error = yield* Effect.flip(
        checkAndroidIdentity({ ...native, ...input, badging, certs, version, skill }),
      );
      assert.strictEqual(error.problems.length, 1, error.message);
    }
    for (const incompatibleBadging of [
      badging.replace("native-code: 'arm64-v8a'", "native-code: 'arm64-v8a' 'x86_64'"),
      `${badging}\napplication-debuggable`,
    ]) {
      const error = yield* Effect.flip(
        checkAndroidIdentity({ ...native, badging: incompatibleBadging, certs, version, skill }),
      );
      assert.strictEqual(error.problems.length, 1, error.message);
    }
    assert.strictEqual(
      (yield* checkAndroidIdentity({ ...native, badging, certs, version: "0.0.46-atli.5", skill }))
        .versionCode,
      "47000",
    );
  }),
);
