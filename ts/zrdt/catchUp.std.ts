// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Catch-up decisions (zrdt docs/JOIN_PLAN.md sections 6.1, 6.5), without
// Signal: resend.preload.ts supplies the state and sends the requests.
// Digests are lowercase hex here.
//
// - When: this device has no zrdt store for a group whose `membersV2`
//   includes its own ACI, and either its own entry says it joined after the
//   group was created (`joinedAtVersion > 0`), or a live record arrives that
//   links history this device does not hold. Neither fact decides what any
//   responder releases (SERVE does, from each record's committed audience); a
//   server lie only wastes or delays a request. A device of a member from the
//   start that has no store yet keeps a closed store unless history shows up.
// - Whom: the adder first (the sender of the group change that added us, if
//   it is still a member), then, after a timeout, two more members.
// - What: `since` = the old store's heads ∪ its pending digests ∪ the digests
//   it knows are referenced but missing (a re-add); empty for a new device.

/** How long the first member asked has to answer before two more are asked. */
export const CATCH_UP_TIMEOUT_MS = 15_000;

/** How many more members are asked after the timeout. */
export const CATCH_UP_MORE = 2;

export type MemberV2 = Readonly<{ aci: string; joinedAtVersion?: number }>;

/** Our own entry says we joined after the group was created. */
export function joinedAfterCreation(
  ourAci: string,
  membersV2: ReadonlyArray<MemberV2>
): boolean {
  const entry = membersV2.find(m => m.aci === ourAci);
  return entry != null && (entry.joinedAtVersion ?? 0) > 0;
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
