import { buildThreadGrouping } from "@t3tools/client-runtime/state/thread-grouping";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  type ThreadListV2ListItem,
} from "./threadListV2";

export type ThreadGrouping = ReturnType<typeof buildThreadGrouping<EnvironmentThreadShell>>;

export function nestThreadListItems(input: {
  readonly items: readonly ThreadListV2ListItem[];
  readonly grouping: ThreadGrouping;
  readonly layoutInput: Parameters<typeof buildThreadListV2Items>[0];
  readonly listInput: Omit<Parameters<typeof buildThreadListV2ListItems>[0], "items">;
  readonly expandedGroups: ReadonlyMap<string, boolean>;
  readonly expandedShelves: ReadonlyMap<string, boolean>;
}) {
  const rows: ThreadListV2ListItem[] = [];
  const selectedAncestors = new Set<string>();
  const selectedChildByParent = new Map<string, string>();
  let selected = input.layoutInput.selectedThreadKey ?? undefined;
  while (selected !== undefined) {
    const parent = input.grouping.parentByChild.get(selected);
    if (parent !== undefined) {
      selectedAncestors.add(parent);
      selectedChildByParent.set(parent, selected);
    }
    selected = parent;
  }
  const summaries = new Map<string, { count: number; working: number; attention: number }>();
  const summarize = (key: string): { count: number; working: number; attention: number } => {
    const cached = summaries.get(key);
    if (cached) return cached;
    let count = 0;
    let working = 0;
    let attention = 0;
    for (const child of input.grouping.childrenByParent.get(key) ?? []) {
      const nested = summarize(`${child.environmentId}:${child.id}`);
      count += 1 + nested.count;
      working += Number(isThreadWorking(child)) + nested.working;
      attention +=
        Number(
          Boolean(
            child.hasPendingApprovals || child.hasPendingUserInput || child.pendingSubagentRequest,
          ),
        ) + nested.attention;
    }
    const summary = { count, working, attention };
    summaries.set(key, summary);
    return summary;
  };
  const append = (items: readonly ThreadListV2ListItem[], depth: number, parentKey?: string) => {
    for (const item of items) {
      if (item.type !== "v2-thread") {
        rows.push(
          parentKey === undefined || item.type === "v2-pending"
            ? item
            : { ...item, key: `${parentKey}:${item.type}`, depth, groupingParentKey: parentKey },
        );
        continue;
      }
      const key = `${item.item.thread.environmentId}:${item.item.thread.id}`;
      const children = input.grouping.childrenByParent.get(key) ?? [];
      const expanded = input.expandedGroups.get(key) ?? selectedAncestors.has(key);
      rows.push({
        ...item,
        depth,
        groupingParentKey: parentKey,
        childCount: summarize(key).count,
        childWorkingCount: summarize(key).working,
        childAttentionCount: summarize(key).attention,
        childrenExpanded: expanded,
        containsSelection: selectedAncestors.has(key),
      });
      if (children.length === 0 || !expanded) continue;
      const workingShelfExpanded = input.expandedShelves.get(`${key}:v2-working-shelf`) ?? true;
      const snoozedShelfExpanded = input.expandedShelves.get(`${key}:v2-snoozed-shelf`) ?? false;
      const settledShelfExpanded = input.expandedShelves.get(`${key}:v2-settled-shelf`) ?? false;
      const layout = buildThreadListV2Items({
        ...input.layoutInput,
        threads: children,
        selectedThreadKey: selectedChildByParent.get(key) ?? null,
        pendingOrder: null,
        searchQuery: "",
        settledLimit: undefined,
        isListedSettled: undefined,
        unloadedSettledCount: 0,
        workingShelfExpanded,
        snoozedShelfExpanded,
        settledShelfExpanded,
      });
      append(
        buildThreadListV2ListItems({
          ...input.listInput,
          ...layout,
          pendingTasks: [],
          moveAvailability: undefined,
          workingShelfExpanded,
          snoozedShelfExpanded,
          settledShelfExpanded,
        }),
        depth + 1,
        key,
      );
    }
  };
  append(input.items, 0);
  return rows;
}
