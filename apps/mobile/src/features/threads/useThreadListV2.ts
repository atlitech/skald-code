import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState, useSyncExternalStore } from "react";
import { buildThreadGrouping } from "@t3tools/client-runtime/state/thread-grouping";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { nestThreadListItems } from "./nestedThreadList";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  threadListInboxReturns,
  threadListV2LayoutTime,
} from "./threadListV2";
import { computeThreadMoveAvailability } from "./threadOrder";

/**
 * Screens' select handlers read the content-only key set; a fresh one per list rebuild gave
 * every row a new handler whenever any thread shell changed. Keyed by a string, the set keeps
 * its identity until its keys change.
 */
function useKeySet(newlineSeparatedKeys: string): ReadonlySet<string> {
  return useMemo(
    () => new Set(newlineSeparatedKeys.length === 0 ? [] : newlineSeparatedKeys.split("\n")),
    [newlineSeparatedKeys],
  );
}

type LayoutInput = Parameters<typeof buildThreadListV2Items>[0];

/**
 * The React Compiler drops unread dependencies, so pass the expired-grace version through
 * this call to keep inbox updates tied to its subscription.
 */
function observeInbox(
  threads: Parameters<typeof threadListInboxReturns.observe>[0],
  _expiredGraceVersion: number,
) {
  return threadListInboxReturns.observe(threads);
}

/**
 * Shelf callbacks prevent compiler caching across the whole derivation, so each stage keeps
 * its own memo boundary to preserve the list's identity during unrelated navigation renders.
 */
export function useThreadListV2(input: {
  readonly threads: LayoutInput["threads"];
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly searchQuery: string;
  /** Threads that match the search by content, keyed like `threadSearchMatchKey`. */
  readonly searchMatches: ReadonlyMap<string, unknown>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pinReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly activeReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly settledLimit: number;
  readonly now: string;
  readonly pendingOrder: LayoutInput["pendingOrder"];
  readonly shelfPreferencesLoaded: boolean;
  readonly workingShelfEnabled: boolean;
  readonly workingShelfExpanded: boolean;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
  readonly selectedThreadKey: string | null;
}) {
  const { threads, workingShelfEnabled } = input;
  const [groupOverrides, setGroupOverrides] = useState<{
    selection: string | null;
    values: ReadonlyMap<string, boolean>;
  }>(() => ({ selection: input.selectedThreadKey, values: new Map() }));
  const expandedGroups = useMemo(
    () =>
      groupOverrides.selection === input.selectedThreadKey
        ? groupOverrides.values
        : new Map<string, boolean>(),
    [groupOverrides, input.selectedThreadKey],
  );
  const [expandedShelves, setExpandedShelves] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const layoutTime = useMemo(
    () => threadListV2LayoutTime({ threads, now: input.now, searchQuery: input.searchQuery }),
    [threads, input.now, input.searchQuery],
  );
  const grouping = useMemo(() => {
    const scoped = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        (input.environmentId === null || thread.environmentId === input.environmentId) &&
        (input.projectRefs == null ||
          input.projectRefs.some(
            (ref) =>
              ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
          )),
    );
    return buildThreadGrouping(scoped, {
      isParked: (thread) =>
        effectiveSnoozed(thread, { now: layoutTime }) ||
        (thread.settledOverride === "settled" &&
          !input.queuedThreadKeys.has(`${thread.environmentId}:${thread.id}`)),
    });
  }, [threads, input.environmentId, input.projectRefs, layoutTime, input.queuedThreadKeys]);
  const attentionAncestors = useMemo(() => {
    const result = new Set<string>();
    for (const thread of threads) {
      if (
        !thread.hasPendingApprovals &&
        !thread.hasPendingUserInput &&
        !thread.pendingSubagentRequest
      )
        continue;
      let key = grouping.parentByChild.get(`${thread.environmentId}:${thread.id}`);
      while (key !== undefined && !result.has(key)) {
        result.add(key);
        key = grouping.parentByChild.get(key);
      }
    }
    return result;
  }, [threads, grouping]);
  const listedThreads = input.searchQuery.trim().length > 0 ? threads : grouping.roots;
  const selectedRootThreadKey = useMemo(() => {
    let key = input.selectedThreadKey;
    if (input.searchQuery.trim().length > 0) return key;
    while (key !== null) {
      const parent = grouping.parentByChild.get(key);
      if (parent === undefined) break;
      key = parent;
    }
    return key;
  }, [input.selectedThreadKey, input.searchQuery, grouping]);
  // A thread can stop working when the threads change, or when its exit grace expires.
  const inboxVersion = useSyncExternalStore(
    threadListInboxReturns.subscribe,
    threadListInboxReturns.getSnapshot,
  );
  const inbox = useMemo(
    () => observeInbox(workingShelfEnabled ? threads : null, inboxVersion),
    [threads, workingShelfEnabled, inboxVersion],
  );
  const { isWorking: inboxIsWorking, returnedAt: inboxReturnedAt } = inbox;
  // Compute move availability per section; per-row planning is quadratic.
  const moveAvailability = useMemo(() => {
    const sectionAvailability = (section: "pinned" | "active") =>
      computeThreadMoveAvailability({
        allThreads: threads,
        section,
        pendingOrder: input.pendingOrder,
        reorderableEnvironmentIds:
          section === "pinned" ? input.pinReorderEnvironmentIds : input.activeReorderEnvironmentIds,
        ordered: getThreadListV2OrderedSection({
          threads,
          section,
          pendingOrder: input.pendingOrder,
          now: layoutTime,
          settlementEnvironmentIds: input.settlementEnvironmentIds,
          snoozeEnvironmentIds: input.snoozeEnvironmentIds,
          queuedThreadKeys: input.queuedThreadKeys,
        }),
      });
    return new Map([
      ...sectionAvailability("pinned"),
      ...(workingShelfEnabled ? [] : sectionAvailability("active")),
    ]);
  }, [
    threads,
    input.pendingOrder,
    input.pinReorderEnvironmentIds,
    input.activeReorderEnvironmentIds,
    layoutTime,
    input.settlementEnvironmentIds,
    input.snoozeEnvironmentIds,
    input.queuedThreadKeys,
    workingShelfEnabled,
  ]);
  // Older settled threads load in pages; the shelf lists them only as far as they are loaded.
  const scopes = useMemo(
    () =>
      olderSettledScopes({
        environmentId: input.environmentId,
        projectRefs: input.projectRefs,
        settlementEnvironmentIds: input.settlementEnvironmentIds,
      }),
    [input.environmentId, input.projectRefs, input.settlementEnvironmentIds],
  );
  const olderSettledShelf = useOlderSettledShelf({
    scopes,
    expanded: input.settledShelfExpanded,
    // A search lists only matches, so the shelf would page forever; loaded pages stay.
    visibleCount: input.searchQuery.trim().length === 0 ? input.settledLimit : 0,
  });
  const { isListed, unloadedCount } = olderSettledShelf;
  const layout = useMemo(
    () =>
      buildThreadListV2Items({
        pendingOrder: input.pendingOrder,
        threads: listedThreads.filter((thread) => thread.archivedAt === null),
        environmentId: input.environmentId,
        projectRefs: input.projectRefs,
        searchQuery: input.searchQuery,
        matchedThreadKeys: new Set(input.searchMatches.keys()),
        settlementEnvironmentIds: input.settlementEnvironmentIds,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
        settledLimit: input.settledLimit,
        now: layoutTime,
        workingShelfEnabled,
        workingShelfExpanded: input.workingShelfExpanded,
        inboxReturnAt: inboxReturnedAt,
        isWorking: (thread) =>
          !attentionAncestors.has(`${thread.environmentId}:${thread.id}`) && inboxIsWorking(thread),
        snoozedShelfExpanded: input.snoozedShelfExpanded,
        settledShelfExpanded: input.settledShelfExpanded,
        selectedThreadKey: selectedRootThreadKey,
        isListedSettled: isListed,
        unloadedSettledCount: unloadedCount(
          threads.filter(
            (thread) =>
              thread.archivedAt === null &&
              scopes.some(
                (scope) =>
                  scope.environmentId === thread.environmentId &&
                  (scope.projectIds === null || scope.projectIds.includes(thread.projectId)),
              ),
          ),
        ),
      }),
    [
      input.pendingOrder,
      threads,
      listedThreads,
      input.environmentId,
      input.projectRefs,
      input.searchQuery,
      input.searchMatches,
      input.settlementEnvironmentIds,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      input.settledLimit,
      layoutTime,
      workingShelfEnabled,
      input.workingShelfExpanded,
      inboxReturnedAt,
      inboxIsWorking,
      attentionAncestors,
      input.snoozedShelfExpanded,
      input.settledShelfExpanded,
      selectedRootThreadKey,
      isListed,
      unloadedCount,
      scopes,
    ],
  );
  useOlderSettledShelfGrowth(olderSettledShelf, layout.listedSettledThreads);
  const contentOnlyThreadKeys = useKeySet([...layout.contentOnlyThreadKeys].sort().join("\n"));
  const pendingTasks = useMemo(() => {
    const scopedProjectKeys =
      input.projectRefs == null
        ? null
        : new Set(
            input.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)),
          );
    const searchQuery = input.searchQuery.trim().toLocaleLowerCase();
    return input.pendingTasks.filter(
      (pendingTask) =>
        (input.environmentId === null || pendingTask.environmentId === input.environmentId) &&
        (scopedProjectKeys === null ||
          scopedProjectKeys.has(
            scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
          )) &&
        (searchQuery.length === 0 || pendingTask.title.toLocaleLowerCase().includes(searchQuery)),
    );
  }, [input.projectRefs, input.searchQuery, input.pendingTasks, input.environmentId]);
  const items = useMemo(
    () =>
      buildThreadListV2ListItems({
        items: layout.items,
        pendingTasks,
        workingCount: layout.workingCount,
        workingShelfExpanded: input.workingShelfExpanded,
        workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
        snoozedCount: layout.snoozedCount,
        snoozedShelfExpanded: input.snoozedShelfExpanded,
        snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
        settledCount: layout.settledCount,
        settledShelfExpanded: input.settledShelfExpanded,
        settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
        snoozeLabelNow: `${input.now.slice(0, 16)}:00.000Z`,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
        moveAvailability,
        shelfPreferencesLoading: !input.shelfPreferencesLoaded,
      }),
    [
      layout,
      pendingTasks,
      input.workingShelfExpanded,
      input.snoozedShelfExpanded,
      input.settledShelfExpanded,
      input.now,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      moveAvailability,
      input.shelfPreferencesLoaded,
    ],
  );
  const nestedItems = useMemo(
    () =>
      input.searchQuery.trim().length > 0 || grouping.parentByChild.size === 0
        ? items
        : nestThreadListItems({
            items,
            grouping,
            layoutInput: {
              threads,
              environmentId: input.environmentId,
              projectRefs: input.projectRefs,
              searchQuery: "",
              now: layoutTime,
              workingShelfEnabled,
              settlementEnvironmentIds: input.settlementEnvironmentIds,
              snoozeEnvironmentIds: input.snoozeEnvironmentIds,
              queuedThreadKeys: input.queuedThreadKeys,
              selectedThreadKey: input.selectedThreadKey,
              isWorking: (thread) =>
                !attentionAncestors.has(`${thread.environmentId}:${thread.id}`) &&
                inboxIsWorking(thread),
              inboxReturnAt: inboxReturnedAt,
            },
            listInput: {
              pendingTasks: [],
              snoozeLabelNow: `${input.now.slice(0, 16)}:00.000Z`,
              snoozeEnvironmentIds: input.snoozeEnvironmentIds,
              queuedThreadKeys: input.queuedThreadKeys,
            },
            expandedGroups,
            expandedShelves,
          }),
    [
      items,
      grouping,
      threads,
      input.environmentId,
      input.projectRefs,
      input.searchQuery,
      layoutTime,
      workingShelfEnabled,
      input.settlementEnvironmentIds,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      input.selectedThreadKey,
      input.now,
      inboxIsWorking,
      attentionAncestors,
      inboxReturnedAt,
      expandedGroups,
      expandedShelves,
    ],
  );
  const toggleGroup = (key: string) => {
    const row = nestedItems.find(
      (item) =>
        item.type === "v2-thread" &&
        `${item.item.thread.environmentId}:${item.item.thread.id}` === key,
    );
    setGroupOverrides({
      selection: input.selectedThreadKey,
      values: new Map(expandedGroups).set(
        key,
        !(row?.type === "v2-thread" && row.childrenExpanded),
      ),
    });
  };
  const toggleGroupShelf = (key: string, expanded: boolean) =>
    setExpandedShelves((current) => new Map(current).set(key, !expanded));
  return {
    layout,
    items: nestedItems,
    contentOnlyThreadKeys,
    olderSettledShelf,
    toggleGroup,
    toggleGroupShelf,
  };
}

/** The list's scope per environment: its projects there, or every project. */
function olderSettledScopes(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<OlderSettledScope> {
  const environmentIds =
    input.environmentId === null ? [...input.settlementEnvironmentIds] : [input.environmentId];
  return environmentIds.flatMap((environmentId): ReadonlyArray<OlderSettledScope> => {
    if (input.projectRefs == null) return [{ environmentId, projectIds: null }];
    const projectIds = input.projectRefs.flatMap((ref) =>
      ref.environmentId === environmentId ? [ref.projectId] : [],
    );
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}
