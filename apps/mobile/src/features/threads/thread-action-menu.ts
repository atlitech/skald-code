import type { MenuAction } from "@react-native-menu/menu";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
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
  readonly grouping?: { readonly canMove: boolean; readonly hasParent: boolean };
}

export function buildThreadSnoozeMenuActions(
  presets: ReadonlyArray<SnoozePreset>,
  resolve: MessageResolver = m,
): MenuAction[] {
  return [
    ...presets.map((preset) => ({
      id: `snooze:${preset.id}`,
      title: preset.label,
      subtitle: preset.whenLabel,
    })),
    { id: "snooze:custom", title: resolve(msg("Custom…", { $context: "custom snooze time" })) },
  ];
}

export function threadMenuActionRequiresOperate(id: string): boolean {
  return !["copy-thread", "copy-thread-id", "new-thread-on-branch"].includes(id);
}

export function buildThreadActionMenu(
  state: ThreadActionMenuState,
  resolve: MessageResolver = m,
): MenuAction[] {
  const reorder: MenuAction[] =
    state.reorder && !state.snoozed
      ? [
          { id: "arrange", title: resolve(msg("Arrange threads…")), image: "line.3.horizontal" },
          ...(!state.settled
            ? [
                {
                  id: "move-up",
                  title: resolve(msg("Move up")),
                  image: "arrow.up",
                  attributes: { disabled: !state.reorder.canMoveUp },
                },
                {
                  id: "move-down",
                  title: resolve(msg("Move down")),
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
            ? {
                id: "unpin",
                title: resolve(msg("Unpin", { $context: "verb, thread action" })),
                image: "pin.slash",
              }
            : {
                id: "pin",
                title: resolve(msg("Pin", { $context: "verb, thread action" })),
                image: "pin",
              },
        ]
      : [];
  const autoSettle: MenuAction[] =
    state.autoSettleOptOutSupported && (state.settlementSupported || state.snoozed)
      ? [
          {
            id: "auto-settle",
            title: resolve(msg("Auto-settle behavior")),
            image: "timer",
            subactions: [
              {
                id: "auto-settle:enabled",
                title: resolve(msg("Follow settings")),
                state: state.autoSettleEnabled ? "on" : "off",
              },
              {
                id: "auto-settle:disabled",
                title: resolve(msg("Never", { $context: "never auto-settle this thread" })),
                state: state.autoSettleEnabled ? "off" : "on",
              },
            ],
          },
        ]
      : [];
  const title: MenuAction[] = [
    { id: "mark-unread", title: resolve(msg("Mark unread")), image: "envelope.badge" },
    {
      id: "rename",
      title: resolve(msg("Rename", { $context: "verb, thread action" })),
      image: "square.and.pencil",
    },
    ...buildThreadTitleRegenerationMenuItems(
      {
        supported: state.titleRegenerationSupported,
        isRegenerating: state.isRegeneratingTitle,
      },
      resolve,
    ),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project",
            title: resolve(msg("Turn into project")),
            image: "folder.badge.plus",
            attributes: { disabled: !state.canArchive },
          },
        ]
      : []),
  ];
  const archive: MenuAction = {
    id: "archive",
    title: resolve(msg("Archive", { $context: "verb, thread action" })),
    image: "archivebox",
    attributes: { disabled: !state.canArchive },
  };
  const lifecycle: MenuAction = state.snoozed
    ? { id: "unsnooze", title: resolve(msg("Wake thread")), image: "clock" }
    : !state.settlementSupported
      ? archive
      : state.settled
        ? {
            id: "unsettle",
            title: resolve(msg("Un-settle", { $context: "verb, thread action" })),
            image: "arrow.uturn.backward",
          }
        : {
            id: "settle",
            title: resolve(msg("Settle", { $context: "verb, thread action" })),
            image: "checkmark",
          };
  const actions = layoutThreadListV2RowMenuActions(
    {
      nested: state.nested,
      direct: [
        ...(state.branch
          ? [
              {
                id: "new-thread-on-branch",
                title: getThreadListV2NewBranchMenuTitle(state.branch, resolve),
                image: "square.and.pencil",
              },
            ]
          : []),
        { id: "copy-thread", title: resolve(msg("Copy thread")), image: "text.bubble" },
        { id: "copy-thread-id", title: resolve(msg("Copy thread ID")), image: "doc.on.doc" },
        lifecycle,
        ...(state.settlementSupported &&
        !state.settled &&
        !state.snoozed &&
        state.snoozeSupported &&
        state.snoozable
          ? [
              {
                id: "snooze",
                title: resolve(msg("Snooze", { $context: "verb, thread action" })),
                image: "clock",
                subactions: buildThreadSnoozeMenuActions(state.snoozePresets, resolve),
              },
            ]
          : []),
      ],
      reorder,
      pin,
      secondary: [
        ...title,
        ...(state.grouping
          ? [
              {
                id: "group-thread",
                title: resolve(msg("Move under thread…")),
                image: "folder",
                attributes: { disabled: !state.grouping.canMove },
              },
              ...(state.grouping.hasParent
                ? [
                    {
                      id: "ungroup-thread",
                      title: resolve(msg("Move to top level")),
                      image: "arrow.up",
                      attributes: { disabled: !state.grouping.canMove },
                    },
                  ]
                : []),
            ]
          : []),
        ...autoSettle,
        ...(lifecycle.id === "archive" ? [] : [archive]),
        {
          id: "delete",
          title: resolve(msg("Delete", { $context: "verb, thread action" })),
          image: "trash",
          attributes: { destructive: true },
        },
      ],
    },
    resolve,
  );
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
