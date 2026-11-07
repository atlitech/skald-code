import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadGrouping,
  resolveThreadGroupSections,
  type ThreadGroupSection,
} from "./threadGrouping.ts";

function thread(id: string, parent?: string | null) {
  return {
    id,
    environmentId: "local",
    projectId: "project",
    groupingParentThreadId: parent ?? null,
    archivedAt: null as string | null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    hasActionableProposedPlan: false,
    interactionMode: "default" as const,
    latestRun: null,
    runtime: null,
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

  it("keeps active and settled children attached to a settled parent", () => {
    const parent = { ...thread("parent"), settledOverride: "settled" as const };
    const active = thread("active", "parent");
    const settled = { ...thread("settled", "parent"), settledOverride: "settled" as const };
    const group = buildThreadGrouping([parent, active, settled]);
    expect(group.roots).toEqual([parent]);
    expect(group.childrenByParent.get("local:parent")).toEqual([active, settled]);
  });
});

it.each<{
  parent: ThreadGroupSection;
  child: ThreadGroupSection;
  attention?: boolean;
  expected: ThreadGroupSection;
}>([
  { parent: "working", child: "settled", expected: "working" },
  { parent: "settled", child: "working", expected: "working" },
  { parent: "active", child: "working", expected: "working" },
  { parent: "working", child: "working", expected: "working" },
  { parent: "working", child: "active", attention: true, expected: "active" },
  { parent: "settled", child: "active", attention: true, expected: "active" },
  { parent: "settled", child: "settled", expected: "settled" },
  { parent: "active", child: "settled", expected: "active" },
  { parent: "pinned", child: "working", expected: "pinned" },
  { parent: "pinned", child: "active", attention: true, expected: "pinned" },
  { parent: "snoozed", child: "snoozed", expected: "snoozed" },
])("places a $parent parent with a $child child in $expected (attention: $attention)", (row) => {
  const parent = thread("parent");
  const child = { ...thread("child", "parent"), hasPendingApprovals: row.attention ?? false };
  const sections = new Map<string, ThreadGroupSection>([
    ["local:parent", row.parent],
    ["local:child", row.child],
  ]);
  const result = resolveThreadGroupSections(buildThreadGrouping([parent, child]), sections);
  expect(result.get("local:parent")).toBe(row.expected);
  expect(result.get("local:child")).toBe(row.child);
  expect(sections.get("local:parent")).toBe(row.parent);
});

it("promotes nested work and review, then restores the settled group without changing thread state", () => {
  const parent = { ...thread("parent"), settledOverride: "settled" as const };
  const middle = { ...thread("middle", "parent"), settledOverride: "settled" as const };
  const leaf = thread("leaf", "middle");
  const worker = thread("worker", "parent");
  const completed = {
    ...leaf,
    latestRun: {
      runId: RunId.make("done"),
      status: "completed" as const,
      requestedAt: null,
      startedAt: null,
      completedAt: "2026-11-06T00:00:00Z",
      assistantMessageId: null,
    },
  };
  const sections = new Map<string, ThreadGroupSection>([
    ["local:parent", "settled"],
    ["local:middle", "settled"],
    ["local:leaf", "working"],
    ["local:worker", "working"],
  ]);
  const resolve = (child: typeof leaf | typeof completed) =>
    resolveThreadGroupSections(buildThreadGrouping([parent, middle, child, worker]), sections);
  expect(resolve(leaf).get("local:parent")).toBe("working");
  expect(resolve(leaf).get("local:middle")).toBe("working");
  sections.set("local:leaf", "active");
  expect(resolve(completed).get("local:parent")).toBe("active");
  expect(resolve(completed).get("local:middle")).toBe("active");
  sections.set("local:leaf", "settled");
  expect(resolve(completed).get("local:parent")).toBe("working");
  sections.set("local:worker", "settled");
  expect(resolve(completed).get("local:parent")).toBe("settled");
  expect(parent.settledOverride).toBe("settled");
  expect(middle.settledOverride).toBe("settled");
});
