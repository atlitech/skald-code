// @effect-diagnostics nodeBuiltinImport:off - Vitest discovery runs outside the application runtime.
import * as NodePath from "node:path";
import { createVitest } from "vite-plus/test/node";

export async function shardedTestFiles(
  root: string,
  shard: string,
  filters?: ReadonlyArray<string>,
) {
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count) {
    throw new Error("Shard must be index/count with 1 <= index <= count");
  }
  if (filters?.length === 0) return [];
  const context = await createVitest("test", { root, watch: false, shard });
  try {
    const requested = filters && new Set(filters.map((file) => NodePath.resolve(root, file)));
    const files = (await context.globTestSpecifications(filters ? [...filters] : undefined)).filter(
      (file) => !requested || requested.has(NodePath.resolve(file.moduleId)),
    );
    if (requested) {
      const discovered = new Set(files.map((file) => NodePath.resolve(file.moduleId)));
      const missing = [...requested].filter((file) => !discovered.has(file));
      if (missing.length)
        throw new Error(`Selected tests were not discovered: ${missing.join(", ")}`);
    }
    const sequencer = new context.config.sequence.sequencer(context);
    const selected = await sequencer.shard(files);
    return selected.map((file) => NodePath.resolve(file.moduleId));
  } finally {
    await context.close();
  }
}
