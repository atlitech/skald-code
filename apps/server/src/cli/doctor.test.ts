import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";

it.effect(
  "--fix reclaims space with the service paused and keeps the V1 database, and --dry-run changes nothing",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const doctor = (dryRun: boolean, pruneEventsNow = false) =>
        runDoctor("/test/statev2.sqlite", {
          fix: true,
          dryRun,
          interactive: false,
          pruneEventsNow,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(BootService.BootService)({
                withStopped: (operation) =>
                  Effect.sync(() => calls.push("pause")).pipe(
                    Effect.andThen(operation),
                    Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                  ),
              }),
              Layer.mock(DatabaseMaintenance)({
                inspect: () =>
                  Effect.succeed({
                    databaseBytes: 2000,
                    reclaimableBytes: pruneEventsNow ? 0 : 1000,
                    incrementalVacuumEnabled: pruneEventsNow,
                    legacyDatabaseBytes: 4000,
                  }),
                compact: (_path, options) =>
                  Effect.sync(() => {
                    calls.push(options?.pruneEventsNow ? "compact now" : "compact");
                    return {
                      beforeBytes: 2000,
                      afterBytes: 1000,
                      deletedEventCount: 1,
                      deletedReceiptCount: 0,
                    };
                  }),
                removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
              }),
            ),
          ),
        );
      yield* doctor(true);
      assert.deepEqual(calls, []);
      yield* doctor(false);
      assert.deepEqual(calls, ["pause", "compact", "resume"]);
      calls.length = 0;
      yield* doctor(true, true);
      assert.deepEqual(calls, []);
      yield* doctor(false, true);
      assert.deepEqual(calls, ["pause", "compact now", "resume"]);
    }),
);

it.effect(
  "explicit pruning skips preview counts only when applying, and never selects full compaction",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(BootService.BootService)({
          withStopped: (operation) =>
            Effect.sync(() => calls.push("pause")).pipe(
              Effect.andThen(operation),
              Effect.ensuring(Effect.sync(() => calls.push("resume"))),
            ),
        }),
        Layer.mock(DatabaseMaintenance)({
          inspect: () =>
            Effect.succeed({
              databaseBytes: 2000,
              reclaimableBytes: 1000,
              incrementalVacuumEnabled: false,
              legacyDatabaseBytes: null,
            }),
          inspectDeletedThreads: () =>
            Effect.sync(() => {
              calls.push("preview");
              return {
                cutoff: "2026-10-01",
                eligibleThreadCount: 1,
                skippedThreadCount: 0,
                messageCount: 500,
                turnItemCount: 0,
                planCount: 0,
              };
            }),
          pruneDeletedThreads: (_path, days, budget) =>
            Effect.sync(() => {
              assert.equal(days, 7);
              assert.equal(budget, 1);
              calls.push("prune");
              return {
                beforeBytes: 2000,
                afterBytes: 2000,
                reclaimableBytes: 1000,
                deletedThreads: 0,
                deletedMessages: 250,
                deletedItems: 0,
                deletedPlans: 0,
                deletedPositions: 0,
                batches: 1,
                complete: false,
              };
            }),
          compact: () => Effect.die("Transcript pruning must never invoke full compaction"),
        }),
      );
      const options = { fix: true, interactive: false, pruneDeletedDays: 7, pruneMaxBatches: 1 };
      yield* runDoctor("/test/statev2.sqlite", { ...options, dryRun: true }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(calls, ["preview"]);
      yield* runDoctor("/test/statev2.sqlite", { ...options, fix: false, dryRun: false }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(calls, ["preview", "preview"]);
      yield* runDoctor("/test/statev2.sqlite", { ...options, dryRun: false }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(calls, ["preview", "preview", "pause", "prune", "resume"]);
    }),
);
