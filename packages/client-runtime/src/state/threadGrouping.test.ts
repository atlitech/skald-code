import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadGrouping, getThreadGroupingParents } from "./threadGrouping.ts";

function thread(id: string, parent?: string | null) {
  return {
    id,
    environmentId: "local",
    projectId: "project",
    groupingParentThreadId: parent ?? null,
    archivedAt: null as string | null,
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: null,
      relationshipToParent: null,
    },
  };
}

describe("thread grouping", () => {
  it("nests independent threads without changing their order or execution lineage", () => {
    const root = thread("root");
    const first = thread("first", "root");
    const nested = thread("nested", "first");
    const second = thread("second", "root");
    const group = buildThreadGrouping([root, first, nested, second]);
    expect(group.roots).toEqual([root]);
    expect(group.childrenByParent.get("local:root")).toEqual([first, second]);
    expect(group.childrenByParent.get("local:first")).toEqual([nested]);
    expect(first.lineage.parentThreadId).toBeNull();
  });

  it.each(["missing", "archived", "deleted", "project", "environment", "subagent", "delegated"])(
    "keeps a child visible when its parent is %s",
    (state) => {
      const child = thread("child", "parent");
      const parent = {
        ...thread("parent"),
        delegatedFrom:
          state === "delegated"
            ? {
                environmentId: EnvironmentId.make("remote"),
                threadId: ThreadId.make("owner"),
                title: "Owner",
              }
            : null,
        archivedAt: state === "archived" ? "2026-11-06" : null,
        deletedAt: state === "deleted" ? "2026-11-06" : null,
        projectId: state === "project" ? "other" : "project",
        environmentId: state === "environment" ? "remote" : "local",
        lineage: {
          ...thread("parent").lineage,
          relationshipToParent: state === "subagent" ? ("subagent" as const) : null,
        },
      };
      expect(buildThreadGrouping(state === "missing" ? [child] : [parent, child]).roots).toContain(
        child,
      );
    },
  );

  it("detaches cycles while retaining their non-cyclic descendants and environment scopes", () => {
    const a = thread("a", "b");
    const b = thread("b", "a");
    const child = thread("child", "a");
    const self = thread("self", "self");
    const remote = { ...thread("a"), environmentId: "remote" };
    const group = buildThreadGrouping([a, b, child, self, remote]);
    expect(group.roots).toEqual([a, b, self, remote]);
    expect([...group.parentByChild]).toEqual([["local:child", "local:a"]]);
  });

  it("keeps active children visible outside a parked parent while grouping settled children", () => {
    const parent = { ...thread("parent"), settledOverride: "settled" as const };
    const active = thread("active", "parent");
    const settled = { ...thread("settled", "parent"), settledOverride: "settled" as const };
    const group = buildThreadGrouping([parent, active, settled]);
    expect(group.roots).toEqual([parent, active]);
    expect(group.childrenByParent.get("local:parent")).toEqual([settled]);
    expect(buildThreadGrouping([parent, active], { isParked: () => false }).roots).toEqual([
      parent,
    ]);
  });
});

it("excludes unsafe parent candidates using persisted ancestry, including unloaded ancestors", () => {
  const root = thread("root");
  const archived = { ...thread("archived", "root"), archivedAt: "2026-11-06" };
  const descendant = thread("descendant", "archived");
  const other = thread("other");
  const safeChild = thread("safe-child", "other");
  const unknown = thread("unknown", "unloaded");
  const cycleA = thread("cycle-a", "cycle-b");
  const cycleB = thread("cycle-b", "cycle-a");
  const remote = { ...thread("other"), environmentId: "remote" };
  const foreign = { ...thread("foreign"), projectId: "foreign" };
  const delegated = {
    ...thread("delegated"),
    delegatedFrom: {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("owner"),
      title: "Owner",
    },
  };
  for (const ancestors of [[archived], []]) {
    expect(
      getThreadGroupingParents(
        [
          root,
          ...ancestors,
          descendant,
          other,
          safeChild,
          unknown,
          cycleA,
          cycleB,
          remote,
          foreign,
          delegated,
        ],
        root,
      ),
    ).toEqual([other, safeChild]);
  }
  const safeArchived = { ...archived, groupingParentThreadId: other.id };
  expect(getThreadGroupingParents([root, safeArchived, descendant, other], root)).toEqual([
    descendant,
    other,
  ]);
  const deleted = { ...archived, deletedAt: "2026-11-06" };
  expect(getThreadGroupingParents([root, deleted, descendant], root)).toEqual([descendant]);
});
