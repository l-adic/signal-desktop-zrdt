// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// PLACEHOLDER (lane T2): lane T1 owns this file; on merge take T1's version
// if the two differ. Same name, same spec.
//
// The scope predicate (APP.md §3, AMENDMENTS A7), shared by send and receive:
// a record is a GroupV2 DataMessage from the NormalMessage send job, with no
// storyContext, no reaction and no editedMessageTimestamp. On receive that
// means: none of the fields another send job would set. The receiver ignores
// a `zrdt` field on anything else.

export type ZrdtScopeInput = Readonly<{
  groupV2?: { groupChange?: unknown } | null;
  storyContext?: unknown;
  reaction?: unknown;
  editedMessageTimestamp?: unknown;
  delete?: unknown;
  flags?: number | null;
  groupCallUpdate?: unknown;
  pollCreate?: unknown;
  pollVote?: unknown;
  pollTerminate?: unknown;
  pinMessage?: unknown;
  unpinMessage?: unknown;
  adminDelete?: unknown;
  isStory?: boolean;
}>;

function present(value: unknown): boolean {
  return value != null && value !== false && value !== 0;
}

export function isZrdtRecordMessage(message: ZrdtScopeInput): boolean {
  if (message.groupV2 == null) {
    return false;
  }
  if (present(message.groupV2.groupChange)) {
    return false;
  }
  return !(
    present(message.storyContext) ||
    present(message.reaction) ||
    present(message.editedMessageTimestamp) ||
    present(message.delete) ||
    present(message.flags) ||
    present(message.groupCallUpdate) ||
    present(message.pollCreate) ||
    present(message.pollVote) ||
    present(message.pollTerminate) ||
    present(message.pinMessage) ||
    present(message.unpinMessage) ||
    present(message.adminDelete) ||
    present(message.isStory)
  );
}
