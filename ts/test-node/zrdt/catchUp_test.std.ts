// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Catch-up decisions (JOIN_PLAN §6.1, §6.5): when a device catches up, whom
// it asks, and the `since` of a re-add and of a responder.

import { assert } from 'chai';

import {
  CATCH_UP_MORE,
  catchUpSince,
  catchUpTargets,
  joinRemovedSince,
  joinedAfterCreation,
} from '../../zrdt/catchUp.std.ts';

const US = 'd0d0d0d0-0000-4000-8000-000000000004';
const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const BOB = 'b0b0b0b0-0000-4000-8000-000000000002';
const CAROL = 'c0c0c0c0-0000-4000-8000-000000000003';
const ERIN = 'e0e0e0e0-0000-4000-8000-000000000005';

const d = (byte: string) => byte.repeat(32);

describe('zrdt catch-up decisions', () => {
  it('joinedAfterCreation: only our own entry, and only a later revision', () => {
    const members = [
      { aci: ALICE, joinedAtVersion: 0 },
      { aci: US, joinedAtVersion: 3 },
    ];
    assert.isTrue(joinedAfterCreation(US, members));
    assert.isFalse(joinedAfterCreation(ALICE, members));
    assert.isFalse(joinedAfterCreation(BOB, members), 'not a member');
    assert.isFalse(
      joinedAfterCreation(US, [{ aci: US }]),
      'no join revision: a member from the start'
    );
  });

  it('asks the adder first, then two more members, never ourselves', () => {
    const members = [ALICE, BOB, US, CAROL, ERIN];
    assert.deepEqual(catchUpTargets({ ourAci: US, adderAci: CAROL, members }), {
      first: CAROL,
      more: [ALICE, BOB],
    });
    assert.strictEqual(CATCH_UP_MORE, 2);
  });

  it('without a known adder (or one who left, or us) asks the first other member', () => {
    const members = [US, ALICE, BOB, CAROL];
    for (const adderAci of [undefined, ERIN, US]) {
      assert.deepEqual(
        catchUpTargets({ ourAci: US, adderAci, members }),
        { first: ALICE, more: [BOB, CAROL] },
        String(adderAci)
      );
    }
  });

  it('a group of one asks nobody', () => {
    assert.deepEqual(
      catchUpTargets({ ourAci: US, adderAci: undefined, members: [US] }),
      { first: undefined, more: [] }
    );
  });

  it('since = old heads ∪ pending ∪ missing, sorted, without repeats', () => {
    assert.deepEqual(
      catchUpSince({
        oldHeads: [d('bb'), d('aa')],
        pending: [d('cc'), d('aa')],
        missing: [d('dd'), 'not a digest'],
      }),
      [d('aa'), d('bb'), d('cc'), d('dd')]
    );
    assert.deepEqual(
      catchUpSince({ oldHeads: [], pending: [], missing: [] }),
      [],
      'a new device: no since'
    );
  });

  it("a responder's since only grows", () => {
    assert.deepEqual(joinRemovedSince(undefined, [d('bb'), d('aa')]), [
      d('aa'),
      d('bb'),
    ]);
    assert.deepEqual(joinRemovedSince([d('cc')], [d('aa')]), [
      d('aa'),
      d('cc'),
    ]);
  });
});
