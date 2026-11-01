// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Catch-up decisions (zrdt docs/JOIN_PLAN.md sections 6.1, 6.5), without
// Signal: resend.preload.ts supplies the state and sends the requests.
// Digests are lowercase hex here.
//
// - When: this device has no zrdt store for a group whose `membersV2`
//   includes its own ACI (at startup, after a group update, or when a live
//   record arrives that links history), whatever the join revision says
//   (JOIN_PLAN §0 point 5: zrdt reads no join revision). The membership fact
//   decides nothing about what a responder releases (SERVE does, from each
//   record's committed audience); a server lie only wastes a request.
// - Which store: the first catch-up reply decides. A reply with a boundary
//   digest needs a relative store; a reply without one (a member from the
//   start: every record it holds was sent to us) gives a closed store, as a
//   genesis member's (JOIN_PLAN §6.2). A re-add opens a relative store at
//   once (its `since` makes the reply relative anyway).
// - Whom: the adder first (the sender of the group change that added us, if
//   it is still a member), then, after a timeout, two more members.
// - What: `since` = the old store's heads ∪ its pending digests ∪ the digests
//   it knows are referenced but missing (a re-add); empty for a new device.

/** How long the first member asked has to answer before two more are asked. */
export const CATCH_UP_TIMEOUT_MS = 15_000;

/** How many more members are asked after the timeout. */
export const CATCH_UP_MORE = 2;

/**
 * A device catches up (JOIN_PLAN §6.1) whenever it has no store for a group
 * it is a member of. Nothing else (no join revision) is read.
 */
export function needsCatchUp({
  isMember,
  hasStore,
}: Readonly<{ isMember: boolean; hasStore: boolean }>): boolean {
  return isMember && !hasStore;
}

/**
 * The store a catch-up reply opens on a device that has none yet: relative
 * if the reply carries a boundary digest, closed otherwise (every record in
 * it was sent to us, so nothing needs a boundary).
 */
export function catchUpStoreMode(
  entryKinds: ReadonlyArray<'addressed' | 'after' | 'boundary'>
): 'relative' | 'closed' {
  return entryKinds.includes('boundary') ? 'relative' : 'closed';
}

export type CatchUpTargets = Readonly<{
  /** Asked at once: the adder if known and still a member, else the first other member. */
  first: string | undefined;
  /** Asked after the timeout, in this order. */
  more: ReadonlyArray<string>;
}>;

/**
 * The members to ask, in order. Members are in the order given (the
 * conversation's), never ourselves, each at most once.
 */
export function catchUpTargets({
  ourAci,
  adderAci,
  members,
  moreCount = CATCH_UP_MORE,
}: Readonly<{
  ourAci: string;
  adderAci: string | undefined;
  members: ReadonlyArray<string>;
  moreCount?: number;
}>): CatchUpTargets {
  const others = [...new Set(members)].filter(aci => aci !== ourAci);
  const adder =
    adderAci != null && adderAci !== ourAci && others.includes(adderAci)
      ? adderAci
      : undefined;
  const first = adder ?? others[0];
  const more = others.filter(aci => aci !== first).slice(0, moreCount);
  return { first, more };
}

/**
 * A catch-up request's `since` (JOIN_PLAN §6.5): the old heads, the pending
 * digests and the missing ones, sorted, without repeats.
 */
export function catchUpSince({
  oldHeads,
  pending,
  missing,
}: Readonly<{
  oldHeads: ReadonlyArray<string>;
  pending: ReadonlyArray<string>;
  missing: ReadonlyArray<string>;
}>): Array<string> {
  return [...new Set([...oldHeads, ...pending, ...missing])]
    .filter(d => /^[0-9a-f]{64}$/.test(d))
    .sort();
}

/**
 * The responder's own `since` for an account after it saw that account
 * removed (JOIN_PLAN §6.5): its heads then, joined with what it recorded
 * before. Joining only shrinks what SERVE shows.
 */
export function joinRemovedSince(
  previous: ReadonlyArray<string> | undefined,
  heads: ReadonlyArray<string>
): Array<string> {
  return [...new Set([...(previous ?? []), ...heads])].sort();
}
