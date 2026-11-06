// @effect-diagnostics nodeBuiltinImport:off - Hashes legacy fixture snapshots.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { RecoveryPoint } from "../recoveryPoint.ts";
import { snapshotDatabase } from "../servicePreflight.ts";

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const seedLegacyRecoveryPoint = Effect.fn("test.seedLegacyRecoveryPoint")(function* (input: {
  readonly baseDir: string;
  readonly dbPath: string;
  readonly fromVersion: string;
  readonly toVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const id = `${createdAt.replace(/[-:.]/g, "")}-${input.fromVersion}-to-${input.toVersion}`;
  const dir = path.join(input.baseDir, "recovery", "points", id);
  yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
  const snapshotPath = path.join(dir, "statev2.sqlite");
  yield* snapshotDatabase(input.dbPath, snapshotPath);
  yield* fs.chmod(snapshotPath, 0o600);
  const bytes = yield* fs.readFile(snapshotPath);
  const runtimePath = path.join(input.baseDir, "runtime", "versions", input.fromVersion);
  const archiveSha256 = yield* fs.readFileString(path.join(runtimePath, ".archive-sha256")).pipe(
    Effect.map((digest) => digest.trim().toLowerCase()),
    Effect.orElseSucceed(() => null),
  );
  const record: RecoveryPoint["record"] = {
    id,
    createdAt,
    from: { version: input.fromVersion, runtimePath, archiveSha256 },
    to: { version: input.toVersion },
    snapshot: {
      size: bytes.length,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    },
    actions: [],
  };
  yield* fs.writeFileString(path.join(dir, "recovery.json"), yield* encodeRecord(record), {
    mode: 0o600,
  });
  return Option.some<RecoveryPoint>({ id, dir, snapshotPath, record });
});
