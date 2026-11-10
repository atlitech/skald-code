import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { rebuildMessageSearch } from "../orchestration-v2/messageSearchIndex.ts";
import {
  inspectDeletedThreadHistory,
  pruneDeletedThreadHistory,
  type DeletedThreadPruneSummary,
} from "./DeletedThreadPruning.ts";

export const DeletedThreadRetentionDays = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 36500 }),
);

export const PruneBatchLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 }));

export class DatabasePruneBudgetError extends Schema.TaggedError<DatabasePruneBudgetError>()(
  "DatabasePruneBudgetError",
  { maxBatches: Schema.Number },
) {
  override get message() {
    return "Pruning requires a batch limit between 1 and 10000.";
  }
}

export class DatabaseRetentionError extends Schema.TaggedError<DatabaseRetentionError>()(
  "DatabaseRetentionError",
  { days: Schema.Number },
) {
  override get message() {
    return "Deleted-thread retention must be a whole number of days between 1 and 36500.";
  }
}

export class DatabasePruneError extends Schema.TaggedError<DatabasePruneError>()(
  "DatabasePruneError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Deleted-thread pruning failed. Check the maintenance log and available disk space.";
  }
}

export class DatabaseMissingError extends Schema.TaggedError<DatabaseMissingError>()(
  "DatabaseMissingError",
  { path: Schema.String },
) {
  override get message() {
    return "No existing T3 Code database was found in this data directory.";
  }
}

export class DatabaseInUseError extends Schema.TaggedError<DatabaseInUseError>()(
  "DatabaseInUseError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Stop the T3 Code server and desktop app, including any version before 0.1.0, before repairing the database.";
  }
}

export class DatabaseInspectError extends Schema.TaggedError<DatabaseInspectError>()(
  "DatabaseInspectError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not read the database. Check that this user can open it.";
  }
}

export class DatabaseCompactError extends Schema.TaggedError<DatabaseCompactError>()(
  "DatabaseCompactError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Database compaction failed. Check that no other process has the database open and enough disk space is available.";
  }
}

export class LegacyDatabaseRemoveError extends Schema.TaggedError<LegacyDatabaseRemoveError>()(
  "LegacyDatabaseRemoveError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not delete the database from before 0.1.0. Check that this user can write to the data directory.";
  }
}

export class DiskSpaceCheckError extends Schema.TaggedError<DiskSpaceCheckError>()(
  "DiskSpaceCheckError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not check free disk space.";
  }
}

export class DatabaseMaintenance extends Context.Service<
  DatabaseMaintenance,
  {
    readonly inspect: (databasePath: string) => Effect.Effect<
      {
        readonly databaseBytes: number;
        readonly reclaimableBytes: number;
        readonly incrementalVacuumEnabled: boolean;
        /** Size of the database from before 0.1.0 still kept beside it, or null. */
        readonly legacyDatabaseBytes: number | null;
      },
      DatabaseMissingError | DatabaseInspectError
    >;
    readonly inspectDeletedThreads: (
      databasePath: string,
      days: number,
    ) => Effect.Effect<
      DeletedThreadPruneSummary,
      DatabaseMissingError | DatabaseInspectError | DatabaseRetentionError
    >;
    /** Deletes eligible transcript rows in committed batches without a full VACUUM. */
    readonly pruneDeletedThreads: (
      databasePath: string,
      days: number,
      maxBatches?: number,
    ) => Effect.Effect<
      DeletedThreadPruneResult,
      | DatabaseMissingError
      | DatabaseInUseError
      | DatabasePruneError
      | DatabaseRetentionError
      | DatabasePruneBudgetError
    >;
    /** Compacts history, then VACUUMs into incremental auto_vacuum. Refuses while a server has it open. */
    readonly compact: (
      databasePath: string,
      options?: { readonly pruneEventsNow?: boolean },
    ) => Effect.Effect<
      {
        readonly beforeBytes: number;
        readonly afterBytes: number;
        readonly deletedEventCount: number;
        readonly deletedReceiptCount: number;
      },
      DatabaseMissingError | DatabaseInUseError | DatabaseCompactError
    >;
    /** Deletes only the pre-0.1.0 database; earlier versions still use it. */
    readonly removeLegacyDatabase: (
      databasePath: string,
    ) => Effect.Effect<void, DatabaseInUseError | LegacyDatabaseRemoveError>;
  }
>()("t3/persistence/DatabaseMaintenance") {}

const isDomainError = Schema.is(Schema.Union([DatabaseMissingError, DatabaseInUseError]));
const isRetentionDays = Schema.is(DeletedThreadRetentionDays);
const isBatchLimit = Schema.is(PruneBatchLimit);

type DeletedThreadPruneResult = {
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly deletedThreads: number;
  readonly deletedMessages: number;
  readonly deletedItems: number;
  readonly deletedPlans: number;
  readonly batches: number;
  readonly complete: boolean;
  readonly deletedPositions: number;
  readonly reclaimableBytes: number;
};

const retentionCutoff = Effect.fn("DatabaseMaintenance.retentionCutoff")(function* (days: number) {
  if (!isRetentionDays(days)) return yield* new DatabaseRetentionError({ days });
  return DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days }));
});

const readStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  const pageSize = size[0]?.page_size ?? 0;
  return {
    databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
    reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
    incrementalVacuumEnabled: mode[0]?.auto_vacuum === 2,
  };
});

/**
 * Holds an exclusive lock on the connection's database. In WAL mode this is
 * refused while any other connection has the file open, even an idle one,
 * which is how a running server or desktop app is detected.
 */
const lockExclusively = Effect.fn("DatabaseMaintenance.lockExclusively")(function* (
  databasePath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA busy_timeout = 0`;
  yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
  yield* sql`BEGIN EXCLUSIVE`.pipe(
    Effect.mapError((cause) =>
      isSqlError(cause) && cause.reason._tag === "LockTimeoutError"
        ? new DatabaseInUseError({ path: databasePath, cause })
        : cause,
    ),
  );
  yield* sql`COMMIT`;
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const legacyPath = (databasePath: string) =>
    path.join(path.dirname(databasePath), "state.sqlite");

  const locate = Effect.fn("DatabaseMaintenance.locate")(function* (databasePath: string) {
    if (!(yield* fs.exists(databasePath))) {
      return yield* new DatabaseMissingError({ path: databasePath });
    }
  });

  const inspect = Effect.fn("DatabaseMaintenance.inspect")(
    function* (databasePath: string) {
      yield* locate(databasePath);
      const storage = yield* readStorage.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
      );
      const legacy = legacyPath(databasePath);
      const legacyDatabaseBytes = (yield* fs.exists(legacy))
        ? Number((yield* fs.stat(legacy)).size)
        : null;
      return { ...storage, legacyDatabaseBytes };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDomainError(cause) ? cause : new DatabaseInspectError({ path: databasePath, cause }),
        ),
      ),
  );

  const inspectDeletedThreads = Effect.fn("DatabaseMaintenance.inspectDeletedThreads")(
    function* (databasePath: string, days: number) {
      const cutoff = yield* retentionCutoff(days);
      yield* locate(databasePath);
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.logInfo("Inspecting deleted-thread pruning candidates", { cutoff });
        return yield* sql.withTransaction(inspectDeletedThreadHistory(sql, cutoff));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })));
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDomainError(cause) || cause._tag === "DatabaseRetentionError"
            ? cause
            : new DatabaseInspectError({ path: databasePath, cause }),
        ),
      ),
  );

  const pruneDeletedThreads = Effect.fn("DatabaseMaintenance.pruneDeletedThreads")(
    function* (databasePath: string, days: number, maxBatches = 100) {
      if (!isBatchLimit(maxBatches)) return yield* new DatabasePruneBudgetError({ maxBatches });
      const cutoff = yield* retentionCutoff(days);
      yield* locate(databasePath);
      const beforeBytes = Number((yield* fs.stat(databasePath)).size);
      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* lockExclusively(databasePath);
        yield* sql`PRAGMA cache_size = -8192`;
        yield* sql`PRAGMA temp_store = FILE`;
        yield* sql`PRAGMA wal_autocheckpoint = 1000`;
        const pruning = yield* pruneDeletedThreadHistory(sql, cutoff, maxBatches);
        const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        const pageSize = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
        return {
          ...pruning,
          reclaimableBytes: (free[0]?.freelist_count ?? 0) * (pageSize[0]?.page_size ?? 0),
        };
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
      return {
        beforeBytes,
        afterBytes: Number((yield* fs.stat(databasePath)).size),
        ...result,
      };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDomainError(cause) ||
          cause._tag === "DatabaseRetentionError" ||
          cause._tag === "DatabasePruneBudgetError"
            ? cause
            : new DatabasePruneError({ path: databasePath, cause }),
        ),
      ),
  );

  const compact = Effect.fn("DatabaseMaintenance.compact")(
    function* (databasePath: string, options?: { readonly pruneEventsNow?: boolean }) {
      yield* locate(databasePath);
      const beforeBytes = Number((yield* fs.stat(databasePath)).size);
      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* lockExclusively(databasePath);
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* Effect.logInfo("Compacting projected event history", {
          skipRetention: options?.pruneEventsNow ?? false,
        });
        const started = yield* Clock.monotonicTimeNanos;
        let lastReport = started;
        let slicesCompleted = 0;
        const reportProgress = Effect.gen(function* () {
          slicesCompleted++;
          const now = yield* Clock.monotonicTimeNanos;
          if (now - lastReport < 5_000_000_000n) return;
          lastReport = now;
          yield* Effect.logInfo("Event compaction progress", {
            slicesCompleted,
            elapsedSeconds: Number(now - started) / 1e9,
          });
        });
        const summary = yield* maintenance.pruneEventStore(reportProgress, {
          skipRetention: options?.pruneEventsNow ?? false,
        });
        yield* Effect.logInfo("Event compaction complete; rebuilding database", summary);
        // VACUUM is required to enable incremental auto_vacuum on existing databases.
        yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
        yield* sql`VACUUM`;
        yield* Effect.logInfo("Database rebuilt; rebuilding message search");
        yield* rebuildMessageSearch(sql);
        yield* Effect.logInfo("Message search rebuilt; checkpointing database");
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        return summary;
      }).pipe(
        Effect.provide(
          ProjectionMaintenance.layer.pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
          ),
        ),
      );
      const afterBytes = Number((yield* fs.stat(databasePath)).size);
      return {
        beforeBytes,
        afterBytes,
        deletedEventCount: result.deletedEventCount,
        deletedReceiptCount: result.deletedReceiptCount,
      };
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isDomainError(cause) ? cause : new DatabaseCompactError({ path: databasePath, cause }),
        ),
      ),
  );

  const removeLegacyDatabase = Effect.fn("DatabaseMaintenance.removeLegacyDatabase")(
    function* (databasePath: string) {
      const legacy = legacyPath(databasePath);
      if (!(yield* fs.exists(legacy))) return;
      // Delete the database before WAL to preserve commits if unlink fails.
      const removeFiles = Effect.forEach(
        ["", "-wal", "-shm"],
        (suffix) => fs.remove(legacy + suffix, { force: true }),
        { discard: true },
      );
      const connection = NodeSqliteClient.layer({ filename: legacy });
      if ((yield* HostProcess.Platform) === "win32") {
        // Windows blocks unlink while any SQLite handle is open, including our own.
        yield* lockExclusively(legacy).pipe(Effect.provide(connection));
        yield* removeFiles;
      } else {
        yield* lockExclusively(legacy).pipe(
          Effect.andThen(removeFiles),
          Effect.provide(connection),
        );
      }
    },
    (effect, databasePath) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "DatabaseInUseError"
            ? cause
            : new LegacyDatabaseRemoveError({ path: legacyPath(databasePath), cause }),
        ),
      ),
  );

  return DatabaseMaintenance.of({
    inspect,
    inspectDeletedThreads,
    pruneDeletedThreads,
    compact,
    removeLegacyDatabase,
  });
});

export const layer = Layer.effect(DatabaseMaintenance, make);

/** Settings' Reclaim writes the request; the failure stays for Settings until the next request. */
export const reclaimFiles = (path: Path.Path, databasePath: string) => ({
  request: path.join(path.dirname(databasePath), "reclaim-requested"),
  failure: path.join(path.dirname(databasePath), "reclaim-failed"),
});

/** Runs a repair that Settings requested. The server calls this on exit, once its database is closed. */
export const runRequestedReclaim = Effect.fn("DatabaseMaintenance.runRequestedReclaim")(
  function* (databasePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const files = reclaimFiles(yield* Path.Path, databasePath);
    if (!(yield* fs.exists(files.request))) return;
    // One attempt per request, so a repair killed midway (it rolls back) cannot delay later exits.
    yield* fs.remove(files.request, { force: true });
    yield* Effect.logInfo("Reclaiming database space before the restart. This can take minutes.");
    const maintenance = yield* DatabaseMaintenance;
    yield* maintenance.compact(databasePath).pipe(
      // Worker threads and agent processes can hold the file for a moment after the server stops.
      Effect.retry({
        times: 10,
        while: (error) => error._tag === "DatabaseInUseError",
        schedule: Schedule.spaced("1 second"),
      }),
      Effect.matchEffect({
        onSuccess: (result) =>
          fs
            .remove(files.failure, { force: true })
            .pipe(Effect.andThen(Effect.logInfo("Reclaimed database space", result))),
        onFailure: (error) =>
          fs
            .writeFileString(
              files.failure,
              error._tag === "DatabaseInUseError"
                ? "Another program kept the database open. Close other T3 Code apps and t3 commands on this machine, then try again."
                : error.message,
            )
            .pipe(
              Effect.andThen(Effect.logWarning("Database space reclamation failed", { error })),
            ),
      }),
    );
  },
  Effect.catchCause((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
);

// SQLite's search order for its temporary files (unixTempFileDir in os_unix.c).
const sqliteTempDirectory = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) === "win32") return NodeOS.tmpdir();
  const fs = yield* FileSystem.FileSystem;
  const env = yield* HostProcess.Environment;
  for (const directory of [env.SQLITE_TMPDIR, env.TMPDIR, "/var/tmp", "/usr/tmp", "/tmp"]) {
    if (directory === undefined || directory === "") continue;
    const info = yield* fs.stat(directory).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") continue;
    // SQLite skips directories it cannot write to and search: osAccess(zDir, 03).
    const usable = yield* Effect.tryPromise({
      try: () => NodeFSP.access(directory, NodeFSP.constants.W_OK | NodeFSP.constants.X_OK),
      catch: (cause) => new DiskSpaceCheckError({ path: directory, cause }),
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (usable) return directory;
  }
  return ".";
});

const freeBytes = (directory: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.statfs(directory),
    catch: (cause) => new DiskSpaceCheckError({ path: directory, cause }),
  }).pipe(Effect.map((stats) => stats.bavail * stats.bsize));

/**
 * VACUUM copies the live pages to a temporary file, then writes them again to the WAL.
 * Returns the free space the repair needs when either file system has less, else null.
 */
export const reclaimSpaceShortfall = Effect.fn("DatabaseMaintenance.reclaimSpaceShortfall")(
  function* (databasePath: string, liveBytes: number) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const databaseDirectory = path.dirname(databasePath);
    const tempDirectory = yield* sqliteTempDirectory;
    const copyBytes = Math.ceil(liveBytes * 1.1);
    const [databaseFree, tempFree, databaseDevice, tempDevice] = yield* Effect.all([
      freeBytes(databaseDirectory),
      freeBytes(tempDirectory),
      fs.stat(databaseDirectory).pipe(Effect.map((info) => info.dev)),
      fs.stat(tempDirectory).pipe(Effect.map((info) => info.dev)),
    ]);
    if (databaseDevice === tempDevice) {
      return databaseFree < 2 * copyBytes
        ? { neededBytes: 2 * copyBytes, freeBytes: databaseFree }
        : null;
    }
    if (databaseFree < copyBytes) return { neededBytes: copyBytes, freeBytes: databaseFree };
    return tempFree < copyBytes ? { neededBytes: copyBytes, freeBytes: tempFree } : null;
  },
);
