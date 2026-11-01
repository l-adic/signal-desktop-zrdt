// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// zrdt: host-side types for the transcript-consistency layer (APP.md §3, §5, §6).
//
// Encoding rules for message attributes (they are stored as JSON):
// - 32-byte values (digests, links, nonce) are lowercase hex strings;
// - byte blobs (contentBytes, zrdtOpening) are base64 strings.
// The SQL tables (`zrdt_records`, `zrdt_pending`, `zrdt_provenance`) store raw
// bytes (BLOB); never put zrdt bytes in `items` (APP.md §6).

import type { AciString } from './ServiceId.std.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';

// --- SQL rows -----------------------------------------------------------------

// Host state, trusted (PLAN.md §3.5, AMENDMENTS A8). Upgrade order:
// imported < relayed < live.
export type ZrdtProvenanceKind = 'live' | 'relayed' | 'imported';

// One accepted record (structure only, never plaintext). `digest` is the
// 32-byte SHA-256 the daemon returned in ACCEPTED; `record` is the encoded
// record (`"zrdt2" ‖ group ‖ commit ‖ nlinks ‖ links ‖ author`).
export type ZrdtRecordRowType = Readonly<{
  conversationId: string;
  digest: Uint8Array<ArrayBuffer>;
  record: Uint8Array<ArrayBuffer>;
}>;

// A record whose links did not resolve yet (ACCEPT replied MISSING).
// `digest` = HASH(record); `messageId` is the message row that carried it, if
// any (a structure-only relay has none).
export type ZrdtPendingRowType = Readonly<{
  conversationId: string;
  digest: Uint8Array<ArrayBuffer>;
  record: Uint8Array<ArrayBuffer>;
  messageId: string | null;
}>;

export type ZrdtProvenanceRowType = Readonly<{
  conversationId: string;
  digest: Uint8Array<ArrayBuffer>;
  kind: ZrdtProvenanceKind;
  // For 'relayed': the member who relayed it. Null otherwise.
  byAci: AciString | null;
  // Set only when a *live* record from the record's own author lists this
  // digest in `ZrdtMeta.disown`. The caller must check author == disowner.
  disownedBy: AciString | null;
}>;

export type UpsertZrdtProvenanceOptionsType = Readonly<{
  // 'upgrade' (default): never downgrade (imported < relayed < live); an equal
  //   kind keeps the existing byAci ("relayed by" the first relayer).
  // 'replace': set kind and byAci as given. Only for SALVAGE, whose kept
  //   records become 'imported' (APP.md §6).
  mode?: 'upgrade' | 'replace';
}>;

// --- Message attributes ---------------------------------------------------------

// `message.zrdt`: the frozen send (APP.md §4). Outgoing messages only.
// Classified 'erase' in messageAttributesEraseBehavior (contentBytes is
// plaintext).
export type ZrdtSendAttributesType = Readonly<{
  links: ReadonlyArray<string>; // hex digests, strictly sorted
  nonce: string; // hex, 32 bytes
  // hex, 32 bytes; '' while frozen but not yet accepted (the next send
  // attempt re-accepts the same bytes; ts/zrdt/send.preload.ts)
  digest: string;
  contentBytes: string; // base64, the frozen Content bytes sent on every attempt
}>;

// `message.zrdtAudience`: the snapshot taken at enqueue, in the same
// synchronous block that sets the recipients (zrdt docs/JOIN_PLAN.md §3.2,
// §4.1): the raw `membersV2` ACIs and Desktop's own recipient set
// (`getRecipients`: not blocked, not unregistered). At freeze the audience is
// built from it: members ∩ membersV2 then, plus the author; seated only the
// enqueue recipients the author holds a key for. Outgoing group messages only.
export type ZrdtAudienceSnapshotType = Readonly<{
  members: ReadonlyArray<AciString>;
  recipients: ReadonlyArray<string>;
}>;

// State machine of a `zrdt-gap` row (APP.md §7):
// 'waiting'           spinner; ZRDT_RESEND_DELAY_MS not elapsed yet
// 'requested'         a ZrdtResendRequest went out
// 'still-missing'     NotFound or timeout; UI shows "Ask again"
// 'content-unavailable' a structure-only relay resolved the links, but there
//                     is no opening: "a message from <author> (content unavailable)"
export type ZrdtGapStateType =
  | 'waiting'
  | 'requested'
  | 'still-missing'
  | 'content-unavailable';

// `message.zrdtGap`: payload of a `type: 'zrdt-gap'` row.
export type ZrdtGapAttributesType = Readonly<{
  missingDigests: ReadonlyArray<string>; // hex
  referencedBy: string; // id of the message whose links revealed the gap
  // Sender of `referencedBy`: target of the first 1:1 resend request and the
  // "Bob replied to it" in the gap row.
  referencedByAci?: AciString;
  state: ZrdtGapStateType;
  lastRequestedAt?: number;
  // Set with state 'content-unavailable'.
  contentUnavailableAuthorAci?: AciString;
}>;

// `message.zrdtProvenance`: denormalised copy of the zrdt_provenance row for
// the UI.
export type ZrdtProvenanceAttributesType = Readonly<{
  kind: ZrdtProvenanceKind;
  byAci?: AciString;
}>;

// `message.zrdtStatus`: the CLASSIFY result, stored when records are accepted;
// the UI renders stored values (APP.md §7). Precedence (decided by CLASSIFY):
// confirmedByAuthor, notConfirmedByAuthor, heldBy, unconfirmed.
export type ZrdtStatusKind =
  | 'confirmedByAuthor'
  | 'notConfirmedByAuthor'
  | 'heldBy'
  | 'unconfirmed';

export type ZrdtStatusAttributesType = Readonly<{
  kind: ZrdtStatusKind;
  heldByAci?: AciString; // with 'heldBy'
  // True if the message arrived relayed before its author confirmed it; the UI
  // then shows "confirmed by <author>" instead of a plain message. This is
  // chooseProvenanceLabel's `arrivedIndirectly` (ts/zrdt/ui/labels.std.ts);
  // the receive path keeps it across CLASSIFY refreshes and live upgrades.
  wasRelayed?: boolean;
}>;

// --- Timeline placement (APP.md §6, AMENDMENTS A7) ------------------------------

// Builds the `zrdt-gap` row for a message M whose ACCEPT replied MISSING.
// The gap takes M's *old* received_at and sent_at = M.sent_at - 1, so it sorts
// directly above M. The caller must:
//   1. pass `id: generateMessageId(M.received_at).id`
//      (ts/util/generateMessageId.node.ts; std code cannot import it);
//   2. restamp M with a new counter: M.received_at = incrementMessageCounter()
//      (before M is first saved, if possible: in MessageReceiver that is the
//      envelope's receivedAtCounter);
//   3. save recovered messages with the gap's received_at, and delete the gap
//      row (DataWriter.removeMessage) once every missing digest resolved.
// Read and NotApplicable: a gap row never counts as unread.
// TODO(zrdt transport): drop @testexport once MessageReceiver calls this.
/** @testexport */
export function makeZrdtGapMessageAttributes({
  id,
  conversationId,
  referencing,
  missingDigests,
}: Readonly<{
  id: string;
  conversationId: string;
  referencing: Readonly<{
    id: string;
    received_at: number; // M's old counter, before the restamp
    received_at_ms?: number;
    sent_at: number;
    sourceServiceId?: string;
  }>;
  missingDigests: ReadonlyArray<string>;
}>): MessageAttributesType {
  const sentAt = referencing.sent_at - 1;
  return {
    id,
    conversationId,
    type: 'zrdt-gap',
    received_at: referencing.received_at,
    received_at_ms: referencing.received_at_ms,
    sent_at: sentAt,
    timestamp: sentAt,
    readStatus: ReadStatus.Read,
    seenStatus: SeenStatus.NotApplicable,
    zrdtGap: {
      missingDigests: [...missingDigests],
      referencedBy: referencing.id,
      referencedByAci: referencing.sourceServiceId as AciString | undefined,
      state: 'waiting',
    },
  };
}
