import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const BATCH_SIZE = 250;
const BATCH_BYTES = 1024 * 1024;
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

export interface DeletedThreadPruneSummary {
  readonly cutoff: string;
  readonly eligibleThreadCount: number;
  readonly skippedThreadCount: number;
  readonly messageCount: number;
  readonly turnItemCount: number;
  readonly planCount: number;
}

const candidateQuery = (sql: SqlClient.SqlClient, cutoff: string) => sql`
  WITH families AS MATERIALIZED (
    SELECT thread_id, deleted_at, updated_at,
      COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) AS root_id
    FROM orchestration_v2_projection_threads
  ), busy AS (
    SELECT thread_id FROM orchestration_v2_effect_outbox
    WHERE status NOT IN ('succeeded', 'cancelled')
    UNION SELECT thread_id FROM orchestration_v2_projection_runs
    WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      OR json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
    UNION SELECT thread_id FROM orchestration_v2_projection_runtime_requests
    WHERE status = 'pending'
    UNION SELECT thread_id FROM orchestration_v2_projection_subagents
    WHERE completion_delivery_state IN ('pending', 'claimed')
    UNION SELECT thread_id FROM scheduled_tasks WHERE thread_id IS NOT NULL
    UNION SELECT source_thread_id FROM orchestration_v2_projection_context_transfers
    WHERE status NOT IN ('consumed', 'superseded')
    UNION SELECT target_thread_id FROM orchestration_v2_projection_context_transfers
    WHERE status NOT IN ('consumed', 'superseded')
    UNION SELECT thread_id FROM orchestration_v2_projection_context_handoffs
    WHERE status = 'pending'
  ), blocked AS (
    SELECT root_id FROM families
    WHERE deleted_at IS NULL OR deleted_at >= ${cutoff} OR updated_at >= ${cutoff}
    UNION SELECT families.root_id FROM families JOIN busy USING (thread_id)
  )
  SELECT families.thread_id
  FROM families
  WHERE families.deleted_at < ${cutoff}
    AND NOT EXISTS (SELECT 1 FROM blocked WHERE blocked.root_id = families.root_id)
    AND (
      EXISTS (SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id = families.thread_id)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id = families.thread_id)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_plans WHERE thread_id = families.thread_id)
      OR EXISTS (SELECT 1 FROM projection_thread_messages WHERE thread_id = families.thread_id)
      OR EXISTS (SELECT 1 FROM orchestration_v2_turn_item_positions WHERE thread_id = families.thread_id)
    )
`;

const countSummary = Effect.fn("DeletedThreadPruning.countSummary")(function* (
  sql: SqlClient.SqlClient,
  cutoff: string,
) {
  const rows = yield* sql<{ readonly thread_id: string }>`
    ${candidateQuery(sql, cutoff)}
  `;
  const ids = rows.map((row) => row.thread_id);
  const encodedIds = yield* encodeIds(ids);
  if (ids.length === 0) {
    return {
      cutoff,
      eligibleThreadCount: 0,
      skippedThreadCount: 0,
      messageCount: 0,
      turnItemCount: 0,
      planCount: 0,
    };
  }
  const [messages, legacyMessages, items, plans] = yield* Effect.all(
    [
      sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id IN (SELECT value FROM json_each(${encodedIds}))`,
      sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id IN (SELECT value FROM json_each(${encodedIds}))`,
      sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items WHERE thread_id IN (SELECT value FROM json_each(${encodedIds}))`,
      sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_plans WHERE thread_id IN (SELECT value FROM json_each(${encodedIds}))`,
    ],
    { concurrency: "unbounded" },
  );
  return {
    cutoff,
    eligibleThreadCount: ids.length,
    skippedThreadCount: 0,
    messageCount: (messages[0]?.count ?? 0) + (legacyMessages[0]?.count ?? 0),
    turnItemCount: items[0]?.count ?? 0,
    planCount: plans[0]?.count ?? 0,
  };
});

const changes = Effect.fn("DeletedThreadPruning.changes")(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<{ readonly count: number }>`SELECT changes() AS count`;
  return rows[0]?.count ?? 0;
});

export const inspectDeletedThreadHistory = Effect.fn("DatabaseMaintenance.inspectDeletedHistory")(
  function* (sql: SqlClient.SqlClient, cutoff: string) {
    const summary = yield* countSummary(sql, cutoff);
    const allExpired = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads AS threads
    WHERE deleted_at < ${cutoff} AND (
      EXISTS (SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id = threads.thread_id)
      OR EXISTS (SELECT 1 FROM projection_thread_messages WHERE thread_id = threads.thread_id)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id = threads.thread_id)
      OR EXISTS (SELECT 1 FROM orchestration_v2_projection_plans WHERE thread_id = threads.thread_id)
      OR EXISTS (SELECT 1 FROM orchestration_v2_turn_item_positions WHERE thread_id = threads.thread_id)
    )
  `;
    return {
      ...summary,
      skippedThreadCount: Math.max(0, (allExpired[0]?.count ?? 0) - summary.eligibleThreadCount),
    };
  },
);

const transcriptTables = [
  {
    name: "orchestration_v2_projection_messages",
    payload: "payload_json",
    counter: "deletedMessages",
  },
  { name: "projection_thread_messages", payload: "text", counter: "deletedMessages" },
  {
    name: "orchestration_v2_projection_turn_items",
    payload: "payload_json",
    counter: "deletedItems",
  },
  { name: "orchestration_v2_projection_plans", payload: "payload_json", counter: "deletedPlans" },
  { name: "orchestration_v2_turn_item_positions", payload: null, counter: "deletedPositions" },
] as const;

export const pruneDeletedThreadHistory = Effect.fn("DatabaseMaintenance.pruneDeletedHistory")(
  function* (sql: SqlClient.SqlClient, cutoff: string, maxBatches: number) {
    const started = yield* Clock.monotonicTimeNanos;
    let lastReport = started;
    const progress = {
      deletedThreads: 0,
      deletedMessages: 0,
      deletedItems: 0,
      deletedPlans: 0,
      deletedPositions: 0,
      batches: 0,
    };
    yield* Effect.logInfo("Deleted-thread pruning: selecting candidates", { cutoff, maxBatches });
    yield* sql`CREATE TEMP TABLE deleted_thread_prune_candidates (thread_id TEXT PRIMARY KEY) WITHOUT ROWID`;
    yield* sql`INSERT INTO deleted_thread_prune_candidates ${candidateQuery(sql, cutoff)}`;
    const total = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM deleted_thread_prune_candidates`;
    const candidateThreads = total[0]?.count ?? 0;
    yield* Effect.logInfo("Deleted-thread pruning: candidates ready", { candidateThreads });
    let complete = false;
    yield* Effect.gen(function* () {
      while (progress.batches < maxBatches) {
        const threads = yield* sql<{ thread_id: string }>`SELECT thread_id
          FROM deleted_thread_prune_candidates ORDER BY thread_id LIMIT 1`;
        const thread = threads[0];
        if (thread === undefined) {
          complete = true;
          break;
        }
        for (const table of transcriptTables) {
          while (progress.batches < maxBatches) {
            const rows = yield* sql<{ id: number; bytes: number }>`
              SELECT rowid AS id, ${table.payload === null ? sql`0` : sql`octet_length(${sql(table.payload)})`} AS bytes
              FROM ${sql(table.name)} WHERE thread_id = ${thread.thread_id} LIMIT ${BATCH_SIZE}
            `;
            if (rows.length === 0) break;
            let bytes = 0;
            const ids: number[] = [];
            for (const row of rows) {
              // One oversized row must still make progress; never load its body into JavaScript.
              if (ids.length > 0 && bytes + row.bytes > BATCH_BYTES) break;
              ids.push(row.id);
              bytes += row.bytes;
            }
            const removed = yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM ${sql(table.name)} WHERE rowid IN ${sql.in(ids)}`;
                return yield* changes(sql);
              }),
            );
            progress[table.counter] += removed;
            progress.batches += 1;
            const now = yield* Clock.monotonicTimeNanos;
            if (progress.batches === 1 || now - lastReport >= 5_000_000_000n) {
              yield* Effect.logInfo("Deleted-thread pruning progress", {
                ...progress,
                table: table.name,
                candidateThreads,
                remainingThreads: candidateThreads - progress.deletedThreads,
                elapsedSeconds: Number(now - started) / 1e9,
              });
              lastReport = now;
            }
            yield* Effect.yieldNow;
          }
          if (progress.batches >= maxBatches) break;
        }
        if (progress.batches >= maxBatches) break;
        yield* sql`DELETE FROM deleted_thread_prune_candidates WHERE thread_id = ${thread.thread_id}`;
        progress.deletedThreads += 1;
      }
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const now = yield* Clock.monotonicTimeNanos;
          yield* Effect.logInfo("Deleted-thread pruning pass ended", {
            ...progress,
            complete,
            candidateThreads,
            remainingThreads: candidateThreads - progress.deletedThreads,
            elapsedSeconds: Number(now - started) / 1e9,
          });
        }),
      ),
    );
    yield* sql`DROP TABLE deleted_thread_prune_candidates`;
    return { ...progress, complete };
  },
);
