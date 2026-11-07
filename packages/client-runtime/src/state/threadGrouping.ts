import {
  isListedThreadLineage,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2DelegatedFrom,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";

export type ThreadGroupSection = "pinned" | "active" | "working" | "snoozed" | "settled";

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

export function buildThreadGrouping<T extends GroupableThread>(threads: readonly T[]) {
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
      isThreadGroupingParent(parent)
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

export function resolveThreadGroupSections<
  T extends GroupableThread &
    Pick<
      EnvironmentThreadShell,
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "pendingSubagentRequest"
      | "pendingGuestMessageCount"
      | "hasActionableProposedPlan"
      | "interactionMode"
      | "latestRun"
      | "runtime"
    >,
>(
  grouping: ReturnType<typeof buildThreadGrouping<T>>,
  sections: ReadonlyMap<string, ThreadGroupSection>,
  workingShelfEnabled = true,
): ReadonlyMap<string, ThreadGroupSection> {
  const result = new Map(sections);
  const visit = (thread: T): { review: boolean; working: boolean; active: boolean } => {
    const key = `${thread.environmentId}:${thread.id}`;
    const own = sections.get(key) ?? "active";
    const parked = own === "settled" || own === "snoozed";
    let working =
      own === "working" || (workingShelfEnabled && own === "pinned" && isThreadWorking(thread));
    let review =
      !parked &&
      Boolean(
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.pendingSubagentRequest ||
        (thread.pendingGuestMessageCount ?? 0) > 0 ||
        (!working && (thread.hasActionableProposedPlan || thread.latestRun?.completedAt)),
      );
    let active = own === "active" || own === "pinned";
    const children = grouping.childrenByParent.get(key) ?? [];
    for (const child of children) {
      const state = visit(child);
      review ||= state.review;
      working ||= state.working;
      active ||= state.active;
    }
    if (children.length > 0 && own !== "pinned") {
      result.set(key, review ? "active" : working ? "working" : active ? "active" : own);
    }
    return { review, working, active };
  };
  for (const root of grouping.roots) visit(root);
  return result;
}
