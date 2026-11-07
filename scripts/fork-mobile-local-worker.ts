#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - EAS local worker boundary forwards its secret envelope only in memory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { assertLocalBuild, publicLocalMetadata } from "./lib/fork-mobile-local.ts";

try {
  const input = NodeProcess.env.EAS_LOCAL_BUILD_PLUGIN_INPUT;
  const output = NodeProcess.env.SKALD_LOCAL_METADATA_FILE;
  if (!input || !output) throw new Error("Missing local worker configuration.");
  const metadata = publicLocalMetadata(JSON.parse(Buffer.from(input, "base64").toString("utf8")));
  assertLocalBuild(metadata, {
    platform: NodeProcess.env.SKALD_LOCAL_PLATFORM ?? "",
    sourceSha: NodeProcess.env.SKALD_LOCAL_SHA ?? "",
    runtimeVersion: NodeProcess.env.SKALD_LOCAL_RUNTIME ?? "",
    appVersion: NodeProcess.env.SKALD_LOCAL_APP_VERSION ?? "",
    channel: NodeProcess.env.T3CODE_MOBILE_CHANNEL ?? "",
    minimumBuildVersion: NodeProcess.env.SKALD_LOCAL_MINIMUM_NUMBER ?? "0",
  });
  NodeFS.writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  const result = NodeChildProcess.spawnSync("npx", ["--yes", "eas-cli-local-build-plugin@27.5.0"], {
    env: NodeProcess.env,
    stdio: "inherit",
  });
  NodeProcess.exit(result.status ?? 1);
} catch {
  NodeProcess.stderr.write(
    "EAS local worker rejected its job; private credential payload suppressed.\n",
  );
  NodeProcess.exit(1);
}
