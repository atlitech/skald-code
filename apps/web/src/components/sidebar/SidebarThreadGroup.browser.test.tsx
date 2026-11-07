import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { buildThreadGrouping } from "@t3tools/client-runtime/state/thread-grouping";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarThreadGroup, useSidebarThreadGroups } from "./SidebarThreadGroup";

function GroupHarness(
  props: Parameters<typeof useSidebarThreadGroups>[0] & {
    thread: ReturnType<typeof makeThreadFixture>;
  },
) {
  const groupState = useSidebarThreadGroups(props);
  return (
    <ul>
      <SidebarThreadGroup
        {...props}
        section="active"
        groupState={groupState}
        renderRow={(thread, _section, _folder, group) => (
          <li>
            <span>{thread.title}</span>
            {group ? (
              <button
                onClick={group.onToggle}
                aria-label={`Toggle ${thread.title}`}
                aria-expanded={group.expanded}
              >
                {group.summary}
              </button>
            ) : null}
          </li>
        )}
      />
    </ul>
  );
}

it("reveals a selected descendant, permits explicit collapse, and keeps nested attention visible", async () => {
  const environmentId = EnvironmentId.make("nested-sidebar-test");
  const root = makeThreadFixture({ environmentId, id: ThreadId.make("root"), title: "Release" });
  const worker = makeThreadFixture({
    environmentId,
    id: ThreadId.make("worker"),
    title: "Layout",
    groupingParentThreadId: root.id,
    runtime: {
      status: "running",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-11-06T00:00:00Z",
    },
  });
  const child = makeThreadFixture({
    environmentId,
    id: ThreadId.make("child"),
    title: "Approval",
    groupingParentThreadId: worker.id,
    hasPendingApprovals: true,
  });
  const rootKey = `${environmentId}:${root.id}`;
  const workerKey = `${environmentId}:${worker.id}`;
  const childKey = `${environmentId}:${child.id}`;
  using storage = new DisposableStack();
  const storageKey = "t3code:sidebar:child-groups";
  const previous = localStorage.getItem(storageKey);
  storage.defer(() => {
    if (previous === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, previous);
  });
  localStorage.setItem(
    storageKey,
    JSON.stringify(
      Object.fromEntries(
        [rootKey, workerKey].map((key) => [
          key,
          { expanded: false, working: false, settled: false, snoozed: false },
        ]),
      ),
    ),
  );
  const grouping = buildThreadGrouping([root, worker, child]);
  const props = {
    thread: root,
    section: "active" as const,
    childrenByParent: grouping.childrenByParent,
    sectionByThreadKey: new Map([
      [rootKey, "active" as const],
      [workerKey, "working" as const],
      [childKey, "active" as const],
    ]),
    routeAncestors: new Set([rootKey, workerKey]),
    routeThreadKey: childKey,
    defaultWorkingExpanded: false,
  };
  const view = (routeThreadKey: string) => (
    <GroupHarness {...props} routeThreadKey={routeThreadKey} />
  );
  await using screen = await render(view(childKey));
  await expect.element(screen.getByText("Approval", { exact: true })).toBeVisible();
  const toggle = screen.getByRole("button", { name: "Toggle Release" });
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(toggle).toHaveTextContent("2 threads · 1 working · 1 needs you");
  await expect.element(screen.getByText("Approval", { exact: true })).not.toBeInTheDocument();
  await screen.rerender(view(workerKey));
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("Layout", { exact: true })).toBeVisible();
});
