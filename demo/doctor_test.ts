// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for demo/doctor.ts. Run from the repository root:
//   node --import tsx --test demo/doctor_test.ts
// The zrdtd tests run when the daemon is built (ZRDT_DAEMON, or
// zrdt/core/.lake/build/bin/zrdtd); otherwise they are skipped.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  analyse,
  dropContentEntry,
  appendFakes,
  checkOpen,
  defaultDaemon,
  digestOf,
  encodeBlob,
  encodeRecord,
  hex,
  locateBlob,
  parseBlob,
  parseRecord,
  removeLinkedRecord,
  tag,
  u32,
  Zrdtd,
  Status,
  readDigests,
} from './doctor.ts';
import type { StoreBlob } from './doctor.ts';

const group = randomBytes(32);
const alice = randomBytes(16);
const bob = randomBytes(16);

// r1 <- r2 <- r3, and r1 <- r4: heads r3 and r4.
function chain(): { blob: StoreBlob; d: Array<string> } {
  const r1 = encodeRecord({
    group,
    commit: randomBytes(32),
    links: [],
    author: alice,
  });
  const r2 = encodeRecord({
    group,
    commit: randomBytes(32),
    links: [digestOf(r1)],
    author: bob,
  });
  const r3 = encodeRecord({
    group,
    commit: randomBytes(32),
    links: [digestOf(r2)],
    author: alice,
  });
  const r4 = encodeRecord({
    group,
    commit: randomBytes(32),
    links: [digestOf(r1)],
    author: bob,
  });
  const records = [r1, r2, r3, r4].sort((a, b) =>
    Buffer.compare(digestOf(a), digestOf(b))
  );
  return {
    blob: { group, records },
    d: [r1, r2, r3, r4].map(r => hex(digestOf(r))),
  };
}

void test('blob framing round-trips', () => {
  const { blob } = chain();
  const bytes = encodeBlob(blob);
  assert.equal(bytes.subarray(0, 6).toString(), 'zrdtS2');
  assert.equal(bytes.readUInt32BE(38), 4);
  const back = parseBlob(bytes);
  assert.deepEqual(back.group, group);
  assert.deepEqual(back.records, blob.records);
  for (const r of back.records) {
    assert.deepEqual(encodeRecord(parseRecord(r)), r);
  }
});

void test('parseBlob rejects trailing bytes, truncation and huge counts', () => {
  const bytes = encodeBlob(chain().blob);
  assert.throws(() => parseBlob(Buffer.concat([bytes, Buffer.from([0])])));
  assert.throws(() => parseBlob(bytes.subarray(0, -1)));
  const huge = Buffer.from(bytes);
  huge.writeUInt32BE(2 ** 24, 38);
  assert.throws(() => parseBlob(huge), /limit/);
});

void test('remove drops one linked, non-head record and fixes the count', () => {
  const { blob, d } = chain();
  const [d1, d2, d3, d4] = d as [string, string, string, string];
  const result = removeLinkedRecord(blob);
  // r2 is the only record a head (r3) links that is not also r1... r1 is
  // linked by the head r4 too; the smallest digest of {r1, r2} is chosen.
  const expected = [d1, d2].sort()[0];
  assert.equal(result.removed, expected);
  const bytes = encodeBlob(result.blob);
  assert.equal(bytes.readUInt32BE(38), 3);
  assert.equal(parseBlob(bytes).records.length, 3);
  const items = analyse(result.blob);
  assert.ok(!items.some(i => i.digest === result.removed));
  if (result.removed === d1) {
    assert.deepEqual(new Set(result.unverifiable), new Set([d2, d3, d4]));
  } else {
    assert.deepEqual(result.unverifiable, [d3]);
  }
});

void test('remove by prefix; a head or an unknown prefix is refused', () => {
  const { blob, d } = chain();
  const [, d2, d3] = d as [string, string, string];
  const result = removeLinkedRecord(blob, d2.slice(0, 12));
  assert.equal(result.removed, d2);
  assert.deepEqual(result.linkedBy, [d3]);
  assert.throws(() => removeLinkedRecord(blob, d3.slice(0, 12)), /head/);
  assert.throws(() => removeLinkedRecord(blob, 'zz'), /matches 0/);
  assert.equal(tag(d2), `·${d2.slice(0, 4)}`);
});

void test('remove needs a linked record', () => {
  const r = encodeRecord({
    group,
    commit: randomBytes(32),
    links: [],
    author: alice,
  });
  assert.throws(
    () => removeLinkedRecord({ group, records: [r] }),
    /no record is linked/
  );
});

void test('locateBlob: raw, JSON and binary containers', () => {
  const blob = encodeBlob(chain().blob);
  const next = encodeBlob({ group, records: [] });

  const raw = locateBlob(blob);
  assert.equal(raw.kind, 'raw');
  assert.deepEqual(raw.replace(next), next);

  const json = Buffer.from(
    JSON.stringify({ version: 1, store: blob.toString('base64'), content: {} })
  );
  const j = locateBlob(json);
  assert.equal(j.kind, 'json');
  assert.deepEqual(j.blob, blob);
  const jOut = JSON.parse(j.replace(next).toString()) as { store: string };
  assert.equal(jOut.store, next.toString('base64'));

  const header = Buffer.from('ZRDTDUMP');
  const tail = Buffer.from('content section');
  const bin = Buffer.concat([header, u32(blob.length), blob, tail]);
  const b = locateBlob(bin);
  assert.equal(b.kind, 'binary');
  assert.deepEqual(b.blob, blob);
  const bOut = b.replace(next);
  assert.equal(bOut.readUInt32BE(header.length), next.length);
  assert.deepEqual(
    bOut.subarray(header.length + 4, header.length + 4 + next.length),
    next
  );
  assert.deepEqual(bOut.subarray(bOut.length - tail.length), tail);
});

const daemon = defaultDaemon();
const haveDaemon = existsSync(daemon);

void test(
  'zrdtd accepts our encoding; the removed copy is UNVERIFIABLE',
  {
    skip: haveDaemon ? false : `no zrdtd at ${daemon}`,
  },
  async () => {
    const { blob } = chain();
    assert.equal(await checkOpen(encodeBlob(blob), daemon), 'OK');

    const result = removeLinkedRecord(blob);
    const zrdtd = new Zrdtd(daemon);
    try {
      const r = await zrdtd.open('t', group, encodeBlob(result.blob));
      assert.equal(r.status, Status.UNVERIFIABLE);
      const unverifiable = readDigests(r.body).map(hex);
      const missing = readDigests(r.body, 4 + unverifiable.length * 32).map(
        hex
      );
      assert.deepEqual(missing, [result.removed]);
      assert.deepEqual(unverifiable, [...result.unverifiable].sort());
    } finally {
      await zrdtd.close();
    }
  }
);

void test(
  'append puts two fakes by the author on top of the heads',
  {
    skip: haveDaemon ? false : `no zrdtd at ${daemon}`,
  },
  async () => {
    const { blob, d } = chain();
    const [, , d3, d4] = d as [string, string, string, string];
    const result = await appendFakes(encodeBlob(blob), bob, { daemon });
    assert.equal(result.fakes.length, 2);
    assert.deepEqual([...result.heads].sort(), [d3, d4].sort());

    const items = analyse(parseBlob(result.blob));
    assert.equal(items.length, 6);
    const [f1, f2] = result.fakes as [string, string];
    const fake1 = items.find(i => i.digest === f1);
    const fake2 = items.find(i => i.digest === f2);
    assert.ok(fake1 && fake2);
    assert.deepEqual(fake1.parts.links.map(hex), [d3, d4].sort());
    assert.deepEqual(fake2.parts.links.map(hex), [f1]);
    assert.deepEqual(Buffer.from(fake2.parts.author), bob);
    // The only head is the second fake.
    assert.deepEqual(
      items.filter(i => i.linkedBy.length === 0).map(i => i.digest),
      [f2]
    );
    assert.equal(await checkOpen(result.blob, daemon), 'OK');
  }
);

void test(
  'append refuses a store that does not pass OPEN',
  {
    skip: haveDaemon ? false : `no zrdtd at ${daemon}`,
  },
  async () => {
    const removed = removeLinkedRecord(chain().blob);
    await assert.rejects(
      appendFakes(encodeBlob(removed.blob), bob, { daemon }),
      /does not pass OPEN/
    );
  }
);

void test('dropContentEntry removes one content entry of a JSON dump', () => {
  const doc = { zrdtDump: 1, blob: 'enJkdFMy', content: { aa: 'x', bb: 'y' } };
  const json = Buffer.from(JSON.stringify(doc));
  const out = JSON.parse(dropContentEntry(json, 'aa').toString('utf8')) as {
    content: Record<string, string>;
  };
  assert.deepEqual(out.content, { bb: 'y' });
  assert.equal(dropContentEntry(json, 'cc'), json);
});
