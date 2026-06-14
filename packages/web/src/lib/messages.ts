import type { MessageListItem } from "../api";

/**
 * Whether `messageId` is still present in a (re)loaded page of messages.
 *
 * Used by the manual inbox refresh: when a refetch replaces the visible page in
 * place, the open message should stay selected only if it survived the reload —
 * otherwise the reading pane would point at a message that's no longer listed.
 */
export function isMessagePresent(
  messages: Pick<MessageListItem, "id">[],
  messageId: string | null | undefined,
): boolean {
  return messageId != null && messages.some((m) => m.id === messageId);
}
