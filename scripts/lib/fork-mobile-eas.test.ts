import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  assertBuild,
  assertNotSuperseded,
  assertUpdate,
  easJsonArgs,
  EASBuild,
  EAS_PROJECT_ID,
  EASUpdate,
  selectBuild,
  selectSubmission,
  selectUpdate,
} from "./fork-mobile-eas.ts";

const decodeBuild = Schema.decodeUnknownSync(EASBuild);
const decodeUpdates = Schema.decodeUnknownSync(Schema.Array(EASUpdate));

const sha = "a".repeat(40);
const message = `skald:v0.0.46-atli.1:android:${sha}`;
const build: EASBuild = {
  id: "build-1",
  status: "FINISHED",
  platform: "ANDROID",
  message,
  app: { id: EAS_PROJECT_ID },
  buildProfile: "personal",
  appIdentifier: "tech.atli.skaldcode",
  appVersion: "1.0.0",
  appBuildVersion: "4600001",
  gitCommitHash: sha,
  distribution: "STORE",
  isForIosSimulator: false,
  updateChannel: { name: "personal-production" },
  runtime: { version: "native-runtime" },
  fingerprint: { hash: "native-runtime" },
  artifacts: { applicationArchiveUrl: "https://expo.dev/artifacts/app.apk" },
};
const expected = {
  platform: "android" as const,
  sha,
  runtimeVersion: "native-runtime",
  appVersion: "1.0.0",
};
const update: EASUpdate = {
  id: "update-1",
  group: "group-1",
  branch: "personal-production",
  platform: "android",
  runtimeVersion: "native-runtime",
  gitCommitHash: sha,
  message,
  isRollBackToEmbedded: false,
};

it("validates exact EAS source, project, profile, runtime and build number before verifying the artifact", () => {
  assert.doesNotThrow(() => assertBuild(decodeBuild(build), expected));
  assert.doesNotThrow(() => assertBuild(build, { ...expected, previousBuildVersion: "4600000" }));
  for (const previousBuildVersion of ["4600001", "4600002"]) {
    assert.throws(() => assertBuild(build, { ...expected, previousBuildVersion }));
  }
  const mismatches: Partial<EASBuild>[] = [
    { status: "IN_PROGRESS" },
    { platform: "IOS" },
    { app: { id: "upstream" } },
    { buildProfile: "production" },
    { appIdentifier: "com.t3tools.t3code" },
    { appVersion: "2.0.0" },
    { appBuildVersion: "0" },
    { gitCommitHash: "b".repeat(40) },
    { updateChannel: { name: "production" } },
    { runtime: { version: "other" } },
    { fingerprint: { hash: "other" } },
    { isForIosSimulator: true },
    { artifacts: null },
  ];
  for (const change of mismatches)
    assert.throws(() => assertBuild({ ...build, ...change }, expected));
  assert.throws(() =>
    assertBuild(
      { ...build, platform: "IOS", distribution: "INTERNAL" },
      { ...expected, platform: "ios" },
    ),
  );
});

it("resumes the exact active or completed build and refuses failed or ambiguous attempts", () => {
  for (const status of ["IN_QUEUE", "IN_PROGRESS", "FINISHED"]) {
    assert.equal(
      selectBuild(
        [
          { ...build, message: "another-release" },
          { ...build, status },
        ],
        message,
      )?.id,
      "build-1",
    );
  }
  assert.isUndefined(selectBuild([{ ...build, message: "another-release" }], message));
  for (const status of ["ERRORED", "CANCELED"])
    assert.throws(() => selectBuild([{ ...build, status }], message));
  assert.throws(
    () => selectBuild([build, { ...build, id: "build-2" }], message),
    /Multiple EAS builds/,
  );
});

it("recovers OTA publication from exact update:view metadata, not formatted list messages", () => {
  const viewed = decodeUpdates([
    { ...update, createdAt: "2026-11-06T00:00:00Z", assetMapUrl: null },
  ]);
  assert.equal(selectUpdate(viewed, message)?.group, "group-1");
  assert.equal(selectUpdate(viewed, message, true)?.group, "group-1");
  assert.throws(() => selectUpdate([], message, true), /Previous OTA request/);
  assert.isUndefined(selectUpdate([], message, false));
  assert.isUndefined(
    selectUpdate(
      [{ ...update, message: `"${message.slice(0, 30)}..." (a minute ago by robot)` }],
      message,
    ),
  );
  assert.throws(
    () => selectUpdate([update, { ...update, id: "update-2", group: "group-2" }], message),
    /Multiple OTA/,
  );
  assert.doesNotThrow(() => assertUpdate(update, { ...expected, message }));
  for (const change of [
    { branch: "production" },
    { platform: "ios" },
    { runtimeVersion: "other" },
    { gitCommitHash: "b".repeat(40) },
    { message: "other" },
    { isRollBackToEmbedded: true },
  ])
    assert.throws(() => assertUpdate({ ...update, ...change }, { ...expected, message }));
});

it("recovers only the exact fork submission and never treats submission as tester availability", () => {
  const submission = {
    id: "submission-1",
    status: "IN_PROGRESS",
    iosConfig: { ascAppIdentifier: "123456" },
  };
  for (const status of ["IN_PROGRESS", "FINISHED", "ERRORED"]) {
    assert.equal(selectSubmission([{ ...submission, status }], "123456")?.status, status);
  }
  assert.isUndefined(selectSubmission([], "123456"));
  assert.throws(() => selectSubmission([submission], "6787819824"), /Unexpected EAS submission/);
  assert.throws(() =>
    selectSubmission([submission, { ...submission, id: "submission-2" }], "123456"),
  );
});

it("refuses a stale delivery and malformed publication history while allowing the same release retry", () => {
  const publishedAt = "2026-11-06T12:00:00Z";
  assert.doesNotThrow(() =>
    assertNotSuperseded(publishedAt, [{ publishedAt }, { publishedAt: "2026-11-05T00:00:00Z" }]),
  );
  assert.throws(
    () => assertNotSuperseded(publishedAt, [{ publishedAt: "2026-11-07T00:00:00Z" }]),
    /implicit rollback/,
  );
  assert.throws(() => assertNotSuperseded("invalid", []), /Invalid release publication/);
  assert.throws(
    () => assertNotSuperseded(publishedAt, [{ publishedAt: "invalid" }]),
    /Invalid recorded/,
  );
});

it("uses only flags supported by CLI 27.5 for JSON reads and mutations", () => {
  assert.deepEqual(easJsonArgs(["build:view", "build-1"]), ["build:view", "build-1", "--json"]);
  assert.deepEqual(easJsonArgs(["update:view", "group-1"]), ["update:view", "group-1", "--json"]);
  assert.deepEqual(easJsonArgs(["build", "--platform", "ios"]), [
    "build",
    "--platform",
    "ios",
    "--json",
    "--non-interactive",
  ]);
});
