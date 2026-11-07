import { DATABASE_COMPACTION_RECOMMENDED_BYTES } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : `${Math.ceil(bytes / 1024)} KiB`;

export const runDoctor = Effect.fn("runDoctor")(function* (
  databasePath: string,
  options: {
    readonly fix: boolean;
    readonly dryRun: boolean;
    readonly interactive?: boolean;
    readonly pruneDeletedDays?: number;
    readonly pruneMaxBatches?: number;
    readonly pruneEventsNow?: boolean;
  },
) {
  const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
  const status = yield* maintenance.inspect(databasePath);
  yield* Console.log(
    `Database: ${formatBytes(status.databaseBytes)}, ${formatBytes(status.reclaimableBytes)} reclaimable.`,
  );
  if (status.legacyDatabaseBytes !== null) {
    yield* Console.log(
      `Database from before 0.1.0: ${formatBytes(status.legacyDatabaseBytes)}, kept for rolling back.`,
    );
  }
  const pruning =
    options.pruneDeletedDays === undefined || (options.fix && !options.dryRun)
      ? undefined
      : yield* maintenance.inspectDeletedThreads(databasePath, options.pruneDeletedDays);
  if (pruning !== undefined) {
    yield* Console.log(
      `Deleted before ${pruning.cutoff}: ${pruning.eligibleThreadCount} threads eligible for batched transcript pruning (${pruning.messageCount} messages, ${pruning.turnItemCount} conversation/tool items, ${pruning.planCount} plans). ${pruning.skippedThreadCount} expired threads skipped because related history or unfinished work must be retained.`,
    );
  }
  const repairs = [
    ...(options.pruneDeletedDays === undefined || pruning?.eligibleThreadCount === 0
      ? []
      : [
          {
            id: "prune" as const,
            title: "Prune deleted-thread transcripts in batches",
            description:
              "Permanently removes eligible messages, tool output, and plans. Keeps execution records and deletion markers.\n  Pauses the server for a bounded pass. Commits small row batches and logs progress about every five seconds between batches. It does not run a full VACUUM or rebuild the search index.",
            recommended: true,
          },
        ]),
    ...(!options.pruneEventsNow &&
    (options.pruneDeletedDays !== undefined ||
      (status.incrementalVacuumEnabled && status.reclaimableBytes === 0))
      ? []
      : [
          {
            id: "database" as const,
            title: options.pruneEventsNow
              ? "Compact projected events now and reclaim database space"
              : "Reclaim database space",
            description: `${options.pruneEventsNow ? "Skips the 24-hour replay retention. Reconnecting clients with older cursors reload a snapshot.\n  " : ""}${
              status.incrementalVacuumEnabled
                ? "Returns unused space to disk."
                : "Returns unused space to disk and turns on automatic shrinking."
            }\n  Pauses the background service, if installed, while it runs and may need temporary disk space.`,
            recommended:
              options.pruneEventsNow ||
              !status.incrementalVacuumEnabled ||
              status.reclaimableBytes >= DATABASE_COMPACTION_RECOMMENDED_BYTES,
          },
        ]),
    ...(status.legacyDatabaseBytes === null
      ? []
      : [
          {
            id: "legacy" as const,
            title: "Delete the database from before 0.1.0",
            description: `Frees ${formatBytes(status.legacyDatabaseBytes)}. Your threads and settings are already in the current database.\n  Warning: after this, a T3 Code version before 0.1.0 starts with no threads or settings, so you can no longer roll back.`,
            recommended: false,
          },
        ]),
  ];
  if (repairs.length === 0) {
    yield* Console.log("Nothing to repair.");
    return;
  }
  for (const repair of repairs) {
    yield* Console.log(
      `\n${repair.title}${repair.recommended ? " (recommended)" : ""}\n  ${repair.description}`,
    );
  }
  if (options.dryRun) {
    yield* Console.log("\nDry run: nothing changed.");
    return;
  }
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.fix && !interactive) {
    yield* Console.log(
      "\nRun in a terminal to choose repairs, or pass --fix for the recommended ones.",
    );
    return;
  }
  const selected = options.fix
    ? repairs.filter((repair) => repair.recommended).map((repair) => repair.id)
    : yield* Prompt.run(
        Prompt.MultiSelect({
          message: "Choose repairs to run",
          choices: repairs.map((repair) => ({
            title: repair.title + (repair.recommended ? " (recommended)" : ""),
            value: repair.id,
            selected: repair.recommended,
          })),
        }),
      ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed([]) }));
  if (selected.length === 0) {
    yield* Console.log(
      options.fix
        ? "No recommended repairs; nothing changed."
        : "No repairs selected; nothing changed.",
    );
    return;
  }
  if (selected.includes("prune") && options.pruneDeletedDays !== undefined) {
    const service = yield* BootService.BootService;
    yield* Console.log("\nPruning deleted-thread transcripts in batches...");
    yield* service.withStopped(
      maintenance
        .pruneDeletedThreads(databasePath, options.pruneDeletedDays, options.pruneMaxBatches)
        .pipe(
          Effect.tap((result) =>
            Console.log(
              `Pass ${result.complete ? "complete" : "budget reached; rerun to continue"}: ${result.deletedThreads} threads finished, ${result.deletedMessages} messages, ${result.deletedItems} conversation/tool items, and ${result.deletedPlans} plans pruned in ${result.batches} batches. ${formatBytes(result.reclaimableBytes)} remains free for reuse; background shrinking requires incremental auto-vacuum.`,
            ),
          ),
        ),
    );
  }
  if (selected.includes("database")) {
    const service = yield* BootService.BootService;
    yield* Console.log("\nReclaiming database space. This can take several minutes...");
    // Report the repair before restarting, which can fail independently.
    yield* service.withStopped(
      maintenance
        .compact(databasePath, { pruneEventsNow: options.pruneEventsNow ?? false })
        .pipe(
          Effect.tap((result) =>
            Console.log(
              `Done: ${formatBytes(result.beforeBytes)} -> ${formatBytes(result.afterBytes)}, ${result.deletedEventCount} superseded events removed.`,
            ),
          ),
        ),
    );
  }
  if (selected.includes("legacy")) {
    // Only pre-0.1.0 servers use this file; removal refuses while they hold it open.
    yield* maintenance.removeLegacyDatabase(databasePath);
    yield* Console.log("\nDeleted the database from before 0.1.0.");
  }
});

export const doctorCommand = Command.make("doctor", {
  ...projectLocationFlags,
  fix: Flag.Boolean("fix").pipe(
    Flag.withDescription("Apply the recommended repairs without prompting."),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show the repairs without changing anything, even with --fix."),
    Flag.withDefault(false),
  ),
  pruneEventsNow: Flag.Boolean("prune-events-now").pipe(
    Flag.withDescription(
      "Compact projected events offline without waiting 24 hours. Older client cursors reload a snapshot. Includes database compaction.",
    ),
    Flag.withDefault(false),
  ),
  pruneMaxBatches: Flag.Int("prune-max-batches").pipe(
    Flag.withSchema(DatabaseMaintenance.PruneBatchLimit),
    Flag.withDescription(
      "Maximum committed transcript batches per pass (1–10000); each contains at most 250 rows.",
    ),
    Flag.withDefault(100),
  ),
  pruneDeletedDays: Flag.Int("prune-deleted-days").pipe(
    Flag.withSchema(DatabaseMaintenance.DeletedThreadRetentionDays),
    Flag.withDescription(
      "Also permanently prune transcripts of threads deleted at least this many days ago (minimum 1). Use --dry-run to inspect first.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Inspect this T3 Code data directory and repair it. Pauses and restarts the background service as needed.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      yield* runDoctor(config.dbPath, {
        fix: flags.fix,
        dryRun: flags.dryRun,
        pruneMaxBatches: flags.pruneMaxBatches,
        pruneEventsNow: flags.pruneEventsNow,
        ...Option.match(flags.pruneDeletedDays, {
          onNone: () => ({}),
          onSome: (pruneDeletedDays) => ({ pruneDeletedDays }),
        }),
      }).pipe(Effect.provide(Layer.merge(DatabaseMaintenance.layer, CliService.layer(config))));
    }),
  ),
);
