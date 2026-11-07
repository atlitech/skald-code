import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "DatabaseMaintenance",
  (it) => {
    it.effect("reports an unreadable database as an inspection failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-" }),
          "statev2.sqlite",
        );
        yield* fs.writeFileString(dbPath, "not a database");
        const failure = yield* Effect.flip(maintenance.inspect(dbPath));
        assert.equal(failure._tag, "DatabaseInspectError");
      }).pipe(Effect.scoped),
    );

    it.effect("reports and deletes only the database from before 0.1.0", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-" });
        const dbPath = path.join(userdata, "statev2.sqlite");
        const legacy = path.join(userdata, "state.sqlite");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);

        const openLegacy = NodeSqliteClient.layer({ filename: legacy });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`CREATE TABLE v1_data (value TEXT)`;
          yield* sql`INSERT INTO v1_data VALUES ('rollback')`;
        }).pipe(Effect.provide(openLegacy));
        assert.isAbove((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes ?? 0, 0);

        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM v1_data`;
          const failure = yield* Effect.flip(maintenance.removeLegacyDatabase(dbPath));
          assert.deepEqual(yield* sql`SELECT value FROM v1_data`, [{ value: "rollback" }]);
          return failure;
        }).pipe(Effect.provide(openLegacy));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.isTrue(yield* fs.exists(legacy));

        yield* Effect.flatMap(DatabaseMaintenance.DatabaseMaintenance, (service) =>
          service.removeLegacyDatabase(dbPath),
        ).pipe(
          Effect.provide(Layer.fresh(DatabaseMaintenance.layer)),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            remove: (target, options) =>
              Effect.gen(function* () {
                if (target === legacy) {
                  yield* Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`PRAGMA busy_timeout = 0`;
                    yield* sql`BEGIN EXCLUSIVE`;
                    yield* sql`COMMIT`;
                  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: legacy })));
                  // Create sidecars after the probe closes so only Doctor can remove them.
                  yield* fs.writeFileString(`${legacy}-wal`, "leftover WAL");
                  yield* fs.writeFileString(`${legacy}-shm`, "leftover SHM");
                }
                yield* fs.remove(target, options);
              }),
          }),
        );
        assert.isFalse(yield* fs.exists(legacy));
        assert.isFalse(yield* fs.exists(`${legacy}-wal`));
        assert.isFalse(yield* fs.exists(`${legacy}-shm`));
        assert.isTrue(yield* fs.exists(dbPath));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);
      }).pipe(Effect.scoped),
    );

    it.effect("compacts an existing database offline only once its server has stopped", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compact-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        // Opening the database migrates it.
        yield* Effect.void.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
          yield* sql`CREATE TABLE discarded_data (value BLOB)`;
          yield* sql`INSERT INTO discarded_data VALUES (zeroblob(4194304))`;
          yield* sql`DROP TABLE discarded_data`;
          yield* sql`
            INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
            )
            VALUES (
              'message-1', 'thread-1', NULL, NULL, 'user', 0,
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '{"text":"needle"}'
            )
          `;
          // An index that drifted from its rows, as a renumbering VACUUM would leave it.
          yield* sql`
            INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
            VALUES ('delete-all')
          `;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          yield* sql`INSERT INTO orchestration_v2_legacy_imports (
            thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
          ) VALUES ('imported', '2026-10-17', '2026-10-17', '2026-10-17', 0)`;
          yield* sql`WITH RECURSIVE history(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 51
          ) INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
          ) SELECT 'legacy-' || n, 'thread', 'imported', '2026-10-17', 0, 'accepted', 'legacy' FROM history`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        const sizeBefore = (yield* fs.stat(dbPath)).size;
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM retained_data`;
          for (const pruneEventsNow of [false, true]) {
            const failure = yield* maintenance
              .compact(dbPath, { pruneEventsNow })
              .pipe(Effect.flip);
            assert.equal(failure._tag, "DatabaseInUseError");
          }
          return yield* maintenance.compact(dbPath).pipe(Effect.flip);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

        const clock = yield* Clock.Clock;
        const pauses: number[] = [];
        let activeNanos = 0n;
        const result = yield* maintenance.compact(dbPath).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            // Exceed the background budget whenever the compactor checks elapsed time.
            monotonicTimeNanos: Effect.sync(() => (activeNanos += 30_000_000n)),
            sleep: (duration) =>
              Effect.sync(() => {
                pauses.push(Duration.toMillis(duration));
              }),
          }),
        );
        assert.deepEqual(pauses, [], "offline doctor must not throttle compaction");
        assert.equal(result.deletedReceiptCount, 51);
        assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
          assert.deepEqual(
            yield* sql`
              SELECT messages.message_id AS "messageId"
              FROM orchestration_v2_message_search AS search
              INNER JOIN orchestration_v2_projection_messages AS messages
                ON messages.rowid = search.rowid
              WHERE orchestration_v2_message_search MATCH '"needle"'
            `,
            [{ messageId: "message-1" }],
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
      }).pipe(Effect.scoped),
    );

    it.effect("prunes expired transcripts in batches without rebuilding the database", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-07T00:00:00.000Z"));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-prune-batches-" }),
          "statev2.sqlite",
        );
        yield* Effect.void.pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [threadId, deletedAt] of [
            ["old", "2026-09-01T00:00:00.000Z"],
            ["recent", "2026-11-01T00:00:00.000Z"],
          ] as const) {
            yield* sql`INSERT INTO orchestration_v2_projection_threads (
              thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
              created_at, updated_at, deleted_at, payload_json
            ) VALUES (${threadId}, 'project', ${threadId}, 'codex', 'full-access', 'default',
              ${deletedAt}, ${deletedAt}, ${deletedAt}, ${JSON.stringify({
                lineage: { rootThreadId: threadId },
                deletedAt,
              })})`;
            yield* sql`INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, role, streaming, created_at, updated_at, payload_json
            ) VALUES (${threadId}, ${threadId}, 'assistant', 0, ${deletedAt}, ${deletedAt}, '{"text":"needle"}')`;
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (${threadId}, ${threadId}, 1, 'assistant_message', 'completed', ${deletedAt}, '{}')`;
            yield* sql`INSERT INTO orchestration_v2_turn_item_positions VALUES (${threadId}, ${threadId}, 1)`;
            yield* sql`INSERT INTO orchestration_v2_projection_plans (
              plan_id, thread_id, node_id, kind, status, payload_json
            ) VALUES (${threadId}, ${threadId}, ${threadId}, 'todo', 'completed', '{}')`;
          }
          yield* sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 500)
            INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, role, streaming, created_at, updated_at, payload_json
            ) SELECT 'old-' || x, 'old', 'assistant', 0, '2026-09-01', '2026-09-01', '{"text":"needle"}' FROM n`;
          for (const id of ["protected-parent", "active-child", "pending"]) {
            yield* sql`INSERT INTO orchestration_v2_projection_threads (
              thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
              created_at, updated_at, deleted_at, payload_json
            ) VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default',
              '2026-09-01', '2026-09-01', ${id === "active-child" ? null : "2026-09-01"},
              ${JSON.stringify({ lineage: { rootThreadId: id === "active-child" ? "protected-parent" : id } })})`;
            yield* sql`INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, role, streaming, created_at, updated_at, payload_json
            ) VALUES (${id}, ${id}, 'assistant', 0, '2026-09-01', '2026-09-01', '{"text":"protected"}')`;
          }
          yield* sql`INSERT INTO orchestration_v2_effect_outbox (
            effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count,
            available_at, created_at, updated_at
          ) VALUES ('pending', 'pending', 'pending', 'attachment.cleanup', '{}', 'pending', 0,
            '2026-09-01', '2026-09-01', '2026-09-01')`;
          yield* sql`INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, status, requested_at, payload_json
          ) VALUES ('old-run', 'old', 1, 'codex', 'completed', '2026-09-01T00:00:00.000Z', '{}')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        const preview = yield* maintenance.inspectDeletedThreads(dbPath, 30);
        assert.equal(preview.eligibleThreadCount, 1);
        assert.equal(preview.messageCount, 501);
        assert.equal(preview.skippedThreadCount, 2);
        assert.equal(preview.turnItemCount, 1);
        assert.equal(preview.planCount, 1);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT * FROM orchestration_v2_projection_threads LIMIT 1`;
          assert.equal(
            (yield* Effect.flip(maintenance.pruneDeletedThreads(dbPath, 30)))._tag,
            "DatabaseInUseError",
          );
          assert.equal((yield* maintenance.inspectDeletedThreads(dbPath, 30)).messageCount, 501);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const first = yield* maintenance.pruneDeletedThreads(dbPath, 30, 1);
        assert.equal(first.deletedMessages, 250);
        assert.equal(first.deletedItems, 0);
        assert.equal(first.batches, 1);
        assert.isFalse(first.complete);
        assert.equal((yield* maintenance.inspectDeletedThreads(dbPath, 30)).messageCount, 251);
        const logs: unknown[] = [];
        const clock = yield* Clock.Clock;
        let nanos = 0n;
        const result = yield* maintenance.pruneDeletedThreads(dbPath, 30).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            monotonicTimeNanos: Effect.sync(() => (nanos += 6_000_000_000n)),
          }),
          Effect.provide(
            Logger.layer(
              [
                Logger.make(({ message }) => {
                  logs.push(message);
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        );
        assert.equal(result.deletedThreads, 1);
        assert.equal(result.deletedMessages, 251);
        assert.equal(result.deletedItems, 1);
        assert.equal(result.deletedPlans, 1);
        assert.equal(result.batches, 5);
        assert.isTrue(result.complete);
        const progressLogs = logs.filter(
          (entry) => Array.isArray(entry) && entry[0] === "Deleted-thread pruning progress",
        );
        assert.lengthOf(progressLogs, 5);
        assert.include(JSON.stringify(progressLogs.at(-1)), '"deletedMessages":251');
        assert.include(JSON.stringify(progressLogs.at(-1)), '"elapsedSeconds":30');
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT thread_id FROM orchestration_v2_projection_messages ORDER BY thread_id`,
            [
              { thread_id: "active-child" },
              { thread_id: "pending" },
              { thread_id: "protected-parent" },
              { thread_id: "recent" },
            ],
          );
          assert.deepEqual(yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`, [
            { run_id: "old-run" },
          ]);
          assert.deepEqual(
            yield* sql`SELECT messages.message_id AS "messageId"
              FROM orchestration_v2_message_search AS search
              JOIN orchestration_v2_projection_messages AS messages ON messages.rowid = search.rowid
              WHERE orchestration_v2_message_search MATCH '"needle"'`,
            [{ messageId: "recent" }],
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        assert.equal((yield* maintenance.pruneDeletedThreads(dbPath, 30)).batches, 0);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [id, size] of [
            ["large-1", 700_000],
            ["large-2", 700_000],
            ["oversized", 2_000_000],
          ] as const) {
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (${id}, 'old', 1, 'command_execution', 'completed', '2026-09-01',
              ${JSON.stringify({ output: "x".repeat(size) })})`;
          }
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        for (let pass = 0; pass < 3; pass++) {
          assert.equal((yield* maintenance.pruneDeletedThreads(dbPath, 30, 1)).deletedItems, 1);
        }
        assert.equal((yield* maintenance.inspectDeletedThreads(dbPath, 30)).eligibleThreadCount, 0);
        for (const budget of [0, -1, 1.5, 10001]) {
          assert.equal(
            (yield* Effect.flip(maintenance.pruneDeletedThreads(dbPath, 30, budget)))._tag,
            "DatabasePruneBudgetError",
          );
        }
        assert.equal(
          (yield* Effect.flip(maintenance.pruneDeletedThreads(dbPath, 0)))._tag,
          "DatabaseRetentionError",
        );
      }).pipe(Effect.scoped),
    );
  },
);
