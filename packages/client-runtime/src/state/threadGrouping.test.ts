import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadGrouping } from "./threadGrouping.ts";

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

  it.each(["missing", "archived", "deleted", "project", "environment", "subagent"])(
    "keeps a child visible when its parent is %s",
    (state) => {
      const child = thread("child", "parent");
      const parent = {
        ...thread("parent"),
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
