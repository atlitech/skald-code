import {
  isListedThreadLineage,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2DelegatedFrom,
} from "@t3tools/contracts";

interface GroupableThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly groupingParentThreadId?: string | null;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly delegatedFrom?: OrchestrationV2DelegatedFrom | null | undefined;
  readonly lineage: OrchestrationV2AppThreadLineage;
}

function isThreadGroupingParent(
  thread: Pick<GroupableThread, "archivedAt" | "deletedAt" | "lineage" | "delegatedFrom">,
) {
  return (
    thread.archivedAt === null &&
    thread.deletedAt == null &&
    thread.delegatedFrom == null &&
    isListedThreadLineage(thread.lineage)
  );
}

export function buildThreadGrouping<T extends GroupableThread>(
  threads: readonly T[],
  options?: { readonly isParked?: (thread: T) => boolean },
) {
  const isParked = options?.isParked ?? ((thread: T) => thread.settledOverride === "settled");
  const byKey = new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread]));
  const parentByChild = new Map<string, string>();
  for (const [key, thread] of byKey) {
    if (thread.groupingParentThreadId == null) continue;
    const parentKey = `${thread.environmentId}:${thread.groupingParentThreadId}`;
    const parent = byKey.get(parentKey);
    if (
      parent !== undefined &&
      parentKey !== key &&
      parent.projectId === thread.projectId &&
      isThreadGroupingParent(parent) &&
      (!isParked(parent) || isParked(thread))
    ) {
      parentByChild.set(key, parentKey);
    }
  }
  const visited = new Set<string>();
  for (const key of parentByChild.keys()) {
    const path = new Map<string, number>();
    let cursor: string | undefined = key;
    while (cursor !== undefined && !visited.has(cursor) && !path.has(cursor)) {
      path.set(cursor, path.size);
      cursor = parentByChild.get(cursor);
    }
    const cycleStart = cursor === undefined ? undefined : path.get(cursor);
    for (const [member, index] of path) {
      visited.add(member);
      if (cycleStart !== undefined && index >= cycleStart) parentByChild.delete(member);
    }
  }
  const roots: T[] = [];
  const childrenByParent = new Map<string, T[]>();
  for (const [key, thread] of byKey) {
    const parent = parentByChild.get(key);
    if (parent === undefined) roots.push(thread);
    else {
      const children = childrenByParent.get(parent);
      if (children) children.push(thread);
      else childrenByParent.set(parent, [thread]);
    }
  }
  return { roots, childrenByParent, parentByChild };
}

export function getThreadGroupingParents<T extends GroupableThread>(
  threads: readonly T[],
  thread: GroupableThread,
) {
  const scoped = threads.filter((candidate) => candidate.environmentId === thread.environmentId);
  const byId = new Map(scoped.map((candidate) => [candidate.id, candidate]));
  return scoped.filter((candidate) => {
    if (!isThreadGroupingParent(candidate)) return false;
    const visited = new Set([thread.id]);
    let ancestor: T | undefined = candidate;
    while (ancestor !== undefined) {
      if (visited.has(ancestor.id)) return false;
      visited.add(ancestor.id);
      if (ancestor.deletedAt != null) return true;
      if (
        ancestor.projectId !== thread.projectId ||
        ancestor.delegatedFrom != null ||
        !isListedThreadLineage(ancestor.lineage)
      )
        return false;
      if (ancestor.groupingParentThreadId == null) return true;
      ancestor = byId.get(ancestor.groupingParentThreadId);
    }
    // Missing shells cannot prove that the persisted ancestry is safe.
    return false;
  });
}
