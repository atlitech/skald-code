import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { CommandId, type ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

export function ThreadParentSheet(props: {
  readonly thread: EnvironmentThreadShell;
  readonly onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const searchQuery = search.trim();
  const debouncedQuery = useDebouncedValue(searchQuery, 180);
  const parents = useEnvironmentQuery(
    orchestrationEnvironment.listThreadGroupingParents({
      environmentId: props.thread.environmentId,
      input: { threadId: props.thread.id, query: debouncedQuery },
    }),
  );
  const loading =
    searchQuery !== debouncedQuery ||
    parents.isPending ||
    (!parents.isSuccess && parents.error === null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = useAtomValue(
    threadEnvironment.setParent.permissionAtom(props.thread.environmentId),
  );
  const setParent = useAtomCommand(threadEnvironment.setParent, { reportFailure: false });
  const candidates = loading || parents.error !== null ? [] : (parents.data?.threads ?? []);
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
              maxLength={200}
              editable={!pending}
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
          loading ? (
            <AppText className="px-4 py-3 text-foreground-muted">Loading threads…</AppText>
          ) : parents.error !== null ? (
            <View className="gap-3 px-4 py-3">
              <AppText className="text-danger-foreground">Could not load parent threads.</AppText>
              <Button label="Try again" onPress={parents.refresh} />
            </View>
          ) : (
            <AppText className="px-4 py-3 text-foreground-muted">No matching threads</AppText>
          )
        }
        ListFooterComponent={
          !loading && parents.error === null && parents.data?.hasMore ? (
            <AppText className="px-4 py-3 text-foreground-muted">
              More threads are available. Refine your search to find them.
            </AppText>
          ) : undefined
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
