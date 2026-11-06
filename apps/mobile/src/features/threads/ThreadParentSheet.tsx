import { buildThreadGrouping } from "@t3tools/client-runtime/state/thread-grouping";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { CommandId, type ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { useNavigationThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

export function ThreadParentSheet(props: {
  readonly thread: EnvironmentThreadShell;
  readonly onClose: () => void;
}) {
  const threads = useNavigationThreadShells();
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = useAtomValue(
    threadEnvironment.setParent.permissionAtom(props.thread.environmentId),
  );
  const setParent = useAtomCommand(threadEnvironment.setParent, { reportFailure: false });
  const grouping = buildThreadGrouping(threads, { isParked: () => false });
  const childKey = `${props.thread.environmentId}:${props.thread.id}`;
  const candidates = threads.filter((thread) => {
    if (
      thread.environmentId !== props.thread.environmentId ||
      thread.projectId !== props.thread.projectId ||
      thread.archivedAt !== null
    )
      return false;
    let cursor: string | undefined = `${thread.environmentId}:${thread.id}`;
    while (cursor !== undefined) {
      if (cursor === childKey) return false;
      cursor = grouping.parentByChild.get(cursor);
    }
    return thread.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  });
  const move = async (parent: ThreadId | null) => {
    if (pending || !allowed) return;
    setPending(true);
    setError(null);
    const result = await setParent({
      environmentId: props.thread.environmentId,
      input: {
        type: "thread.metadata.update",
        commandId: CommandId.make(uuidv4()),
        threadId: props.thread.id,
        groupingParentThreadId: parent,
      },
    });
    setPending(false);
    if (result._tag === "Success") props.onClose();
    else setError("Could not move this thread. Try again.");
  };
  return (
    <Sheet title="Move under thread" onClose={props.onClose} dismissDisabled={pending}>
      <FlatList
        data={candidates}
        keyExtractor={(thread) => thread.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 4 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View className="gap-3 pb-3">
            <TextInput
              accessibilityLabel="Search parent threads"
              placeholder="Search threads"
              value={search}
              onChangeText={setSearch}
              className="rounded-xl bg-subtle px-4 py-3 text-foreground"
            />
            {props.thread.groupingParentThreadId != null ? (
              <Pressable
                accessibilityRole="button"
                disabled={pending || !allowed}
                className="min-h-12 justify-center px-4"
                onPress={() => void move(null)}
              >
                <AppText>Move to top level</AppText>
              </Pressable>
            ) : null}
            {error ? <AppText className="text-danger-foreground">{error}</AppText> : null}
          </View>
        }
        ListEmptyComponent={
          <AppText className="px-4 py-3 text-foreground-muted">No matching threads</AppText>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            disabled={pending || !allowed}
            className="min-h-12 justify-center rounded-xl bg-subtle px-4 py-3"
            onPress={() => void move(item.id)}
          >
            <AppText>{item.title}</AppText>
          </Pressable>
        )}
      />
    </Sheet>
  );
}
