import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { planGroupSettlementUndo } from "./threadUndo.ts";

function thread(id: string, parent: string | null = null) {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project"),
    groupingParentThreadId: parent === null ? null : ThreadId.make(parent),
    settledAt: null,
    settledOverride: null,
    pinnedAt: null,
    pinOrderKey: null,
    snoozedUntil: null,
    deletedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  };
}

it("undoes group settlement without reopening children that were already settled", () => {
  const parent = thread("parent");
  const active = { ...thread("active", "parent"), pinnedAt: "2026-11-07", pinOrderKey: "a0" };
  const finished = { ...thread("finished", "parent"), settledAt: "2026-11-06" };
  const grandchild = thread("grandchild", "finished");
  const plans = planGroupSettlementUndo(parent, [
    parent,
    active,
    finished,
    grandchild,
    thread("unrelated"),
    { ...thread("remote", "parent"), environmentId: EnvironmentId.make("remote") },
    { ...thread("foreign", "parent"), projectId: ProjectId.make("other") },
    { ...thread("deleted", "parent"), deletedAt: "2026-11-07" },
  ]);
  expect(plans.map(({ thread }) => thread.id)).toEqual(["parent", "active", "grandchild"]);
  expect(plans.find(({ thread }) => thread.id === "active")?.plan).toEqual([
    { action: "unsettle" },
    { action: "pin", orderKey: "a0" },
  ]);
});
