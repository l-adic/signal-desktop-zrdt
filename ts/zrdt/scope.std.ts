// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// zrdt: the scope predicate (zrdt docs/APP.md §3, AMENDMENTS A7).
//
// One predicate, shared by the send path (ts/zrdt/send.preload.ts) and the
// receive path. A zrdt record is a GroupV2 DataMessage from the NormalMessage
// send job, with no storyContext, no reaction and no editedMessageTimestamp.
// Edits, deletes, reactions, polls, pins, the timer, profile-key updates and
// group changes are not records. 1:1 chats and Note-to-self are out.
//
// The receiver cannot see which send job produced a DataMessage, so "from the
// NormalMessage job" is expressed through the DataMessage itself: every field
// that only another job sets (delete, adminDelete, groupCallUpdate, the poll
// fields, pin/unpin, payment, giftBadge, a non-zero `flags`, a
// `groupV2.groupChange`) puts the message out of scope. The send side checks
// the same fields, so both sides agree on every message.
//
// The receiver ignores a `zrdt` field on any message that is out of scope.

/**
 * The DataMessage fields the predicate reads. Both `Proto.DataMessage`
 * (decoded) and `Proto.DataMessage.Params` fit; on the send side the
 * corresponding message options fit too. A field is "set" when it is neither
 * null nor undefined.
 */
export type ZrdtScopeDataMessageType = Readonly<{
  storyContext?: unknown;
  reaction?: unknown;
  delete?: unknown;
  adminDelete?: unknown;
  groupCallUpdate?: unknown;
  pollCreate?: unknown;
  pollVote?: unknown;
  pollTerminate?: unknown;
  pinMessage?: unknown;
  unpinMessage?: unknown;
  payment?: unknown;
  giftBadge?: unknown;
  flags?: number | null;
  groupV2?: Readonly<{ groupChange?: unknown; masterKey?: unknown }> | null;
}>;

export type ZrdtScopeInputType = Readonly<{
  /** The conversation (send) or the DataMessage's group context (receive) is GroupV2. */
  isGroupV2: boolean;
  /**
   * The message is an edit: `editedMessageTimestamp` on the send job, an
   * `EditMessage` (or a sync `editMessage`) on receive.
   */
  isEdit: boolean;
  /** A story (StoryMessage, or a story send). Stories are never records. */
  isStory?: boolean;
  dataMessage: ZrdtScopeDataMessageType;
}>;

function isSet(value: unknown): boolean {
  return value != null;
}

/** Why a message is not a record; `undefined` if it is one. For logs and tests. */
export function getZrdtOutOfScopeReason({
  isGroupV2,
  isEdit,
  isStory,
  dataMessage,
}: ZrdtScopeInputType): string | undefined {
  if (!isGroupV2) {
    return 'notGroupV2';
  }
  if (isEdit) {
    return 'edit';
  }
  if (isStory) {
    return 'story';
  }
  if (isSet(dataMessage.storyContext)) {
    return 'storyContext';
  }
  if (isSet(dataMessage.reaction)) {
    return 'reaction';
  }
  if (isSet(dataMessage.delete) || isSet(dataMessage.adminDelete)) {
    return 'delete';
  }
  if (isSet(dataMessage.groupCallUpdate)) {
    return 'groupCallUpdate';
  }
  if (
    isSet(dataMessage.pollCreate) ||
    isSet(dataMessage.pollVote) ||
    isSet(dataMessage.pollTerminate)
  ) {
    return 'poll';
  }
  if (isSet(dataMessage.pinMessage) || isSet(dataMessage.unpinMessage)) {
    return 'pin';
  }
  if (isSet(dataMessage.payment) || isSet(dataMessage.giftBadge)) {
    return 'payment';
  }
  // Expiration-timer updates, end-session and profile-key updates
  if (dataMessage.flags != null && dataMessage.flags !== 0) {
    return 'flags';
  }
  if (isSet(dataMessage.groupV2?.groupChange)) {
    return 'groupChange';
  }
  return undefined;
}

/** True if this message is a zrdt record (it carries, or must carry, ZrdtMeta). */
export function isZrdtRecordMessage(input: ZrdtScopeInputType): boolean {
  return getZrdtOutOfScopeReason(input) === undefined;
}
