import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { SidebarSection } from "../Sidebar.logic";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

export interface SidebarChildGroupControl {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly summary: string;
  readonly attention: boolean;
  readonly containsSelection: boolean;
}

const Expansion = Schema.Struct({
  expanded: Schema.Boolean,
  working: Schema.Boolean,
  snoozed: Schema.Boolean,
  settled: Schema.Boolean,
});

const Expansions = Schema.Record(Schema.String, Expansion);

export function useSidebarThreadGroups(input: {
  readonly childrenByParent: ReadonlyMap<string, readonly EnvironmentThreadShell[]>;
  readonly sectionByThreadKey: ReadonlyMap<string, SidebarSection>;
  readonly routeAncestors: ReadonlySet<string>;
  readonly routeThreadKey: string | null;
  readonly defaultWorkingExpanded: boolean;
}) {
  const [stored, setStored] = useLocalStorage("t3code:sidebar:child-groups", {}, Expansions);
  const [collapsed, setCollapsed] = useState<{
    routeKey: string | null;
    keys: ReadonlySet<string>;
  }>({ routeKey: input.routeThreadKey, keys: new Set() });
  const collapsedKeys =
    collapsed.routeKey === input.routeThreadKey ? collapsed.keys : new Set<string>();
  if (collapsed.routeKey !== input.routeThreadKey)
    setCollapsed({ routeKey: input.routeThreadKey, keys: collapsedKeys });
  const groups = new Map<
    string,
    {
      readonly expansion: typeof Expansion.Type;
      readonly visibleChildren: readonly EnvironmentThreadShell[];
      readonly containsSelection: boolean;
    }
  >();
  for (const [key, children] of input.childrenByParent) {
    const state = stored[key] ?? {
      expanded: true,
      working: input.defaultWorkingExpanded,
      snoozed: false,
      settled: false,
    };
    const expanded = state.expanded || (input.routeAncestors.has(key) && !collapsedKeys.has(key));
    const visibleChildren = expanded
      ? children.filter((thread) => {
          const childKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          const section = input.sectionByThreadKey.get(childKey) ?? "active";
          return (
            section === "active" ||
            section === "pinned" ||
            state[section] ||
            input.routeThreadKey === childKey ||
            input.routeAncestors.has(childKey)
          );
        })
      : [];
    groups.set(key, {
      expansion: { ...state, expanded },
      visibleChildren,
      containsSelection: input.routeAncestors.has(key),
    });
  }
  const toggle = (key: string, section: keyof typeof Expansion.Type) => {
    const current = groups.get(key)?.expansion;
    if (!current) return;
    if (section === "expanded") {
      const keys = new Set(collapsedKeys);
      if (current.expanded) keys.add(key);
      else keys.delete(key);
      setCollapsed({ routeKey: input.routeThreadKey, keys });
    }
    setStored({ ...stored, [key]: { ...current, [section]: !current[section] } });
  };
  return { groups, toggle };
}

type SidebarThreadGroupProps = {
  readonly thread: EnvironmentThreadShell;
  readonly section: SidebarSection;
  readonly childrenByParent: ReadonlyMap<string, readonly EnvironmentThreadShell[]>;
  readonly sectionByThreadKey: ReadonlyMap<string, SidebarSection>;
  readonly groupState: ReturnType<typeof useSidebarThreadGroups>;
  readonly navigationParent?: string | undefined;
  readonly folderRow?: string | undefined;
  readonly renderRow: (
    thread: EnvironmentThreadShell,
    section: SidebarSection,
    folderRow?: string,
    group?: SidebarChildGroupControl,
    navigationParent?: string,
  ) => ReactNode;
};

export function SidebarThreadGroup(props: SidebarThreadGroupProps) {
  const key = scopedThreadKey(scopeThreadRef(props.thread.environmentId, props.thread.id));
  if (!props.childrenByParent.has(key)) {
    return props.renderRow(
      props.thread,
      props.section,
      props.folderRow,
      undefined,
      props.navigationParent,
    );
  }
  return <ExpandedThreadGroup {...props} />;
}

function ExpandedThreadGroup(props: SidebarThreadGroupProps) {
  const key = scopedThreadKey(scopeThreadRef(props.thread.environmentId, props.thread.id));
  const group = props.groupState.groups.get(key)!;
  const { expansion, visibleChildren } = group;
  const children = props.childrenByParent.get(key) ?? [];
  const expanded = expansion.expanded;
  const active = children.filter((child) => {
    const section = props.sectionByThreadKey.get(
      scopedThreadKey(scopeThreadRef(child.environmentId, child.id)),
    );
    return section === "active" || section === "pinned";
  });
  const shelves = (["working", "snoozed", "settled"] as const).map((section) => ({
    section,
    children: children.filter(
      (child) =>
        props.sectionByThreadKey.get(
          scopedThreadKey(scopeThreadRef(child.environmentId, child.id)),
        ) === section,
    ),
  }));
  const working = children.filter(isThreadWorking).length;
  const descendants = [...children];
  let attention = 0;
  for (let index = 0; index < descendants.length; index += 1) {
    const child = descendants[index]!;
    if (
      child.hasPendingApprovals ||
      child.hasPendingUserInput ||
      child.pendingSubagentRequest != null
    )
      attention += 1;
    descendants.push(
      ...(props.childrenByParent.get(
        scopedThreadKey(scopeThreadRef(child.environmentId, child.id)),
      ) ?? []),
    );
  }
  const summary = [
    `${children.length} ${children.length === 1 ? "thread" : "threads"}`,
    ...(working > 0 ? [`${working} working`] : []),
    ...(attention > 0 ? [`${attention} needs you`] : []),
  ].join(" · ");
  const renderChild = (thread: EnvironmentThreadShell, navigationParent: string) => {
    const childKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    return (
      <SidebarThreadGroup
        key={childKey}
        {...props}
        thread={thread}
        section={props.sectionByThreadKey.get(childKey) ?? "active"}
        folderRow={undefined}
        navigationParent={navigationParent}
      />
    );
  };
  return (
    <>
      {props.renderRow(
        props.thread,
        props.section,
        props.folderRow,
        {
          expanded,
          onToggle: () => props.groupState.toggle(key, "expanded"),
          summary,
          attention: attention > 0,
          containsSelection: group.containsSelection,
        },
        props.navigationParent,
      )}
      {expanded ? (
        <li
          className="ml-2.5 list-none border-l border-sidebar-border/50 pl-1"
          data-thread-children={key}
        >
          <ul className="flex flex-col gap-px">
            {active.map((thread) => renderChild(thread, key))}
            {shelves.map(({ section, children: shelfChildren }) => {
              if (shelfChildren.length === 0) return null;
              const shelfKey = `children:${key}:${section}`;
              const visible = visibleChildren.filter(
                (child) =>
                  props.sectionByThreadKey.get(
                    scopedThreadKey(scopeThreadRef(child.environmentId, child.id)),
                  ) === section,
              );
              return (
                <li key={section} className="list-none">
                  <CollapsibleSectionHeader
                    size="compact"
                    data-sidebar-row={shelfKey}
                    data-sidebar-parent={key}
                    expanded={expansion[section]}
                    onClick={() => props.groupState.toggle(key, section)}
                    accessory={
                      <span className="font-normal tabular-nums">{shelfChildren.length}</span>
                    }
                  >
                    {section === "working"
                      ? "Working"
                      : section === "snoozed"
                        ? "Snoozed"
                        : "Settled"}
                  </CollapsibleSectionHeader>
                  <ul className="flex flex-col gap-px">
                    {visible.map((thread) => renderChild(thread, shelfKey))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </li>
      ) : null}
    </>
  );
}
