import { useAtomValue } from "@effect/atom-react";
import { CommandId, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useState } from "react";
import { create } from "zustand";

import { useThreadShell } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { useEnvironmentQuery } from "../state/query";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

const useRequest = create<{ threadRef: ScopedThreadRef | null }>(() => ({ threadRef: null }));

export function openThreadParentDialog(threadRef: ScopedThreadRef) {
  useRequest.setState({ threadRef });
}

export function useMoveThreadToTopLevel() {
  const move = useOrchestrationCommand(threadEnvironment.setParent, "Failed to move thread");
  return (threadRef: ScopedThreadRef) =>
    move({
      environmentId: threadRef.environmentId,
      input: {
        type: "thread.metadata.update",
        commandId: CommandId.make(randomUUID()),
        threadId: threadRef.threadId,
        groupingParentThreadId: null,
      },
    });
}

export function ThreadParentDialogHost() {
  const threadRef = useRequest((state) => state.threadRef);
  return threadRef ? (
    <ThreadParentDialog key={scopedThreadKey(threadRef)} threadRef={threadRef} />
  ) : null;
}

function ThreadParentDialog({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const canMove = useAtomValue(threadEnvironment.setParent.permissionAtom(threadRef.environmentId));
  const move = useOrchestrationCommand(threadEnvironment.setParent, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query.trim(), { wait: 180 });
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const parents = useEnvironmentQuery(
    orchestrationEnvironment.listThreadGroupingParents({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, ...(debouncedQuery ? { query: debouncedQuery } : {}) },
    }),
  );
  const searching = query.trim() !== debouncedQuery || parents.isPending;
  const candidates = parents.data?.threads ?? [];
  const close = () => useRequest.setState({ threadRef: null });
  const select = async (groupingParentThreadId: ThreadId) => {
    if (moving || searching || !canMove) return;
    setMoveError(null);
    setMoving(true);
    const result = await move({
      environmentId: threadRef.environmentId,
      input: {
        type: "thread.metadata.update",
        commandId: CommandId.make(randomUUID()),
        threadId: threadRef.threadId,
        groupingParentThreadId,
      },
    });
    setMoving(false);
    if (result._tag === "Success") {
      close();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setMoveError(error instanceof Error ? error.message : "Failed to move thread. Try again.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !moving) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Move under thread</DialogTitle>
          <DialogDescription>
            Choose a parent for “{thread?.title ?? "this thread"}” in this project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              placeholder="Find a thread…"
              aria-label="Find a parent thread"
              disabled={moving}
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {moveError ? (
              <p role="alert" className="text-sm text-destructive">
                {moveError}
              </p>
            ) : null}
            <div className="max-h-72 overflow-y-auto">
              {searching ? (
                <p role="status" className="py-4 text-sm text-muted-foreground">
                  Finding threads…
                </p>
              ) : parents.error ? (
                <div className="flex flex-col items-start gap-3 py-4">
                  <p role="alert" className="text-sm text-destructive">
                    {parents.error}
                  </p>
                  <Button variant="outline" size="sm" onClick={parents.refresh}>
                    Retry
                  </Button>
                </div>
              ) : candidates.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">No matching threads.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {candidates.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        disabled={!canMove || moving}
                        onClick={() => void select(candidate.id)}
                        className="flex w-full cursor-pointer items-center rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                      >
                        <span className="truncate">{candidate.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {!searching && parents.error === null && parents.data?.hasMore ? (
              <p className="text-xs text-muted-foreground">
                More threads are available. Refine your search.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={moving} onClick={close}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
