import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  chooseMobileDelivery,
  MobileReleaseIntent,
  type NativeBaseline,
} from "./fork-mobile-release-model.ts";

const baseline: NativeBaseline = {
  buildId: "00000000-0000-0000-0000-000000000001",
  sourceSha: "a".repeat(40),
  profile: "personal",
  appBuildVersion: "4600001",
  appVersion: "1.0.0",
  runtimeVersion: "runtime-a",
  releaseTag: "v0.0.46-atli.1",
  artifact: {
    file: "T3-Code-0.0.46-atli.1-android-arm64-v8a.apk",
    url: "https://github.com/atlitech/skald-code/releases/download/v0.0.46-atli.1/T3-Code-0.0.46-atli.1-android-arm64-v8a.apk",
    size: 123,
    sha256: "b".repeat(64),
  },
  expiresAt: "2026-12-06T00:00:00Z",
};
const now = Date.parse("2026-11-06T00:00:00Z");
const candidate = { appVersion: "1.0.0", runtimeVersion: "runtime-a", now };

it("chooses each platform independently from a compatible distributed baseline", () => {
  for (const platform of ["android", "ios"] as const) {
    const chosen = chooseMobileDelivery({ ...candidate, platform, baseline });
    assert.equal(chosen.mode, "ota");
    assert.deepEqual(chosen.baseline, baseline);
    assert.equal(chooseMobileDelivery({ ...candidate, platform }).mode, "native");
    for (const change of [
      { runtimeVersion: "new-runtime" },
      { appVersion: "2.0.0" },
      { forceNative: true },
    ]) {
      assert.equal(
        chooseMobileDelivery({ ...candidate, platform, baseline, ...change }).mode,
        "native",
      );
    }
  }
});

it("refreshes TestFlight at fourteen days before Apple's expiration and fails closed without it", () => {
  for (const expiresAt of ["2026-11-20T00:00:00Z", "2026-11-05T00:00:00Z"]) {
    assert.equal(
      chooseMobileDelivery({ ...candidate, platform: "ios", baseline: { ...baseline, expiresAt } })
        .mode,
      "native",
    );
  }
  assert.equal(
    chooseMobileDelivery({
      ...candidate,
      platform: "ios",
      baseline: { ...baseline, expiresAt: "2026-11-20T00:00:01Z" },
    }).mode,
    "ota",
  );
  const { expiresAt: _expiresAt, ...withoutExpiry } = baseline;
  for (const invalid of [withoutExpiry, { ...baseline, expiresAt: "invalid" }]) {
    assert.throws(
      () => chooseMobileDelivery({ ...candidate, platform: "ios", baseline: invalid }),
      /App Store Connect expiration/,
    );
  }
  const { artifact: _artifact, ...withoutArtifact } = baseline;
  assert.throws(
    () => chooseMobileDelivery({ ...candidate, platform: "android", baseline: withoutArtifact }),
    /original APK/,
  );
});

it("rejects malformed externally persisted intent instead of accepting partial provenance", () => {
  const intent = {
    channel: "personal-production",
    android: { mode: "ota", runtimeVersion: "runtime-a", appVersion: "1.0.0", baseline },
    ios: { mode: "native", runtimeVersion: "runtime-a", appVersion: "1.0.0" },
  } satisfies MobileReleaseIntent;
  const decode = Schema.decodeUnknownSync(MobileReleaseIntent);
  assert.deepEqual(decode(intent), intent);
  for (const invalid of [
    { ...intent, channel: "production" },
    { ...intent, android: { ...intent.android, baseline: { ...baseline, sourceSha: "short" } } },
    { ...intent, android: { ...intent.android, baseline: { ...baseline, appBuildVersion: "0" } } },
    {
      ...intent,
      android: {
        ...intent.android,
        baseline: { ...baseline, artifact: { ...baseline.artifact, sha256: "wrong" } },
      },
    },
  ])
    assert.throws(() => decode(invalid));
});
