// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { SignalService as Proto } from '../../protobuf/index.std.ts';
import {
  MAX_LINKS,
  RECORD_COUNT_LIMIT,
  ZrdtBackendError,
} from '../../zrdt/ZrdtBackend.std.ts';
import type {
  Bytes,
  Digest,
  OpenResult,
  ProvenanceFact,
  RecordParts,
  Status,
} from '../../zrdt/ZrdtBackend.std.ts';
import {
  StubBackend,
  commitment,
  compareBytes,
  decodeBlob,
  decodeRecord,
  encodeRecord,
  hashRecord,
  makeRecord,
  removeTopLevelFields,
  sha256,
} from '../../zrdt/backends/stub.node.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filled(length: number, byte: number): Bytes {
  return new Uint8Array(length).fill(byte);
}

function hex(bytes: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

function ascii(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

function u32(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function concat(parts: ReadonlyArray<Uint8Array<ArrayBuffer>>): Bytes {
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * A closed `zrdtS3` blob with no recorded audiences around a records blob
 * (`zrdtS2`): tag, mode 0, no boundary digests, no audiences.
 */
function closed(records: Uint8Array<ArrayBuffer>): Bytes {
  return concat([ascii('zrdtS3'), Uint8Array.of(0), u32(0), u32(0), records]);
}

/** The records part of a closed blob without audiences. */
const CLOSED_HEADER_BYTES = 6 + 1 + 4 + 4;

function sorted(digests: ReadonlyArray<Digest>): Array<string> {
  return [...digests].sort(compareBytes).map(hex);
}

const GROUP = filled(32, 0x11);
const OTHER_GROUP = filled(32, 0x22);
const ALICE = filled(16, 0xa1);
const BOB = filled(16, 0xb0);
const CAROL = filled(16, 0xc0);
const CHAT = 'conversation-1';

/** A record whose commitment is derived from `name`. */
function rec(
  name: string,
  links: ReadonlyArray<Digest> = [],
  author: Bytes = ALICE,
  group: Bytes = GROUP
): RecordParts {
  return { group, commit: sha256(ascii(name)), links, author };
}

function digestOf(parts: RecordParts): Digest {
  return hashRecord(makeRecord(parts));
}

/**
 * A record hash for tests that looks only at the commitment (bytes 37 to 68
 * of the encoding). With it, two records with the same commitment collide,
 * and records can link each other in a cycle.
 */
function commitOnlyHash(encoded: Bytes): Digest {
  return sha256(encoded.subarray(37, 69));
}

function newStub(): StubBackend {
  return new StubBackend({ env: {} });
}

async function accepted(
  stub: StubBackend,
  parts: RecordParts,
  chat = CHAT
): Promise<Digest> {
  const result = await stub.accept(chat, parts);
  if (result.kind !== 'accepted') {
    throw new Error(`expected accepted, got ${result.kind}`);
  }
  return result.digest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('zrdt stub', () => {
  describe('sha256', () => {
    it('matches the NIST vectors', () => {
      assert.strictEqual(
        hex(sha256(ascii('abc'))),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
      assert.strictEqual(
        hex(sha256(new Uint8Array(0))),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
    });
  });

  describe('records', () => {
    it('encodes "zrdt2" ‖ group ‖ commit ‖ u32 nlinks ‖ links ‖ author', () => {
      const l1 = filled(32, 0x01);
      const l2 = filled(32, 0x02);
      const parts = rec('m', [l2, l1]);
      const encoded = encodeRecord(makeRecord(parts));
      assert.deepEqual(
        encoded,
        concat([ascii('zrdt2'), GROUP, parts.commit, u32(2), l1, l2, ALICE])
      );
      assert.strictEqual(encoded.length, 89 + 2 * 32);
    });

    it('sorts links and drops duplicates, so link order never changes the hash', () => {
      const a = filled(32, 0x0a);
      const b = filled(32, 0x0b);
      const c = filled(32, 0x0c);
      const r1 = makeRecord(rec('m', [c, a, b, a]));
      const r2 = makeRecord(rec('m', [a, b, c]));
      assert.deepEqual(r1.links.map(hex), [a, b, c].map(hex));
      assert.strictEqual(hex(hashRecord(r1)), hex(hashRecord(r2)));
    });

    it('decodes what it encodes, and only that', () => {
      const r = makeRecord(rec('m', [filled(32, 1), filled(32, 2)]));
      const encoded = encodeRecord(r);
      assert.deepEqual(decodeRecord(encoded), r);

      // Truncated, or a byte too many.
      assert.isUndefined(decodeRecord(encoded.subarray(0, -1)));
      assert.isUndefined(decodeRecord(concat([encoded, new Uint8Array(1)])));
      // Wrong magic.
      const badMagic = new Uint8Array(encoded);
      badMagic[4] = 0x31;
      assert.isUndefined(decodeRecord(badMagic));
      // Links out of order, or repeated.
      const swapped = concat([
        ascii('zrdt2'),
        GROUP,
        r.commit,
        u32(2),
        filled(32, 2),
        filled(32, 1),
        ALICE,
      ]);
      assert.isUndefined(decodeRecord(swapped));
      const repeated = concat([
        ascii('zrdt2'),
        GROUP,
        r.commit,
        u32(2),
        filled(32, 1),
        filled(32, 1),
        ALICE,
      ]);
      assert.isUndefined(decodeRecord(repeated));
      // A link count that does not match the length (no allocation from it).
      const huge = new Uint8Array(encoded);
      new DataView(huge.buffer).setUint32(69, 0xffffffff, false);
      assert.isUndefined(decodeRecord(huge));
    });

    it('refuses fields of the wrong size', () => {
      assert.throws(
        () => makeRecord({ ...rec('m'), group: filled(31, 0) }),
        ZrdtBackendError,
        /group must be 32 bytes/
      );
      assert.throws(
        () => makeRecord({ ...rec('m'), author: filled(32, 0) }),
        /author must be 16 bytes/
      );
      assert.throws(
        () => makeRecord(rec('m', [filled(16, 0)])),
        /link must be 32 bytes/
      );
    });
  });

  describe('commitment', () => {
    const NONCE = filled(32, 0x77);

    it('is SHA-256 of "zrdtP1" ‖ group ‖ author ‖ nonce ‖ the stripped message', () => {
      const message = Proto.DataMessage.encode({
        ...Proto.DataMessage.decode(new Uint8Array(0)),
        body: 'hello',
        timestamp: 1234n,
      });
      assert.deepEqual(
        commitment(GROUP, ALICE, NONCE, message),
        sha256(ascii('zrdtP1'), GROUP, ALICE, NONCE, message)
      );
    });

    it('leaves out groupV2 (15) and zrdt (200), and nothing else', () => {
      const base = {
        ...Proto.DataMessage.decode(new Uint8Array(0)),
        body: 'hello',
        timestamp: 1234n,
      };
      const plain = Proto.DataMessage.encode(base);
      const full = Proto.DataMessage.encode({
        ...base,
        groupV2: {
          masterKey: filled(32, 0x99),
          revision: 3,
          groupChange: null,
        },
        zrdt: {
          links: [filled(32, 1)],
          nonce: NONCE,
          version: 1,
          disown: [],
        },
      });
      assert.notDeepEqual(full, plain);
      assert.deepEqual(removeTopLevelFields(full, new Set([15, 200])), plain);
      assert.deepEqual(
        commitment(GROUP, ALICE, NONCE, full),
        commitment(GROUP, ALICE, NONCE, plain)
      );

      // Everything else is inside: a different body or timestamp changes it.
      const otherBody = Proto.DataMessage.encode({ ...base, body: 'hellO' });
      const otherTime = Proto.DataMessage.encode({ ...base, timestamp: 1235n });
      const c = hex(commitment(GROUP, ALICE, NONCE, plain));
      assert.notStrictEqual(hex(commitment(GROUP, ALICE, NONCE, otherBody)), c);
      assert.notStrictEqual(hex(commitment(GROUP, ALICE, NONCE, otherTime)), c);
      // So are the group, the author and the nonce.
      assert.notStrictEqual(
        hex(commitment(OTHER_GROUP, ALICE, NONCE, plain)),
        c
      );
      assert.notStrictEqual(hex(commitment(GROUP, BOB, NONCE, plain)), c);
      assert.notStrictEqual(
        hex(commitment(GROUP, ALICE, filled(32, 0x78), plain)),
        c
      );
    });

    it('keeps the other fields byte for byte and in order', () => {
      const message = fromHex(
        [
          '0a0161', // field 1, length 1: 'a'
          '7a02aabb', // field 15, length 2
          '38ac02', // field 7, varint 300
          'c20c00', // field 200, length 0
          '310102030405060708', // field 6, fixed64
          '2d01020304', // field 5, fixed32
        ].join('')
      );
      assert.strictEqual(
        hex(
          removeTopLevelFields(message, new Set([15, 200])) ?? new Uint8Array()
        ),
        ['0a0161', '38ac02', '310102030405060708', '2d01020304'].join('')
      );
    });

    it('refuses bytes that are not protobuf', () => {
      for (const bad of [
        '0a05aa', // length past the end
        '0b', // wire type 3 (group start)
        '0e01', // wire type 6
        '00', // field number 0
        '08', // varint value missing
        '08ffffffffffffffffffff01', // varint longer than 10 bytes
        '31010203', // fixed64 cut short
      ]) {
        assert.isUndefined(
          removeTopLevelFields(fromHex(bad), new Set([15, 200])),
          bad
        );
        assert.throws(
          () => commitment(GROUP, ALICE, NONCE, fromHex(bad)),
          /not protobuf/
        );
      }
      assert.deepEqual(
        removeTopLevelFields(new Uint8Array(0), new Set([15])),
        new Uint8Array(0)
      );
    });

    it('refuses fields of the wrong size', () => {
      assert.throws(
        () => commitment(GROUP, ALICE, filled(31, 0), new Uint8Array(0)),
        /nonce must be 32 bytes/
      );
    });
  });

  describe('accept, heads, has, get', () => {
    it('accepts a chain and a fork, and tracks the heads', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      assert.deepEqual(await stub.heads(CHAT), []);

      const a = await accepted(stub, rec('a'));
      assert.deepEqual((await stub.heads(CHAT)).map(hex), [hex(a)]);

      const b = await accepted(stub, rec('b', [a], BOB));
      const c = await accepted(stub, rec('c', [a], CAROL));
      assert.deepEqual((await stub.heads(CHAT)).map(hex), sorted([b, c]));

      const d = await accepted(stub, rec('d', [c, b]));
      assert.deepEqual((await stub.heads(CHAT)).map(hex), [hex(d)]);

      assert.isTrue(await stub.has(CHAT, b));
      assert.isFalse(await stub.has(CHAT, filled(32, 0)));
      const got = await stub.get(CHAT, d);
      assert.deepEqual(got?.links.map(hex), sorted([b, c]));
      assert.deepEqual(got?.author, ALICE);
      assert.isUndefined(await stub.get(CHAT, filled(32, 0)));
    });

    it('returns the digest that hash() computes', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const parts = rec('a');
      assert.deepEqual(await accepted(stub, parts), await stub.hash(parts));
    });

    it('accepts a byte-identical duplicate and changes nothing', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      const before = await stub.encode(CHAT);
      assert.deepEqual(await accepted(stub, rec('a')), a);
      assert.deepEqual(await stub.encode(CHAT), before);
    });

    it('reports exactly the missing links, sorted, and changes nothing', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      const x = filled(32, 0xee);
      const y = filled(32, 0x05);
      const before = await stub.encode(CHAT);
      const result = await stub.accept(CHAT, rec('b', [x, a, y]));
      assert.strictEqual(result.kind, 'missing');
      if (result.kind === 'missing') {
        assert.deepEqual(result.digests.map(hex), [hex(y), hex(x)]);
      }
      assert.deepEqual(await stub.encode(CHAT), before);
    });

    it('refuses a record of another chat', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const result = await stub.accept(CHAT, rec('a', [], ALICE, OTHER_GROUP));
      assert.deepEqual(result, { kind: 'wrongChat' });
      assert.deepEqual(await stub.heads(CHAT), []);
    });

    it('refuses more than MAX_LINKS links', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const links = new Array<Digest>();
      for (let i = 0; i <= MAX_LINKS; i += 1) {
        links.push(sha256(u32(i)));
      }
      assert.deepEqual(await stub.accept(CHAT, rec('a', links)), {
        kind: 'tooLarge',
      });
      // At the limit, the record is judged on its links instead.
      const result = await stub.accept(CHAT, rec('a', links.slice(1)));
      assert.strictEqual(result.kind, 'missing');
    });

    it('reports a collision and changes nothing', async () => {
      const stub = new StubBackend({
        env: {},
        recordHashForTesting: commitOnlyHash,
      });
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      const before = await stub.encode(CHAT);
      // Same commitment, different author: same digest under this hash.
      const result = await stub.accept(CHAT, rec('a', [], BOB));
      assert.deepEqual(result, { kind: 'collision', digest: a });
      assert.deepEqual(await stub.encode(CHAT), before);
    });

    it('needs an open store', async () => {
      const stub = newStub();
      await assert.isRejected(stub.heads(CHAT), /zrdt unknownChat/);
      await assert.isRejected(stub.accept(CHAT, rec('a')), /unknownChat/);
      await stub.create(CHAT, GROUP);
      await stub.close(CHAT);
      await assert.isRejected(stub.encode(CHAT), /unknownChat/);
    });

    it('does not let the caller change a stored record', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const parts = rec('a');
      const a = await accepted(stub, parts);
      parts.commit.fill(0);
      a.fill(0);
      const [head] = await stub.heads(CHAT);
      assert.isDefined(head);
      if (head !== undefined) {
        const got = await stub.get(CHAT, head);
        assert.deepEqual(got?.commit, sha256(ascii('a')));
      }
    });
  });

  describe('reachSet', () => {
    it('follows links from the given digests, within the store', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      const b = await accepted(stub, rec('b', [a]));
      const c = await accepted(stub, rec('c', [a]));
      const d = await accepted(stub, rec('d', [b]));

      assert.deepEqual(
        (await stub.reachSet(CHAT, [d])).map(hex),
        sorted([a, b, d])
      );
      assert.deepEqual(
        (await stub.reachSet(CHAT, [d, c])).map(hex),
        sorted([a, b, c, d])
      );
      assert.deepEqual((await stub.reachSet(CHAT, [a])).map(hex), [hex(a)]);
      assert.deepEqual(await stub.reachSet(CHAT, [filled(32, 0)]), []);
      assert.deepEqual(await stub.reachSet(CHAT, []), []);
    });
  });

  describe('blobs: encode and open', () => {
    async function threeRecords(
      stub: StubBackend
    ): Promise<[Digest, Digest, Digest]> {
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      const b = await accepted(stub, rec('b', [a], BOB));
      const c = await accepted(stub, rec('c', [b], CAROL));
      return [a, b, c];
    }

    it('encodes zrdtS3 around "zrdtS2" ‖ group ‖ u32 count ‖ (u32 len ‖ record)*, sorted by digest', async () => {
      const stub = newStub();
      await threeRecords(stub);
      const blob = await stub.encode(CHAT);
      const decoded = decodeBlob(blob.subarray(CLOSED_HEADER_BYTES));
      assert.strictEqual(decoded.kind, 'ok');
      if (decoded.kind !== 'ok') {
        return;
      }
      assert.deepEqual(decoded.group, GROUP);
      const digests = decoded.records.map(r => hashRecord(r));
      assert.deepEqual(digests.map(hex), sorted(digests));

      const expected = [ascii('zrdtS2'), GROUP, u32(3)];
      for (const r of decoded.records) {
        const encoded = encodeRecord(r);
        expected.push(u32(encoded.length), encoded);
      }
      assert.deepEqual(blob, closed(concat(expected)));
    });

    it('opens what it encodes, to the same store', async () => {
      const stub = newStub();
      await threeRecords(stub);
      const blob = await stub.encode(CHAT);
      const heads = await stub.heads(CHAT);

      assert.deepEqual(await stub.open('copy', GROUP, blob), { kind: 'ok' });
      assert.deepEqual(await stub.encode('copy'), blob);
      assert.deepEqual(await stub.heads('copy'), heads);
    });

    it('opens a list of encoded records in any order', async () => {
      const stub = newStub();
      const [a, b, c] = await threeRecords(stub);
      const blob = await stub.encode(CHAT);
      const list = new Array<Bytes>();
      for (const d of [c, a, b]) {
        // oxlint-disable-next-line no-await-in-loop
        const parts = await stub.get(CHAT, d);
        assert.isDefined(parts);
        if (parts !== undefined) {
          list.push(encodeRecord(makeRecord(parts)));
        }
      }
      assert.deepEqual(await stub.open('copy', GROUP, list), { kind: 'ok' });
      assert.deepEqual(await stub.encode('copy'), blob);
    });

    it('refuses malformed blobs', async () => {
      const stub = newStub();
      await threeRecords(stub);
      const blob = await stub.encode(CHAT);
      const malformed: OpenResult = { kind: 'malformed' };

      const badMagic = new Uint8Array(blob);
      badMagic[0] = 0;
      assert.deepEqual(await stub.open('x', GROUP, badMagic), malformed);
      assert.deepEqual(
        await stub.open('x', GROUP, blob.subarray(0, -1)),
        malformed
      );
      assert.deepEqual(
        await stub.open('x', GROUP, concat([blob, new Uint8Array(1)])),
        malformed
      );
      assert.deepEqual(
        await stub.open('x', GROUP, new Uint8Array(0)),
        malformed
      );
      // A count larger than the records present.
      const moreCount = new Uint8Array(blob);
      new DataView(moreCount.buffer).setUint32(
        CLOSED_HEADER_BYTES + 38,
        4,
        false
      );
      assert.deepEqual(await stub.open('x', GROUP, moreCount), malformed);
      // A malformed record in a list.
      assert.deepEqual(
        await stub.open('x', GROUP, [new Uint8Array(3)]),
        malformed
      );
      await assert.isRejected(stub.heads('x'), /unknownChat/);
    });

    it('refuses a count of 2^24 or more without reading further', async () => {
      const stub = newStub();
      const header = closed(
        concat([ascii('zrdtS2'), GROUP, u32(RECORD_COUNT_LIMIT)])
      );
      assert.deepEqual(await stub.open('x', GROUP, header), {
        kind: 'tooLarge',
      });
      const oneLess = closed(
        concat([ascii('zrdtS2'), GROUP, u32(RECORD_COUNT_LIMIT - 1)])
      );
      assert.deepEqual(await stub.open('x', GROUP, oneLess), {
        kind: 'malformed',
      });
      // A records blob alone is not a store blob (greenfield: zrdtS3 only).
      assert.deepEqual(
        await stub.open('x', GROUP, concat([ascii('zrdtS2'), GROUP, u32(0)])),
        { kind: 'malformed' }
      );
      const max = closed(concat([ascii('zrdtS2'), GROUP, u32(0xffffffff)]));
      assert.deepEqual(await stub.open('x', GROUP, max), { kind: 'tooLarge' });
    });

    it('refuses a record with more than MAX_LINKS links', async () => {
      const stub = newStub();
      const links = new Array<Digest>();
      for (let i = 0; i <= MAX_LINKS; i += 1) {
        links.push(sha256(u32(i)));
      }
      const big = encodeRecord(makeRecord(rec('big', links)));
      assert.deepEqual(await stub.open('x', GROUP, [big]), {
        kind: 'tooLarge',
      });
    });

    it('refuses a blob or record of another chat', async () => {
      const stub = newStub();
      await threeRecords(stub);
      const blob = await stub.encode(CHAT);
      assert.deepEqual(await stub.open('x', OTHER_GROUP, blob), {
        kind: 'wrongChat',
      });
      const foreign = encodeRecord(
        makeRecord(rec('f', [], ALICE, OTHER_GROUP))
      );
      assert.deepEqual(await stub.open('x', GROUP, [foreign]), {
        kind: 'wrongChat',
      });
    });

    it('names the records it cannot accept and the links to nothing', async () => {
      const stub = newStub();
      const [a, b, c] = await threeRecords(stub);
      const e = await accepted(stub, rec('e', [a]));
      // Remove b, which c links: c cannot be accepted, b is missing.
      const list = new Array<Bytes>();
      for (const d of [a, c, e]) {
        // oxlint-disable-next-line no-await-in-loop
        const parts = await stub.get(CHAT, d);
        if (parts !== undefined) {
          list.push(encodeRecord(makeRecord(parts)));
        }
      }
      const result = await stub.open('x', GROUP, list);
      assert.deepEqual(result, {
        kind: 'unverifiable',
        unverifiable: [c],
        missing: [b],
      });
      await assert.isRejected(stub.heads('x'), /unknownChat/);
    });

    it('leaves the open store alone when open is refused (CHAT_OPEN)', async () => {
      const stub = newStub();
      await threeRecords(stub);
      const before = await stub.encode(CHAT);
      await assert.isRejected(
        stub.open(CHAT, GROUP, new Uint8Array(1)),
        /chatOpen/
      );
      await assert.isRejected(stub.open(CHAT, GROUP, before), /chatOpen/);
      await assert.isRejected(stub.salvage(CHAT, GROUP, before), /chatOpen/);
      assert.deepEqual(await stub.encode(CHAT), before);
    });

    it('names records in a cycle as unverifiable, with nothing missing', async () => {
      const stub = new StubBackend({
        env: {},
        recordHashForTesting: commitOnlyHash,
      });
      // Under the test hash a digest depends only on the commitment, so two
      // records can link each other.
      const dx = commitOnlyHash(encodeRecord(makeRecord(rec('x'))));
      const dy = commitOnlyHash(encodeRecord(makeRecord(rec('y'))));
      const x = encodeRecord(makeRecord(rec('x', [dy])));
      const y = encodeRecord(makeRecord(rec('y', [dx])));
      assert.deepEqual(await stub.open('x', GROUP, [x, y]), {
        kind: 'unverifiable',
        unverifiable: [dx, dy].sort(compareBytes),
        missing: [],
      });
    });

    it('reports a collision between two records of the input', async () => {
      const stub = new StubBackend({
        env: {},
        recordHashForTesting: commitOnlyHash,
      });
      const r1 = encodeRecord(makeRecord(rec('a')));
      const r2 = encodeRecord(makeRecord(rec('a', [], BOB)));
      assert.deepEqual(await stub.open('x', GROUP, [r1, r2]), {
        kind: 'collision',
        digest: commitOnlyHash(r1),
      });
      // A byte-identical duplicate is not a collision.
      assert.deepEqual(await stub.open('x', GROUP, [r1, r1]), { kind: 'ok' });
    });
  });

  describe('salvage', () => {
    it('loads what verifies and names the rest', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      const b = await accepted(stub, rec('b', [a]));
      const c = await accepted(stub, rec('c', [b]));
      const d = await accepted(stub, rec('d', [c]));
      const e = await accepted(stub, rec('e', [a]));
      // Drop b: c and d cannot be accepted; a and e can.
      const list = new Array<Bytes>();
      for (const digest of [d, e, c, a]) {
        // oxlint-disable-next-line no-await-in-loop
        const parts = await stub.get(CHAT, digest);
        if (parts !== undefined) {
          list.push(encodeRecord(makeRecord(parts)));
        }
      }
      const result = await stub.salvage('x', GROUP, list);
      assert.deepEqual(result, {
        kind: 'ok',
        dropped: [c, d].sort(compareBytes),
        missing: [b],
      });
      assert.deepEqual((await stub.heads('x')).map(hex), [hex(e)]);
      assert.deepEqual(
        (await stub.reachSet('x', [e])).map(hex),
        sorted([a, e])
      );
    });

    it('refuses what open refuses before accepting anything', async () => {
      const stub = newStub();
      assert.deepEqual(await stub.salvage('x', GROUP, new Uint8Array(2)), {
        kind: 'malformed',
      });
      const foreign = encodeRecord(
        makeRecord(rec('f', [], ALICE, OTHER_GROUP))
      );
      assert.deepEqual(await stub.salvage('x', GROUP, [foreign]), {
        kind: 'wrongChat',
      });
    });
  });

  describe('merge', () => {
    it('adds the records of a blob to the open store', async () => {
      const stub = newStub();
      await stub.create('alice', GROUP);
      await stub.create('bob', GROUP);
      const a = rec('a');
      await accepted(stub, a, 'alice');
      await accepted(stub, a, 'bob');
      const da = digestOf(a);
      const b = await accepted(stub, rec('b', [da]), 'alice');
      const c = await accepted(stub, rec('c', [da], BOB), 'bob');

      const bobBlob = await stub.encode('bob');
      assert.deepEqual(await stub.merge('alice', bobBlob), { kind: 'ok' });
      assert.deepEqual((await stub.heads('alice')).map(hex), sorted([b, c]));

      // Merging is a union: the other way round gives the same store.
      const aliceBlob = await stub.encode('alice');
      await stub.create('carol', GROUP);
      await stub.merge('carol', bobBlob);
      await stub.merge('carol', aliceBlob);
      assert.deepEqual(await stub.encode('carol'), aliceBlob);
    });

    it('leaves the store unchanged on any failure', async () => {
      const stub = new StubBackend({
        env: {},
        recordHashForTesting: commitOnlyHash,
      });
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      await accepted(stub, rec('b', [a]));
      const before = await stub.encode(CHAT);

      await stub.create('other', OTHER_GROUP);
      await accepted(stub, rec('z', [], ALICE, OTHER_GROUP), 'other');
      assert.deepEqual(await stub.merge(CHAT, await stub.encode('other')), {
        kind: 'wrongChat',
      });

      await stub.create('clash', GROUP);
      await accepted(stub, rec('a', [], BOB), 'clash');
      assert.deepEqual(await stub.merge(CHAT, await stub.encode('clash')), {
        kind: 'collision',
        digest: a,
      });

      // A blob with a link to nothing.
      const holey = [encodeRecord(makeRecord(rec('h', [filled(32, 9)])))];
      const result = await stub.merge(
        CHAT,
        closed(
          concat([
            ascii('zrdtS2'),
            GROUP,
            u32(1),
            u32(holey[0]?.length ?? 0),
            ...holey,
          ])
        )
      );
      assert.strictEqual(result.kind, 'unverifiable');

      assert.deepEqual(await stub.merge(CHAT, new Uint8Array(5)), {
        kind: 'malformed',
      });
      assert.deepEqual(await stub.encode(CHAT), before);
    });
  });

  describe('classify', () => {
    function live(
      digest: Digest,
      disown: ReadonlyArray<Digest> = []
    ): ProvenanceFact {
      return { digest, provenance: { kind: 'live' }, disown };
    }

    function statusOf(
      statuses: ReadonlyArray<{ digest: Digest; status: Status }>,
      digest: Digest
    ): Status | undefined {
      return statuses.find(s => hex(s.digest) === hex(digest))?.status;
    }

    it('gives every stored record a status, sorted by digest', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      const b = await accepted(stub, rec('b', [a], BOB));
      const statuses = await stub.classify(CHAT, [
        live(b),
        live(filled(32, 3)),
      ]);
      assert.deepEqual(
        statuses.map(s => hex(s.digest)),
        sorted([a, b])
      );
      assert.deepEqual(statusOf(statuses, b), { kind: 'confirmedByAuthor' });
      assert.deepEqual(statusOf(statuses, a), { kind: 'heldBy', aci: BOB });
      // No live record at all: everything is unconfirmed.
      for (const s of await stub.classify(CHAT, [])) {
        assert.deepEqual(s.status, { kind: 'unconfirmed' });
      }
    });

    it("follows the rules of PLAN.md section 3.5 for a fake in Alice's name", async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const a1 = await accepted(stub, rec('a1'));
      // f claims Alice as author; it arrived imported, not live.
      const f = await accepted(stub, rec('f', [a1]));
      const imported: ProvenanceFact = {
        digest: f,
        provenance: { kind: 'imported' },
        disown: [],
      };

      // Alice's only live record is older than f: f is unconfirmed.
      let s = await stub.classify(CHAT, [live(a1), imported]);
      assert.deepEqual(statusOf(s, a1), { kind: 'confirmedByAuthor' });
      assert.deepEqual(statusOf(s, f), { kind: 'unconfirmed' });

      // Alice writes a2, concurrent with f: f is not confirmed by Alice.
      const a2 = await accepted(stub, rec('a2', [a1]));
      s = await stub.classify(CHAT, [live(a1), live(a2), imported]);
      assert.deepEqual(statusOf(s, f), { kind: 'notConfirmedByAuthor' });

      // Bob links f live. Without a2, f is held by Bob; with a2, the
      // author's verdict wins.
      const b1 = await accepted(stub, rec('b1', [f], BOB));
      s = await stub.classify(CHAT, [live(a1), live(b1), imported]);
      assert.deepEqual(statusOf(s, f), { kind: 'heldBy', aci: BOB });
      s = await stub.classify(CHAT, [live(a1), live(a2), live(b1)]);
      assert.deepEqual(statusOf(s, f), { kind: 'notConfirmedByAuthor' });

      // Alice's a3 reaches f through b1. Without disown, f counts as hers;
      // with f in a3's disown list, it does not.
      const a3 = await accepted(stub, rec('a3', [a2, b1]));
      s = await stub.classify(CHAT, [live(a2), live(b1), live(a3)]);
      assert.deepEqual(statusOf(s, f), { kind: 'confirmedByAuthor' });
      s = await stub.classify(CHAT, [live(a2), live(b1), live(a3, [f])]);
      assert.deepEqual(statusOf(s, f), { kind: 'notConfirmedByAuthor' });
      assert.deepEqual(statusOf(s, a2), { kind: 'confirmedByAuthor' });

      // A disown list counts only when it arrived live.
      s = await stub.classify(CHAT, [
        live(a2),
        live(b1),
        live(a3),
        { digest: a3, provenance: { kind: 'relayed', by: CAROL }, disown: [f] },
      ]);
      assert.deepEqual(statusOf(s, f), { kind: 'confirmedByAuthor' });

      // A disown list from another member does not count.
      s = await stub.classify(CHAT, [live(a2), live(b1, [f]), live(a3)]);
      assert.deepEqual(statusOf(s, f), { kind: 'confirmedByAuthor' });
    });

    it('names the smallest ACI when several members hold a record', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      const c = await accepted(stub, rec('c', [a], CAROL));
      const b = await accepted(stub, rec('b', [a], BOB));
      const s = await stub.classify(CHAT, [live(c), live(b)]);
      assert.deepEqual(statusOf(s, a), { kind: 'heldBy', aci: BOB });
    });
  });

  describe('backend', () => {
    it('reports its kind and version', async () => {
      const stub = newStub();
      assert.strictEqual(stub.kind, 'stub');
      assert.isTrue(stub.isAvailable());
      assert.deepEqual(await stub.version(), { protocol: 3, build: 'stub' });
    });

    it('is refused when ZRDT_REQUIRE_LEAN=1', () => {
      assert.throws(
        () => new StubBackend({ env: { ZRDT_REQUIRE_LEAN: '1' } }),
        ZrdtBackendError,
        /ZRDT_REQUIRE_LEAN/
      );
      assert.doesNotThrow(
        () => new StubBackend({ env: { ZRDT_REQUIRE_LEAN: '0' } })
      );
    });

    it('create refuses a chat key in use (CHAT_OPEN), as zrdtd does', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const a = await accepted(stub, rec('a'));
      await assert.isRejected(stub.create(CHAT, GROUP), /chatOpen/);
      assert.deepEqual((await stub.heads(CHAT)).map(hex), [hex(a)]);
      await stub.close(CHAT);
      await stub.create(CHAT, GROUP);
      assert.deepEqual(await stub.heads(CHAT), []);
    });

    it('commit returns the opening, and acceptRecord checks it', async () => {
      const stub = newStub();
      await stub.create(CHAT, GROUP);
      const nonce = filled(32, 0x4e);
      // body "hi" (field 1), groupV2 (field 15, dropped), zrdt (200,
      // dropped), zrdtAudience (201, kept: one entry, Alice, tag 0x11...)
      const audience = 'ca0c20' + 'a1'.repeat(16) + '11'.repeat(16);
      const dataMessage = fromHex(`0a0268697a020000c20c00${audience}`);
      const committed = await stub.commit(GROUP, ALICE, nonce, dataMessage);
      assert.strictEqual(committed.kind, 'ok');
      if (committed.kind !== 'ok') {
        return;
      }
      assert.strictEqual(
        hex(committed.opening),
        `${hex(nonce)}0a026869${audience}`
      );
      const parts = {
        group: GROUP,
        commit: committed.commit,
        links: [],
        author: ALICE,
      };
      const record = encodeRecord(makeRecord(parts));
      const bad = new Uint8Array(committed.opening);
      bad[bad.length - 1] = ((bad[bad.length - 1] ?? 0) + 1) % 256;
      assert.deepEqual(await stub.acceptRecord(CHAT, record, bad), {
        kind: 'badOpening',
      });
      assert.deepEqual(await stub.acceptRecord(CHAT, record.subarray(1)), {
        kind: 'malformed',
      });
      const ok = await stub.acceptRecord(CHAT, record, committed.opening);
      assert.strictEqual(ok.kind, 'accepted');
      if (ok.kind === 'accepted') {
        assert.strictEqual(hex(ok.record), hex(record));
        assert.strictEqual(hex(ok.digest), hex(await stub.hash(parts)));
      }
      assert.deepEqual(await stub.commit(GROUP, ALICE, nonce, fromHex('0f')), {
        kind: 'malformed',
      });
    });
  });
});
