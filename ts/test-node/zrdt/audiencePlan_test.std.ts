// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The audience invariants the fork keeps (JOIN_PLAN §3.2, §8.2):
// - seats ⊆ recipients at enqueue ∪ {author};
// - audience ⊆ membersV2 at enqueue ∪ {author};
// - the accounts a message is sent to, at every attempt, ⊆ audience.

import { assert } from 'chai';

import {
  editRecipients,
  mayKeepQuote,
  planAudience,
  snapshotFromSendState,
  splitRecipientsByAudience,
} from '../../zrdt/audiencePlan.std.ts';
import { aciStringHex } from '../../zrdt/audience.std.ts';

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const BOB = 'b0b0b0b0-0000-4000-8000-000000000002';
const CAROL = 'c0c0c0c0-0000-4000-8000-000000000003';
const DAVE = 'd0d0d0d0-0000-4000-8000-000000000004'; // blocked
const ERIN = 'e0e0e0e0-0000-4000-8000-000000000005'; // seen as unregistered
const FRANK = 'f0f0f0f0-0000-4000-8000-000000000006'; // added after enqueue

function hexSet(acis: ReadonlyArray<string>): Set<string> {
  return new Set(acis.map(aciStringHex));
}

/** Every element of `a` is in `b` (as ACIs). */
function assertSubset(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  what: string
): void {
  const bs = hexSet(b);
  for (const x of a) {
    assert.isTrue(bs.has(aciStringHex(x)), `${what}: ${x}`);
  }
}

describe('zrdt audience plan (JOIN_PLAN §3.2, §4.1)', () => {
  // Enqueue: members Alice (us), Bob, Carol, Dave, Erin; Desktop's
  // recipients leave out Dave (blocked) and Erin (unregistered).
  const snapshot = {
    members: [ALICE, BOB, CAROL, DAVE, ERIN],
    recipients: [BOB, CAROL],
  };

  it('seats ⊆ recipients at enqueue ∪ {author}; audience ⊆ members at enqueue ∪ {author}', () => {
    const plan = planAudience({
      ourAci: ALICE,
      snapshot,
      currentMembers: [ALICE, BOB, CAROL, DAVE, ERIN, FRANK],
    });
    assert.deepEqual(plan.members, [ALICE, BOB, CAROL, DAVE, ERIN]);
    assert.deepEqual(plan.seatCandidates, [BOB, CAROL]);
    assertSubset(plan.seatCandidates, [...snapshot.recipients, ALICE], 'seat');
    assertSubset(plan.members, [...snapshot.members, ALICE], 'member');
    assert.isFalse(plan.tooLarge);
  });

  it('blocked and seen-as-unregistered members stay listed, never seated', () => {
    const plan = planAudience({
      ourAci: ALICE,
      snapshot,
      currentMembers: [ALICE, BOB, CAROL, DAVE, ERIN],
    });
    assert.includeMembers([...plan.members], [DAVE, ERIN]);
    assert.notInclude(plan.seatCandidates, DAVE);
    assert.notInclude(plan.seatCandidates, ERIN);
  });

  it('a member removed while the message was queued is dropped; one added is never in', () => {
    const plan = planAudience({
      ourAci: ALICE,
      snapshot,
      currentMembers: [ALICE, CAROL, DAVE, ERIN, FRANK],
    });
    assert.deepEqual(plan.members, [ALICE, CAROL, DAVE, ERIN]);
    assert.deepEqual(plan.seatCandidates, [CAROL]);
    assert.notInclude(plan.members, FRANK);
  });

  it('the author is always in, seated by its own entry (never a seat candidate)', () => {
    const plan = planAudience({
      ourAci: ALICE,
      snapshot: { members: [BOB], recipients: [BOB] },
      currentMembers: [BOB],
    });
    assert.deepEqual(plan.members, [ALICE, BOB]);
    assert.notInclude(plan.seatCandidates, ALICE);
  });

  it('over 256 members: no field 201, the message is no record', () => {
    const many = Array.from(
      { length: 256 },
      (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
    );
    const ok = planAudience({
      ourAci: ALICE,
      snapshot: { members: many.slice(0, 255), recipients: [] },
      currentMembers: many,
    });
    assert.isFalse(ok.tooLarge);
    assert.lengthOf(ok.members, 256);
    const over = planAudience({
      ourAci: ALICE,
      snapshot: { members: many, recipients: [] },
      currentMembers: many,
    });
    assert.isTrue(over.tooLarge);
  });

  it('a message enqueued without a snapshot lists its send-state recipients only', () => {
    const plan = planAudience({
      ourAci: ALICE,
      snapshot: snapshotFromSendState([BOB]),
      currentMembers: [ALICE, BOB, CAROL],
    });
    assert.deepEqual(plan.members, [ALICE, BOB]);
    assert.deepEqual(plan.seatCandidates, [BOB]);
  });

  it('recipients at every attempt ⊆ audience: a reply drafted before an add and sent after', () => {
    // Drafted (enqueued) before Frank was added, frozen and first sent after.
    const plan = planAudience({
      ourAci: ALICE,
      snapshot,
      currentMembers: [ALICE, BOB, CAROL, DAVE, ERIN, FRANK],
    });
    const audience = hexSet(plan.members);
    // Attempt 1: Desktop's recipients now include Frank.
    const first = splitRecipientsByAudience([BOB, CAROL, FRANK], audience);
    assert.deepEqual(first.inAudience, [BOB, CAROL]);
    assert.deepEqual(first.outside, [FRANK]);
    // Attempt 2 (retry): Dave unblocked meanwhile; he is in the audience
    // (zero tag): Signal may deliver to him, zrdt relays nothing to him.
    const second = splitRecipientsByAudience([CAROL, DAVE, FRANK], audience);
    assert.deepEqual(second.inAudience, [CAROL, DAVE]);
    assertSubset(second.inAudience, plan.members, 'attempt');
  });

  it('the edit rule: seats ∩ current recipients', () => {
    const seats = hexSet([ALICE, BOB, CAROL]);
    assert.deepEqual(editRecipients([BOB, CAROL, FRANK, DAVE], seats), [
      BOB,
      CAROL,
    ]);
    assert.deepEqual(editRecipients([BOB, FRANK], undefined), [BOB, FRANK]);
  });

  it('the quote rule: keep only if every receiver is seated in the quoted audience', () => {
    const quoted = hexSet([ALICE, BOB, CAROL]);
    assert.isTrue(mayKeepQuote([ALICE, BOB, CAROL], quoted));
    assert.isFalse(mayKeepQuote([ALICE, BOB, FRANK], quoted));
    assert.isFalse(mayKeepQuote([ALICE], undefined));
  });
});
