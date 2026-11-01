// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import type {
  GapState,
  Hex,
  ResendTarget,
} from '../../zrdt/resendLogic.std.ts';
import {
  ResendScheduler,
  decideRelayAction,
  planPlacement,
  readResendOptions,
  relayProvenance,
} from '../../zrdt/resendLogic.std.ts';

const CONV = 'conv-1';
const ALICE = 'aci-alice';
const BOB = 'aci-bob';
const CAROL = 'aci-carol';
const D1 = 'd1'.repeat(32);
const D2 = 'd2'.repeat(32);

type Sent = { target: ResendTarget; digests: ReadonlyArray<Hex> };

function harness(options?: Partial<ReturnType<typeof readResendOptions>>) {
  let now = 1000;
  let timers: Array<{ at: number; fn: () => void }> = [];
  const held = new Set<Hex>();
  const sent: Array<Sent> = [];
  const states: Array<{ digests: ReadonlyArray<Hex>; state: GapState }> = [];
  const errors: Array<unknown> = [];
  const scheduler = new ResendScheduler(
    {
      now: () => now,
      setTimer: (fn, ms) => {
        timers.push({ at: now + ms, fn });
      },
      has: async (_conv, digest) => held.has(digest),
      sendRequest: async (_conv, target, digests) => {
        sent.push({ target, digests: [...digests] });
      },
      setGapState: async (_conv, digests, state) => {
        states.push({ digests: [...digests], state });
      },
      onError: error => errors.push(error),
    },
    {
      delayMs: 4000,
      groupAfterMs: 5000,
      giveUpAfterMs: 5000,
      dedupeMs: 60_000,
      authorFastPathDelayMs: 0,
      ...options,
    }
  );
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  };
  // Advance the clock, firing due timers in order.
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers
        .filter(t => t.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      timers = timers.filter(t => t !== due);
      now = due.at;
      due.fn();
      // oxlint-disable-next-line no-await-in-loop
      await flush();
    }
    now = until;
  };
  return { scheduler, held, sent, states, errors, advance, flush };
}

describe('zrdt resend scheduling', () => {
  it('reads ZRDT_AUTHOR_FASTPATH_DELAY_MS, default 0', () => {
    assert.strictEqual(readResendOptions({}).authorFastPathDelayMs, 0);
    assert.strictEqual(
      readResendOptions({ ZRDT_AUTHOR_FASTPATH_DELAY_MS: '3000' })
        .authorFastPathDelayMs,
      3000
    );
    assert.strictEqual(
      readResendOptions({ ZRDT_AUTHOR_FASTPATH_DELAY_MS: '-1' })
        .authorFastPathDelayMs,
      0
    );
  });

  it('reads ZRDT_RESEND_DELAY_MS, default 4000', () => {
    assert.strictEqual(readResendOptions({}).delayMs, 4000);
    assert.strictEqual(
      readResendOptions({ ZRDT_RESEND_DELAY_MS: '3000' }).delayMs,
      3000
    );
    assert.strictEqual(
      readResendOptions({ ZRDT_RESEND_DELAY_MS: 'x' }).delayMs,
      4000
    );
  });

  it('asks the referencing sender 1:1 only after the delay', async () => {
    const h = harness();
    h.scheduler.schedule(CONV, [D1], BOB);
    await h.advance(3999);
    assert.deepEqual(h.sent, []);
    await h.advance(1);
    assert.deepEqual(h.sent, [
      { target: { kind: 'direct', aci: BOB }, digests: [D1] },
    ]);
    assert.deepEqual(h.states, [{ digests: [D1], state: 'requested' }]);
    assert.isTrue(h.scheduler.isOutstanding(CONV, D1));
  });

  it('does not ask if the record arrived during the delay', async () => {
    const h = harness();
    h.scheduler.schedule(CONV, [D1], BOB);
    h.held.add(D1);
    await h.advance(4000);
    assert.deepEqual(h.sent, []);
  });

  it('goes to the group after the timeout, then says still missing', async () => {
    const h = harness();
    h.scheduler.schedule(CONV, [D1, D2], BOB);
    await h.advance(4000);
    h.held.add(D2); // D2 arrived from Bob
    await h.advance(5000);
    assert.deepEqual(h.sent[1], { target: { kind: 'group' }, digests: [D1] });
    await h.advance(5000);
    assert.deepEqual(h.states.at(-1), {
      digests: [D1],
      state: 'still-missing',
    });
    // still outstanding: a late answer is welcome
    assert.isTrue(h.scheduler.isOutstanding(CONV, D1));
    assert.isFalse(h.scheduler.isOutstanding(CONV, D2));
  });

  it('a NotFound from the 1:1 target escalates at once', async () => {
    const h = harness();
    await h.scheduler.ask(CONV, [D1], BOB);
    await h.scheduler.onNotFound(CONV, CAROL, [D1]); // not who we asked
    assert.strictEqual(h.sent.length, 1);
    await h.scheduler.onNotFound(CONV, BOB, [D1]);
    assert.deepEqual(h.sent[1], { target: { kind: 'group' }, digests: [D1] });
    // the 1:1 timeout later does not ask the group twice
    await h.advance(5000);
    assert.strictEqual(h.sent.length, 2);
  });

  it('dedupes automatic asks per minute; "Ask again" forces', async () => {
    const h = harness();
    await h.scheduler.ask(CONV, [D1], BOB);
    await h.scheduler.ask(CONV, [D1], BOB);
    assert.strictEqual(h.sent.length, 1);
    await h.scheduler.ask(CONV, [D1], undefined, { force: true });
    assert.strictEqual(h.sent.length, 2);
    assert.deepEqual(h.sent[1]?.target, { kind: 'group' });
    await h.advance(60_000);
    await h.scheduler.ask(CONV, [D1], BOB);
    assert.strictEqual(h.sent.length, 3);
  });

  it('never asks for what the store holds, even when forced', async () => {
    const h = harness();
    h.held.add(D1);
    await h.scheduler.ask(CONV, [D1], BOB, { force: true });
    assert.deepEqual(h.sent, []);
  });

  it('resolved() ends the wait', async () => {
    const h = harness();
    await h.scheduler.ask(CONV, [D1], BOB);
    h.scheduler.resolved(CONV, D1);
    assert.isFalse(h.scheduler.isOutstanding(CONV, D1));
    await h.advance(20_000);
    assert.strictEqual(h.sent.length, 1);
  });
});

describe('zrdt relay acceptance', () => {
  it("provenance: live only for the author's own copy", () => {
    assert.deepEqual(relayProvenance(ALICE, ALICE, true), { kind: 'live' });
    // JOIN_PLAN §4.4: the author's reply without the author-copy mark (it
    // does not hold the record live, or disowned it) is a relay.
    assert.deepEqual(relayProvenance(ALICE, ALICE, false), {
      kind: 'relayed',
      byAci: ALICE,
    });
    assert.deepEqual(relayProvenance(BOB, ALICE, true), {
      kind: 'relayed',
      byAci: BOB,
    });
  });

  it('shows a requested record with an opening', () => {
    const base = {
      authorAci: ALICE,
      ourAci: CAROL,
      wasRequested: true,
      ownLive: false,
    };
    assert.strictEqual(
      decideRelayAction({ ...base, hasOpening: true }),
      'show'
    );
    assert.strictEqual(
      decideRelayAction({ ...base, hasOpening: false }),
      'structureOnly'
    );
    assert.strictEqual(
      decideRelayAction({ ...base, hasOpening: true, wasRequested: false }),
      'none'
    );
  });

  it('a record in our name that is not live raises the alarm', () => {
    const base = {
      authorAci: CAROL,
      ourAci: CAROL,
      hasOpening: true,
      wasRequested: true,
    };
    assert.strictEqual(
      decideRelayAction({ ...base, ownLive: false }),
      'ownNameAlarm'
    );
    assert.strictEqual(decideRelayAction({ ...base, ownLive: true }), 'none');
  });
});

describe('zrdt timeline placement', () => {
  let counter = 100;
  const nextCounter = () => {
    counter += 1;
    return counter;
  };

  it('nothing missing, no gap waiting: unchanged', () => {
    assert.deepEqual(
      planPlacement({
        gaps: [],
        missingCount: 0,
        receivedAtCounter: 7,
        receivedAtDate: 70,
        nextCounter,
      }),
      { receivedAtCounter: 7, receivedAtDate: 70, resolvesGapIds: [] }
    );
  });

  it('links missing: the gap takes the old counter, the message a new one', () => {
    counter = 100;
    assert.deepEqual(
      planPlacement({
        gaps: [],
        missingCount: 1,
        receivedAtCounter: 7,
        receivedAtDate: 70,
        nextCounter,
      }),
      {
        receivedAtCounter: 101,
        receivedAtDate: 70,
        gapReceivedAt: 7,
        gapReceivedAtMs: 70,
        resolvesGapIds: [],
      }
    );
  });

  it('a gap was waiting for it: the message takes the place of the gap', () => {
    const gaps = [
      { id: 'g1', receivedAt: 3, receivedAtMs: 30 },
      { id: 'g2', receivedAt: 5 },
    ];
    assert.deepEqual(
      planPlacement({
        gaps,
        missingCount: 0,
        receivedAtCounter: 7,
        receivedAtDate: 70,
        nextCounter,
      }),
      { receivedAtCounter: 3, receivedAtDate: 30, resolvesGapIds: ['g1', 'g2'] }
    );
    // ...and its own missing links get a gap at the same place, no restamp
    assert.deepEqual(
      planPlacement({
        gaps,
        missingCount: 2,
        receivedAtCounter: 7,
        receivedAtDate: 70,
        nextCounter: () => assert.fail('no restamp'),
      }),
      {
        receivedAtCounter: 3,
        receivedAtDate: 30,
        gapReceivedAt: 3,
        gapReceivedAtMs: 30,
        resolvesGapIds: ['g1', 'g2'],
      }
    );
  });
});
