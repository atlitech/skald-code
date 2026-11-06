import { RegistryContext } from "@effect/atom-react";
import {
  CommandId,
  EnvironmentId,
  OrchestrationV2DispatchCommandError,
  type AuthSessionState,
  ThreadId,
  type OrchestrationV2ListThreadGroupingParentsResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { environmentSession } from "../state/session";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { makeThreadFixture } from "../test-fixtures";
import { openThreadParentDialog, ThreadParentDialogHost } from "./ThreadParentDialog";

function deferredMove() {
  type Result = Awaited<ReturnType<typeof threadEnvironment.setParent.run>>;
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((resolveResult) => {
    resolve = resolveResult;
  });
  return { promise, resolve };
}

it("loads server parents, retries search and keeps a failed move open until retry succeeds", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("parent-picker"),
    threadId: ThreadId.make("child"),
  };
  const parentId = ThreadId.make("older-settled-parent");
  const target = { id: parentId, title: "Older release coordinator" };
  const shell = makeThreadFixture({
    environmentId: threadRef.environmentId,
    id: threadRef.threadId,
    title: "Connection tests",
  });
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(environmentThreadShells.threadShellAtom(threadRef), shell, {
        skipInitialRun: true,
      }),
    ],
  });
  using cleanup = new DisposableStack();
  cleanup.defer(() => registry.dispose());
  cleanup.defer(() => appAtomRegistry.reset());
  using _permission = vi
    .spyOn(threadEnvironment.setParent, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  using _session = vi.spyOn(environmentSession, "sessionStateAtom").mockReturnValue(
    Atom.make(
      AsyncResult.success<AuthSessionState>({
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["bearer-access-token"],
          sessionCookieName: "t3_session",
        },
      }),
    ),
  );
  let answer: AsyncResult.AsyncResult<OrchestrationV2ListThreadGroupingParentsResult, Error> =
    AsyncResult.initial(true);
  const queryAtom = Atom.make(() => answer);
  using query = vi
    .spyOn(orchestrationEnvironment, "listThreadGroupingParents")
    .mockImplementation(() => queryAtom);
  const firstMove = deferredMove();
  const retryMove = deferredMove();
  using move = vi
    .spyOn(threadEnvironment.setParent, "run")
    .mockImplementationOnce(() => firstMove.promise)
    .mockImplementationOnce(() => retryMove.promise);
  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <ThreadParentDialogHost />
    </RegistryContext.Provider>,
  );
  await act(() => openThreadParentDialog(threadRef));
  await expect.element(page.getByText("Finding threads…")).toBeVisible();
  await act(() => {
    answer = AsyncResult.fail(new Error("Connection interrupted"));
    registry.refresh(queryAtom);
  });
  await expect.element(page.getByRole("alert")).toHaveTextContent("Connection interrupted");
  answer = AsyncResult.success({ threads: [target], hasMore: true });
  await userEvent.click(page.getByRole("button", { name: "Retry", exact: true }));
  await expect.element(page.getByRole("button", { name: target.title })).toBeVisible();
  await expect
    .element(page.getByText("More threads are available. Refine your search."))
    .toBeVisible();
  using _timers = fakeTimers();
  await userEvent.fill(
    page.getByRole("textbox", { name: "Find a parent thread" }),
    "Older release",
  );
  await expect.element(page.getByText("Finding threads…")).toBeVisible();
  await act(() => vi.advanceTimersByTime(180));
  expect(query).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, query: "Older release" },
  });
  const candidate = page.getByRole("button", { name: target.title });
  await userEvent.click(candidate);
  await expect.element(candidate).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("textbox", { name: "Find a parent thread" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await act(() =>
    firstMove.resolve(
      AsyncResult.fail(
        new OrchestrationV2DispatchCommandError({
          commandId: CommandId.make("move-parent"),
          commandType: "thread.metadata.update",
          message: "The parent was archived. Try again.",
        }),
      ),
    ),
  );
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The parent was archived. Try again.");
  await expect.element(candidate).toBeEnabled();
  await userEvent.click(candidate);
  await expect.element(candidate).toBeDisabled();
  await act(() => retryMove.resolve(AsyncResult.success({ sequence: 1 })));
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(move).toHaveBeenCalledTimes(2);
  expect(move.mock.calls[1]?.[1]).toMatchObject({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, groupingParentThreadId: parentId },
  });
});
