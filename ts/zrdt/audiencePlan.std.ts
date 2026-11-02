// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Who is in a message's audience, and who may receive it (zrdt
// docs/JOIN_PLAN.md sections 3.2, 4.1, 8.2, 8.3). Pure decisions; the send
// path (send.preload.ts, sendNormalMessage) and the edit path supply the
// Signal state. ACIs are strings here ("xxxxxxxx-xxxx-..."), compared
// case-insensitively.
//
// The invariants (pinned by ts/test-node/zrdt/audiencePlan_test.std.ts):
// - seats ⊆ recipients at enqueue ∪ {author};
// - audience ⊆ membersV2 at enqueue ∪ {author};
// - the accounts a message is sent to, at every attempt, ⊆ audience.

import { MAX_AUDIENCE } from './ZrdtBackend.std.ts';
import { aciStringHex } from './audience.std.ts';

/** The snapshot taken at enqueue (message attribute `zrdtAudience`). */
export type AudienceSnapshot = Readonly<{
  members: ReadonlyArray<string>;
  recipients: ReadonlyArray<string>;
}>;

/** Who goes into AUDIENCE, and who of them may get a key tag. */
export type AudiencePlan = Readonly<{
  /** Every member listed in field 201: the author first, then by order given. */
  members: ReadonlyArray<string>;
  /**
   * Members other than the author that may be seated: in Desktop's recipient
   * set at enqueue. Each gets the tag of the key the author holds for it, or
   * the zero tag if the author has none (a 404 on the key fetch).
   */
  seatCandidates: ReadonlyArray<string>;
  /** More members than field 201 can hold (256): the message is no record. */
  tooLarge: boolean;
}>;

/**
 * The audience at freeze: the enqueue members still in `membersV2` now, plus
 * the author. Seat candidates: those of them in the enqueue recipient set.
 * Blocked members, members seen as unregistered, and members removed while
 * the message was queued are never seat candidates.
 */
export function planAudience({
  ourAci,
  snapshot,
  currentMembers,
}: Readonly<{
  ourAci: string;
  snapshot: AudienceSnapshot;
  currentMembers: ReadonlyArray<string>;
}>): AudiencePlan {
  const me = aciStringHex(ourAci);
  const now = new Set(currentMembers.map(aciStringHex));
  const recipients = new Set(snapshot.recipients.map(aciStringHex));
  const seen = new Set<string>([me]);
  const members: Array<string> = [ourAci];
  const seatCandidates: Array<string> = [];
  for (const aci of snapshot.members) {
    const hex = aciStringHex(aci);
    if (seen.has(hex) || !now.has(hex)) {
      continue;
    }
    seen.add(hex);
    members.push(aci);
    if (recipients.has(hex)) {
      seatCandidates.push(aci);
    }
  }
  return {
    members,
    seatCandidates,
    tooLarge: members.length > MAX_AUDIENCE,
  };
}

/**
 * The snapshot for a message enqueued without one: its send state's
 * recipients are the recipient set at enqueue (Desktop writes both in one
 * block), and nobody else is listed.
 */
export function snapshotFromSendState(
  recipientAcis: ReadonlyArray<string>
): AudienceSnapshot {
  return { members: recipientAcis, recipients: recipientAcis };
}

/**
 * Splits this attempt's recipients into those in the frozen audience (sent
 * to) and the rest (never sent to: marked skipped). `audienceAcis` are hex.
 */
export function splitRecipientsByAudience<T extends string>(
  recipients: ReadonlyArray<T>,
  audienceAcis: ReadonlySet<string>
): { inAudience: Array<T>; outside: Array<T> } {
  const inAudience: Array<T> = [];
  const outside: Array<T> = [];
  for (const recipient of recipients) {
    if (audienceAcis.has(aciStringHex(recipient))) {
      inAudience.push(recipient);
    } else {
      outside.push(recipient);
    }
  }
  return { inAudience, outside };
}

/**
 * The edit rule (JOIN_PLAN §8.3): an edit of a record goes only to the
 * record's seats ∩ the current recipients. `seats` are hex ACIs; undefined
 * means the target is not a zrdt record, and the edit goes the stock way.
 */
export function editRecipients<T extends string>(
  currentRecipients: ReadonlyArray<T>,
  seats: ReadonlySet<string> | undefined
): Array<T> {
  if (seats === undefined) {
    return [...currentRecipients];
  }
  return currentRecipients.filter(r => seats.has(aciStringHex(r)));
}

/**
 * The quote rule (JOIN_PLAN §8.3): a quote of `p` keeps its content only if
 * every account that can receive the quoting message's content is seated in
 * `p`'s committed audience. `quotedSeats` undefined (no audience known for
 * `p`) means strip.
 */
export function mayKeepQuote(
  receivers: Iterable<string>,
  quotedSeats: ReadonlySet<string> | undefined
): boolean {
  if (quotedSeats === undefined) {
    return false;
  }
  for (const aci of receivers) {
    if (!quotedSeats.has(aciStringHex(aci))) {
      return false;
    }
  }
  return true;
}
