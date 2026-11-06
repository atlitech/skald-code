import type { MenuAction } from "@react-native-menu/menu";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { getThreadListV2NewBranchMenuTitle } from "./thread-list-v2-row-appearance";
import { layoutThreadListV2RowMenuActions } from "./threadListV2";

export interface ThreadActionMenuState {
  readonly nested: boolean;
  readonly canOperate: boolean;
  readonly branch: string | null;
  readonly settled: boolean;
  readonly snoozed: boolean;
  readonly snoozable: boolean;
  readonly pinned: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isRegeneratingTitle: boolean;
  readonly canArchive: boolean;
  readonly canTurnIntoProject: boolean;
  readonly settlementSupported: boolean;
  readonly pinningSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly autoSettleOptOutSupported: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  readonly reorder?: { readonly canMoveUp: boolean; readonly canMoveDown: boolean };
}

export function buildThreadSnoozeMenuActions(presets: ReadonlyArray<SnoozePreset>): MenuAction[] {
  return [
    ...presets.map((preset) => ({
      id: `snooze:${preset.id}`,
      title: preset.label,
      subtitle: preset.whenLabel,
    })),
    { id: "snooze:custom", title: "Custom…" },
  ];
}

export function threadMenuActionRequiresOperate(id: string): boolean {
  return !["copy-thread", "copy-thread-id", "new-thread-on-branch"].includes(id);
}

export function buildThreadActionMenu(state: ThreadActionMenuState): MenuAction[] {
  const reorder: MenuAction[] =
    state.reorder && !state.snoozed
      ? [
          { id: "arrange", title: "Arrange threads…", image: "line.3.horizontal" },
          ...(!state.settled
            ? [
                {
                  id: "move-up",
                  title: "Move up",
                  image: "arrow.up",
                  attributes: { disabled: !state.reorder.canMoveUp },
                },
                {
                  id: "move-down",
                  title: "Move down",
                  image: "arrow.down",
                  attributes: { disabled: !state.reorder.canMoveDown },
                },
              ]
            : []),
        ]
      : [];
  const pin: MenuAction[] =
    state.pinningSupported && !state.snoozed
      ? [
          state.pinned
            ? { id: "unpin", title: "Unpin", image: "pin.slash" }
            : { id: "pin", title: "Pin", image: "pin" },
        ]
      : [];
  const autoSettle: MenuAction[] =
    state.autoSettleOptOutSupported && (state.settlementSupported || state.snoozed)
      ? [
          {
            id: "auto-settle",
            title: "Auto-settle behavior",
            image: "timer",
            subactions: [
              {
                id: "auto-settle:enabled",
                title: "Enabled",
                state: state.autoSettleEnabled ? "on" : "off",
              },
              {
                id: "auto-settle:disabled",
                title: "Disabled",
                state: state.autoSettleEnabled ? "off" : "on",
              },
            ],
          },
        ]
      : [];
  const title: MenuAction[] = [
    { id: "rename", title: "Rename", image: "square.and.pencil" },
    ...buildThreadTitleRegenerationMenuItems({
      supported: state.titleRegenerationSupported,
      isRegenerating: state.isRegeneratingTitle,
    }),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project",
            title: "Turn into project",
            image: "folder.badge.plus",
            attributes: { disabled: !state.canArchive },
          },
        ]
      : []),
  ];
  const archive: MenuAction = {
    id: "archive",
    title: "Archive",
    image: "archivebox",
    attributes: { disabled: !state.canArchive },
  };
  const lifecycle: MenuAction = state.snoozed
    ? { id: "unsnooze", title: "Wake thread", image: "clock" }
    : !state.settlementSupported
      ? archive
      : state.settled
        ? { id: "unsettle", title: "Un-settle", image: "arrow.uturn.backward" }
        : { id: "settle", title: "Settle", image: "checkmark" };
  const actions = layoutThreadListV2RowMenuActions({
    nested: state.nested,
    direct: [
      ...(state.branch
        ? [
            {
              id: "new-thread-on-branch",
              title: getThreadListV2NewBranchMenuTitle(state.branch),
              image: "square.and.pencil",
            },
          ]
        : []),
      { id: "copy-thread", title: "Copy thread", image: "text.bubble" },
      { id: "copy-thread-id", title: "Copy thread ID", image: "doc.on.doc" },
      lifecycle,
      ...(state.settlementSupported &&
      !state.settled &&
      !state.snoozed &&
      state.snoozeSupported &&
      state.snoozable
        ? [
            {
              id: "snooze",
              title: "Snooze",
              image: "clock",
              subactions: buildThreadSnoozeMenuActions(state.snoozePresets),
            },
          ]
        : []),
    ],
    reorder,
    pin,
    secondary: [
      ...title,
      ...autoSettle,
      ...(lifecycle.id === "archive" ? [] : [archive]),
      { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
    ],
  });
  const withPermissions = (items: MenuAction[]): MenuAction[] =>
    items.map((item) => ({
      ...item,
      ...(item.subactions
        ? { subactions: withPermissions(item.subactions) }
        : !state.canOperate && threadMenuActionRequiresOperate(item.id ?? "")
          ? { attributes: { ...item.attributes, disabled: true } }
          : {}),
    }));
  return state.canOperate ? actions : withPermissions(actions);
}
