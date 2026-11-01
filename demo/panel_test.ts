// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for demo/panel.ts against a fake villain. Run from the
// repository root:
//   node --import tsx --test demo/panel_test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startPanel } from './panel.ts';
import type { Villain } from './panel.ts';
import type { Rule } from './rules.ts';
import type { EvilLogEntry } from './evil.ts';

function fakeVillain(): Villain & { released: Array<string> } {
  let rules: ReadonlyArray<Rule> = [];
  const released: Array<string> = [];
  const log: Array<EvilLogEntry> = [
    {
      at: 0,
      seen: {
        to: 'carol',
        toDevice: 2,
        type: 'SealedSender',
        ts: 1000n,
        size: 655,
        sendId: '1000#1',
        recipients: new Set(['bob', 'carol', 'dave']),
        from: 'alice',
      },
      verdict: 'drop',
      ruleId: 'dropGroupMsg(alice, carol)',
    },
  ];
  return {
    get rules() {
      return rules;
    },
    log,
    members: ['alice', 'bob', 'carol', 'dave'],
    released,
    arm(rule) {
      rules = [...rules, rule];
    },
    async clear() {
      rules = [];
      return 3;
    },
    async release(to) {
      released.push(to);
      return 2;
    },
    heldCounts: () => ({ carol: 2 }),
  };
}

async function call(
  url: string,
  method = 'GET',
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

void test('the panel arms, lists, releases and clears rules', async () => {
  const villain = fakeVillain();
  const changes: Array<string> = [];
  let linked = '';
  const panel = await startPanel({
    villain,
    onChange: c => changes.push(c),
    actions: {
      'link-dave': {
        label: 'Link Dave',
        run: async () => {
          linked = 'dave';
          return 'linked';
        },
      },
    },
  });
  try {
    const page = await fetch(panel.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /zrdt villain/);

    let r = await call(
      `${panel.url}rules/dropGroupMsg?from=alice&to=carol`,
      'POST'
    );
    assert.equal(r.status, 200);
    r = await call(`${panel.url}rules/blackhole`, 'POST', { to: 'Carol' });
    assert.equal(r.json.result, 'armed blackhole(carol)');

    r = await call(`${panel.url}rules`);
    assert.deepEqual(
      (r.json.rules as Array<{ id: string }>).map(x => x.id),
      ['dropGroupMsg(alice, carol)', 'blackhole(carol)']
    );
    assert.deepEqual(r.json.held, { carol: 2 });
    assert.deepEqual(Object.keys(r.json.actions as object), ['link-dave']);

    r = await call(`${panel.url}rules/release?to=carol`, 'POST');
    assert.deepEqual(villain.released, ['carol']);

    r = await call(`${panel.url}rules/blackhole?to=mallory`, 'POST');
    assert.equal(r.status, 400);
    r = await call(`${panel.url}rules/reorder?to=carol`, 'POST');
    assert.equal(r.status, 404);

    r = await call(`${panel.url}clear`, 'POST');
    assert.equal(villain.rules.length, 0);
    assert.match(String(r.json.result), /delivered 3/);

    r = await call(`${panel.url}actions/link-dave`, 'POST');
    assert.equal(linked, 'dave');
    assert.equal(r.json.result, 'link-dave: linked');

    const log = await (await fetch(`${panel.url}log`)).text();
    assert.match(log, /alice -> carol\.2 .*group\[bob,carol,dave\] drop/);
    const logJson = await call(`${panel.url}log?format=json`);
    assert.equal(
      (logJson.json as unknown as Array<{ seen: { ts: string } }>)[0]?.seen.ts,
      '1000'
    );
    assert.equal(changes.length, 5);
  } finally {
    await panel.close();
  }
});
