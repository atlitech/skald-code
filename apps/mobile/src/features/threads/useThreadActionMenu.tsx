import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { CommandId, isListedThreadLineage } from "@t3tools/contracts";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { useCallback, useState } from "react";
import { Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { threadCanArchive } from "../home/threadArchive";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { ThreadParentSheet } from "./ThreadParentSheet";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";
import {
  buildThreadActionMenu,
  buildThreadSnoozeMenuActions,
  threadMenuActionRequiresOperate,
  type ThreadActionMenuState,
} from "./thread-action-menu";
import {
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
} from "./threadListV2";
import type { ThreadMoveDestination } from "./threadOrder";

type ThreadAction = (thread: EnvironmentThreadShell) => void;

export function useThreadActionMenu(input: {
  readonly thread: EnvironmentThreadShell | null;
  readonly state: Pick<
    ThreadActionMenuState,
    | "canOperate"
    | "settled"
    | "snoozed"
    | "snoozable"
    | "settlementSupported"
    | "pinningSupported"
    | "snoozeSupported"
    | "autoSettleOptOutSupported"
    | "titleRegenerationSupported"
    | "reorder"
  >;
  readonly now: string;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly actions: {
    readonly newThreadOnBranch: ThreadAction;
    readonly settleThread: ThreadAction;
    readonly unsettleThread: ThreadAction;
    readonly unsnoozeThread: ThreadAction;
    readonly pinThread: ThreadAction;
    readonly unpinThread: ThreadAction;
    readonly archiveThread: ThreadAction;
    readonly renameThread: ThreadAction;
    readonly regenerateThreadTitle: ThreadAction;
    readonly confirmDeleteThread: ThreadAction;
    readonly setThreadAutoSettle: (thread: EnvironmentThreadShell, enabled: boolean) => void;
    readonly snoozeThread: (thread: EnvironmentThreadShell, until: string) => void;
    readonly moveThread?: (
      thread: EnvironmentThreadShell,
      direction: ThreadMoveDestination,
    ) => void;
  };
}) {
  const { thread, actions, state } = input;
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const canGroup = useAtomValue(
    threadEnvironment.setParent.permissionAtom(thread?.environmentId ?? null),
  );
  const setParent = useAtomCommand(threadEnvironment.setParent);
  const groupingSupported =
    thread !== null &&
    isListedThreadLineage(thread.lineage) &&
    configs.get(thread.environmentId)?.environment.capabilities.threadGrouping === true;
  const detachFromParent = useCallback(async () => {
    if (thread === null || !groupingSupported || !canGroup) return;
    const result = await setParent({
      environmentId: thread.environmentId,
      input: {
        type: "thread.metadata.update",
        commandId: CommandId.make(uuidv4()),
        threadId: thread.id,
        groupingParentThreadId: null,
      },
    });
    if (result._tag !== "Success")
      Dialog.alert("Could not move thread", "Try moving this thread again.");
  }, [thread, groupingSupported, canGroup, setParent]);
  const identity = thread ? `${thread.environmentId}:${thread.id}` : null;
  const [boundIdentity, setBoundIdentity] = useState(identity);
  // List recycling and chat navigation can change the thread without remounting.
  if (boundIdentity !== identity) {
    setBoundIdentity(identity);
    setCustomSnoozeOpen(false);
    setParentPickerOpen(false);
  }
  const presets = resolveThreadListV2SnoozePresets({
    secondary: state.snoozeSupported && state.snoozable ? "snooze" : null,
    now: input.now,
    presets: input.snoozePresets,
  });
  const menuActions = thread
    ? buildThreadActionMenu({
        ...state,
        nested: Platform.OS === "ios",
        branch: thread.branch,
        pinned: thread.pinnedAt != null,
        autoSettleEnabled: thread.autoSettleDisabledAt == null,
        isRegeneratingTitle: thread.titleRegeneration != null,
        canArchive: threadCanArchive(thread.runtime),
        canTurnIntoProject: canTurnThreadIntoProject(thread),
        snoozePresets: presets,
        ...(groupingSupported
          ? { grouping: { canMove: canGroup, hasParent: thread.groupingParentThreadId != null } }
          : {}),
      })
    : [];

  const handleAction = useCallback(
    (id: string) => {
      if (!thread || (!state.canOperate && threadMenuActionRequiresOperate(id))) return;
      switch (id) {
        case "group-thread":
          if (groupingSupported && canGroup) setParentPickerOpen(true);
          return;
        case "ungroup-thread":
          void detachFromParent();
          return;
        case "new-thread-on-branch":
          return actions.newThreadOnBranch(thread);
        case "settle":
          return actions.settleThread(thread);
        case "unsettle":
          return actions.unsettleThread(thread);
        case "unsnooze":
          return actions.unsnoozeThread(thread);
        case "pin":
          return actions.pinThread(thread);
        case "unpin":
          return actions.unpinThread(thread);
        case "auto-settle:enabled":
          return actions.setThreadAutoSettle(thread, true);
        case "auto-settle:disabled":
          return actions.setThreadAutoSettle(thread, false);
        case "arrange":
          appAtomRegistry.set(threadArrangementOpenAtom, true);
          return;
        case "move-up":
          return actions.moveThread?.(thread, "up");
        case "move-down":
          return actions.moveThread?.(thread, "down");
        case "archive":
          return actions.archiveThread(thread);
        case "rename":
          return actions.renameThread(thread);
        case "regenerate-title":
          return actions.regenerateThreadTitle(thread);
        case "turn-into-project":
          void turnThreadIntoProject(thread);
          return;
        case "copy-thread": {
          const target = threadChipCopyTarget(
            { environmentId: thread.environmentId, threadId: thread.id },
            thread.title,
          );
          void copyThreadReference(target).then((didCopy) => {
            if (!didCopy) Dialog.alert(target.failureTitle, "Try copying this thread again.");
          });
          return;
        }
        case "copy-thread-id":
          copyTextWithHaptic(thread.id, { target: "thread-id" });
          return;
        case "delete":
          return actions.confirmDeleteThread(thread);
        case "snooze:custom":
          setCustomSnoozeOpen(true);
          return;
      }
      const selection = resolveThreadListV2SnoozeMenuSelection({
        event: id,
        displayedPresets: presets,
        now: new Date(),
        presets: input.snoozePresets,
      });
      if (selection._tag === "selected")
        actions.snoozeThread(thread, selection.preset.snoozedUntil);
      else if (selection._tag === "expired")
        Dialog.alert(
          "Could not snooze thread",
          "That snooze time has passed. Choose another time.",
        );
    },
    [
      thread,
      actions,
      state.canOperate,
      presets,
      input.snoozePresets,
      groupingSupported,
      canGroup,
      detachFromParent,
    ],
  );
  return {
    menuActions,
    snoozePresetActions: buildThreadSnoozeMenuActions(presets),
    handleAction,
    handleMenuAction: ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) =>
      handleAction(nativeEvent.event),
    customSnoozeSheet:
      customSnoozeOpen && thread ? (
        <CustomSnoozeSheet
          onClose={() => setCustomSnoozeOpen(false)}
          onSnooze={(until) => actions.snoozeThread(thread, until)}
        />
      ) : null,
    parentPickerSheet:
      parentPickerOpen && thread ? (
        <ThreadParentSheet thread={thread} onClose={() => setParentPickerOpen(false)} />
      ) : null,
  };
}
