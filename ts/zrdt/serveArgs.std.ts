// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The SERVE request a responder builds for a member's ZrdtServeRequest
// (zrdt docs/JOIN_PLAN.md §4.3 step 3), without Signal: resend.preload.ts
// supplies the requester's key, the held openings and the host state. The
// group's own settings come from the conversation:
// - strict (user decision 3, §5): `zrdtStrict`, set per group in Settings →
//   Internal (or the CI hook); content is then released only in author-copy
//   entries;
// - this device's own `since` for the requester's account (§6.5):
//   `zrdtRemovedSince[requester]`.

import type {
  Bytes,
  Digest,
  ServeHeld,
  ServeMode,
  ServeRequest,
} from './ZrdtBackend.std.ts';

/** The conversation attributes SERVE reads. */
export type ZrdtServeConversationType = Readonly<{
  zrdtStrict?: boolean;
  zrdtRemovedSince?: Readonly<Record<string, ReadonlyArray<string>>>;
}>;

const HEX_DIGEST = /^[0-9a-f]{64}$/;

/** Whether this group answers in strict mode (off unless set). */
export function isZrdtStrict(conversation: ZrdtServeConversationType): boolean {
  return conversation.zrdtStrict === true;
}

function fromHex(hex: string): Bytes {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** This device's own `since` for an account (its heads when it saw it removed). */
export function ownSinceFor(
  conversation: ZrdtServeConversationType,
  requesterAci: string
): Array<Digest> {
  return (conversation.zrdtRemovedSince?.[requesterAci] ?? [])
    .filter(hex => HEX_DIGEST.test(hex))
    .map(fromHex);
}

/**
 * The SERVE request (without the chat key) for a member's request. Not an
 * export: `forExport` is false (exports build their own, ducks/zrdt).
 */
export function serveRequestFor({
  conversation,
  ownAci,
  requesterAci,
  requesterAciBytes,
  key,
  requestId,
  since,
  mode,
  wanted,
  live,
  disown,
  held,
}: Readonly<{
  conversation: ZrdtServeConversationType;
  ownAci: Bytes;
  requesterAci: string;
  requesterAciBytes: Bytes;
  key: Bytes;
  requestId: Bytes;
  since: ReadonlyArray<Digest>;
  mode: ServeMode;
  wanted: ReadonlyArray<Digest>;
  live: ReadonlyArray<Digest>;
  disown: ReadonlyArray<Digest>;
  held: ReadonlyArray<ServeHeld>;
}>): Omit<ServeRequest, 'chat'> {
  return {
    ownAci,
    requesterAci: requesterAciBytes,
    key,
    requestId,
    since,
    ownSince: ownSinceFor(conversation, requesterAci),
    mode,
    wanted: mode === 'perDigest' ? wanted : [],
    forExport: false,
    strict: isZrdtStrict(conversation),
    live,
    disown,
    held,
  };
}
