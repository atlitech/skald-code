import { assert, it } from "@effect/vitest";
import {
  publicLocalMetadata,
  assertLocalBuild,
  assertRetainedNative,
  selectNativeArtifact,
  shouldUploadToApple,
} from "./fork-mobile-local.ts";

const sourceSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const envelope = {
  job: {
    platform: "android",
    appId: "4dfd2e15-bc73-461a-a26f-ba1c7d559172",
    version: { versionCode: "1008007" },
    secrets: { password: "PRIVATE-CANARY" },
  },
  metadata: {
    appIdentifier: "tech.atli.skaldcode",
    appBuildVersion: "1008007",
    appVersion: "2.2.0",
    runtimeVersion: "runtime",
    fingerprintHash: "runtime",
    gitCommitHash: sourceSha,
    buildProfile: "personal",
    channel: "personal-production",
    credentialsSource: "remote",
    cliVersion: "27.5.0",
    isGitWorkingTreeDirty: false,
    distribution: "store",
    username: "PRIVATE-CANARY",
  },
};
const expected = {
  platform: "android",
  sourceSha,
  runtimeVersion: "runtime",
  appVersion: "2.2.0",
  channel: "personal-production",
  minimumBuildVersion: "1008006",
};

it("captures the allocated native number without persisting the credential envelope", () => {
  const metadata = publicLocalMetadata(envelope);
  assert.equal(metadata.appBuildVersion, "1008007");
  assert.equal(JSON.stringify(metadata).includes("PRIVATE-CANARY"), false);
  assertLocalBuild(metadata, expected);
  const ios = publicLocalMetadata({
    ...envelope,
    job: { ...envelope.job, platform: "ios", version: { buildNumber: "1008007" } },
  });
  assertLocalBuild(ios, { ...expected, platform: "ios" });
  for (const change of [
    { appId: "PRIVATE-CANARY" },
    { version: { versionCode: "1008006" } },
    { platform: "PRIVATE-CANARY" },
  ]) {
    assert.throws(
      () => publicLocalMetadata({ ...envelope, job: { ...envelope.job, ...change } }),
      /^Invalid EAS local build metadata; credential-bearing input suppressed\.$/,
    );
  }
  for (const change of [
    { isGitWorkingTreeDirty: true },
    { credentialsSource: "local" },
    { distribution: "internal" },
    { simulator: true },
    { developmentClient: true },
    { gitCommitHash: "PRIVATE-CANARY" },
  ]) {
    assert.throws(
      () => publicLocalMetadata({ ...envelope, metadata: { ...envelope.metadata, ...change } }),
      /credential-bearing input suppressed/,
    );
  }
});

it("rejects different sources, runtimes, channels and non-increasing native numbers", () => {
  const metadata = publicLocalMetadata(envelope);
  for (const change of [
    { sourceSha: workflowSha },
    { runtimeVersion: "other" },
    { fingerprintHash: "other" },
    { channel: "personal-pilot" as const },
    { appVersion: "3.0.0" },
    { appBuildVersion: "1008006" },
    { appBuildVersion: "1008005" },
  ]) {
    assert.throws(
      () => assertLocalBuild({ ...metadata, ...change }, expected),
      /approved source\/runtime/,
    );
  }
});

it("recovers only the exact immutable artifact from its workflow SHA, including a retry of an older source", () => {
  const reference = { runId: "42", workflowSha, artifactName: "mobile-native-ios-v0.1.8-atli.4-2" };
  const artifact = {
    id: 77,
    name: reference.artifactName,
    expired: false,
    workflow_run: { id: 42, head_sha: workflowSha },
  };
  assert.equal(selectNativeArtifact([artifact], reference), artifact);
  assert.equal(selectNativeArtifact([artifact], { ...reference, artifactId: "77" }), artifact);
  assert.equal(selectNativeArtifact([artifact], { ...reference, artifactId: "78" }), undefined);
  assert.throws(() => selectNativeArtifact([artifact, artifact], reference), /Ambiguous/);
  assert.throws(
    () => selectNativeArtifact([artifact], { ...reference, workflowSha: sourceSha }),
    /provenance/,
  );
  assert.throws(
    () => selectNativeArtifact([artifact], { ...reference, runId: "43" }),
    /provenance/,
  );
  assert.throws(() => selectNativeArtifact([{ ...artifact, expired: true }], reference), /expired/);
  assert.equal(selectNativeArtifact([{ ...artifact, expired: true }], reference, true), undefined);
  assert.throws(
    () => selectNativeArtifact([artifact], { ...reference, workflowSha: sourceSha }, true),
    /provenance/,
  );
});

it("never repeats an ambiguous Apple upload, and reconciles the exact visible build without reupload", () => {
  const buildId = "github:42:2:ios";
  assert.equal(shouldUploadToApple([{ phase: "verified", buildId }], buildId, false), true);
  for (const phase of ["submitting", "submitted"]) {
    const history = [{ phase, buildId }];
    assert.throws(() => shouldUploadToApple(history, buildId, false), /may have succeeded/);
    assert.equal(shouldUploadToApple(history, buildId, true), false);
    assert.equal(shouldUploadToApple(history, "github:43:1:ios", false), true);
  }
});

it("checks the recovered bytes against the approved source and immutable binary digest", () => {
  const reference = { runId: "42", runAttempt: "2", workflowSha, artifactName: "native-ios" };
  const baseline = {
    buildId: "github:42:2:ios",
    github: reference,
    sourceSha,
    releaseTag: "v0.1.8-atli.4",
    profile: "personal" as const,
    appBuildVersion: "1008007",
    appVersion: "2.2.0",
    runtimeVersion: "runtime",
    artifact: {
      file: "app.ipa",
      sha256: "d".repeat(64),
      size: 10,
      url: "https://github.com/atlitech/skald-code/actions/runs/42",
    },
  };
  const approved = {
    reference,
    platform: "ios",
    sourceSha,
    tag: baseline.releaseTag,
    intent: {
      mode: "native" as const,
      appVersion: baseline.appVersion,
      runtimeVersion: baseline.runtimeVersion,
    },
    ...baseline.artifact,
  };
  assertRetainedNative(baseline, approved);
  for (const changed of [
    { ...approved, sha256: "e".repeat(64) },
    { ...approved, size: 11 },
  ]) {
    assert.throws(() => assertRetainedNative(baseline, changed), /digest/);
  }
  for (const changed of [
    { ...approved, sourceSha: workflowSha },
    { ...approved, file: "other.ipa" },
    { ...approved, reference: { ...reference, runAttempt: "3" } },
    { ...approved, intent: { ...approved.intent, runtimeVersion: "different" } },
  ]) {
    assert.throws(() => assertRetainedNative(baseline, changed), /metadata/);
  }
});
