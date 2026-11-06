import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenu, type ThreadActionMenuState } from "./thread-action-menu";

const active: ThreadActionMenuState = {
  nested: false,
  canOperate: true,
  branch: null,
  settled: false,
  snoozed: false,
  snoozable: true,
  pinned: false,
  autoSettleEnabled: true,
  isRegeneratingTitle: false,
  canArchive: true,
  canTurnIntoProject: false,
  settlementSupported: true,
  pinningSupported: true,
  snoozeSupported: true,
  autoSettleOptOutSupported: true,
  titleRegenerationSupported: true,
  snoozePresets: [],
};

function leaves(items: ReadonlyArray<MenuAction>): MenuAction[] {
  return items.flatMap((item) => (item.subactions ? leaves(item.subactions) : [item]));
}

describe("buildThreadActionMenu", () => {
  it.each([false, true])("offers the matching pin action when pinned=%s", (pinned) => {
    const actions = buildThreadActionMenu({ ...active, pinned });
    expect(actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: pinned ? "unpin" : "pin" })]),
    );
    expect(actions.some((item) => item.id === (pinned ? "pin" : "unpin"))).toBe(false);
  });

  it("shares actions between chat and list, adding only list arrangement controls", () => {
    for (const nested of [false, true]) {
      const grouping = { canMove: true, hasParent: true };
      const chat = leaves(buildThreadActionMenu({ ...active, nested, grouping }));
      const list = leaves(
        buildThreadActionMenu({
          ...active,
          nested,
          grouping,
          reorder: { canMoveUp: false, canMoveDown: true },
        }),
      );
      const arrangement = new Set(["arrange", "move-up", "move-down"]);
      expect(list.filter((item) => !arrangement.has(item.id ?? ""))).toEqual(chat);
      expect(chat.some((item) => arrangement.has(item.id ?? ""))).toBe(false);
      expect(list.find((item) => item.id === "move-up")?.attributes?.disabled).toBe(true);
      expect(list.find((item) => item.id === "move-down")?.attributes?.disabled).toBe(false);
      expect(chat.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          "pin",
          "settle",
          "snooze:custom",
          "rename",
          "regenerate-title",
          "auto-settle:enabled",
          "auto-settle:disabled",
          "copy-thread",
          "copy-thread-id",
          "archive",
          "delete",
          "group-thread",
          "ungroup-thread",
        ]),
      );
      expect(chat.at(-1)).toMatchObject({ id: "delete", attributes: { destructive: true } });
      const root = leaves(
        buildThreadActionMenu({ ...active, nested, grouping: { canMove: true, hasParent: false } }),
      );
      expect(root.some((item) => item.id === "group-thread")).toBe(true);
      expect(root.some((item) => item.id === "ungroup-thread")).toBe(false);
    }
  });

  it.each([
    { settled: true, snoozed: false, expected: "unsettle", absent: ["settle", "snooze"] },
    {
      settled: false,
      snoozed: true,
      expected: "unsnooze",
      absent: ["settle", "snooze", "pin", "arrange"],
    },
    { settled: false, snoozed: false, expected: "settle", absent: ["unsettle", "unsnooze"] },
  ])(
    "offers $expected for the current lifecycle state",
    ({ settled, snoozed, expected, absent }) => {
      const actions = buildThreadActionMenu({ ...active, settled, snoozed });
      expect(actions.some((item) => item.id === expected)).toBe(true);
      expect(actions.some((item) => absent.includes(item.id ?? ""))).toBe(false);
    },
  );

  it("omits unsupported actions while keeping rename, copying, archive, and delete", () => {
    const actions = buildThreadActionMenu({
      ...active,
      settlementSupported: false,
      snoozeSupported: false,
      pinningSupported: false,
      titleRegenerationSupported: false,
      autoSettleOptOutSupported: false,
    });
    expect(actions.map((item) => item.id)).toEqual([
      "copy-thread",
      "copy-thread-id",
      "archive",
      "rename",
      "delete",
    ]);
  });

  it("keeps mutations disabled in nested read-only menus, with copying and navigation available", () => {
    const actions = leaves(
      buildThreadActionMenu({
        ...active,
        nested: true,
        canOperate: false,
        branch: "feature/mobile-actions",
        reorder: { canMoveUp: true, canMoveDown: true },
        grouping: { canMove: true, hasParent: true },
      }),
    );
    const readActions = new Set(["copy-thread", "copy-thread-id", "new-thread-on-branch"]);
    for (const item of actions) {
      expect(item.attributes?.disabled === true).toBe(!readActions.has(item.id ?? ""));
    }
  });

  it("honors busy state and auto-settle selection", () => {
    const actions = buildThreadActionMenu({
      ...active,
      snoozable: false,
      canArchive: false,
      canTurnIntoProject: true,
      isRegeneratingTitle: true,
      autoSettleEnabled: false,
      grouping: { canMove: false, hasParent: true },
    });
    expect(actions.some((item) => item.id === "snooze")).toBe(false);
    for (const id of [
      "archive",
      "turn-into-project",
      "regenerate-title",
      "group-thread",
      "ungroup-thread",
    ]) {
      expect(actions.find((item) => item.id === id)?.attributes?.disabled).toBe(true);
    }
    const flattened = leaves(actions);
    expect(flattened.find((item) => item.id === "auto-settle:enabled")?.state).toBe("off");
    expect(flattened.find((item) => item.id === "auto-settle:disabled")?.state).toBe("on");
  });
});
