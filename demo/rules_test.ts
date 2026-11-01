// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for demo/rules.ts. Run from the repository root:
//   node --import tsx --test demo/rules_test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blackhole, decide, dropGroupMsg, hold, inferSender } from './rules.ts';
import type { Seen } from './rules.ts';

const group = new Set(['alice', 'bob', 'carol']);

function seen(over: Partial<Seen>): Seen {
  return {
    to: 'carol',
    toDevice: 2,
    type: 'SealedSender',
    ts: 1000n,
    size: 655,
    sendId: '1000#1',
    recipients: new Set(['bob', 'carol']),
    from: 'alice',
    ...over,
  };
}

void test('inferSender: the one member a group send did not address', () => {
  assert.equal(inferSender(group, new Set(['bob', 'carol'])), 'alice');
  assert.equal(inferSender(group, new Set(['carol'])), undefined);
  assert.equal(inferSender(group, new Set(['bob', 'mallory'])), undefined);
  assert.equal(
    inferSender(group, new Set(['alice', 'bob', 'carol'])),
    undefined
  );
});

void test('dropGroupMsg drops one send, on every device, then never again', () => {
  let rules = [dropGroupMsg('alice', 'carol')];
  const first = decide(rules, seen({}));
  assert.equal(first.verdict, 'drop');
  rules = [...first.rules];

  // Same send to Carol's second linked device: also dropped.
  assert.equal(decide(rules, seen({ toDevice: 3 })).verdict, 'drop');

  // Alice's next group message: passes.
  assert.equal(
    decide(rules, seen({ ts: 2000n, sendId: '2000#2' })).verdict,
    'pass'
  );
});

void test('dropGroupMsg ignores what is not a group message from the sender', () => {
  const rules = [dropGroupMsg('alice', 'carol')];
  // A 1:1 send (receipt, sender-key distribution) to Carol.
  const oneToOne = seen({ recipients: new Set(['carol']), from: undefined });
  assert.equal(decide(rules, oneToOne).verdict, 'pass');
  // Bob's group message to Carol.
  const fromBob = seen({
    from: 'bob',
    recipients: new Set(['alice', 'carol']),
  });
  assert.equal(decide(rules, fromBob).verdict, 'pass');
  // Alice's group message to Bob.
  assert.equal(decide(rules, seen({ to: 'bob' })).verdict, 'pass');
  // None of these used the rule up.
  assert.deepEqual(decide(rules, oneToOne).rules, rules);
});

void test('blackhole drops everything to one member; hold queues it', () => {
  const oneToOne = seen({ recipients: new Set(['carol']), from: undefined });
  assert.equal(decide([blackhole('carol')], oneToOne).verdict, 'drop');
  assert.equal(
    decide([blackhole('carol')], seen({ to: 'bob' })).verdict,
    'pass'
  );
  assert.equal(decide([hold('carol')], oneToOne).verdict, 'hold');
  assert.equal(decide([], oneToOne).verdict, 'pass');
});

void test('the first matching rule wins', () => {
  const d = decide([hold('carol'), blackhole('carol')], seen({}));
  assert.equal(d.verdict, 'hold');
  assert.equal(d.ruleId, 'hold(carol)');
});
