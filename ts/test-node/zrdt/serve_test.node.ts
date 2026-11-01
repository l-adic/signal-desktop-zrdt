// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Protocol 3 on the TypeScript stub (JOIN_PLAN §3.2, §5, §10.2): audiences in
// openings, AUDIENCE, ADDRESSED and SERVE, mirroring the cases of
// docs/join-v2/ServeTest.lean, plus the frame codec of the new ops.

import { assert } from 'chai';

import type {
  AudienceMember,
  Bytes,
  ServeEntry,
  ServeRequest,
} from '../../zrdt/ZrdtBackend.std.ts';
import {
  StubBackend,
  buildAudience,
  commitWithOpening,
  decodeRecord,
  stubKeyTag,
} from '../../zrdt/backends/stub.node.ts';
import {
  Code,
  Op,
  decodeReply,
  decodeRequest,
  decodeServeEntries,
  encodeReply,
  encodeRequestBody,
  encodeServeEntries,
} from '../../zrdt/backends/codec.std.ts';
import {
  audienceOfOpening,
  isEphemeralOpening,
  parseAudience,
} from '../../zrdt/audience.std.ts';

const CHAT = 'camping';
const GROUP = new Uint8Array(32).fill(0x67);

function fill(byte: number, size: number): Bytes {
  return new Uint8Array(size).fill(byte);
}

function hex(bytes: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(bytes).toString('hex');
}

function concat(parts: ReadonlyArray<Uint8Array<ArrayBuffer>>): Bytes {
  return new Uint8Array(Buffer.concat(parts));
}

function varint(value: number): Bytes {
  const out: Array<number> = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) + 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

function lenField(num: number, value: Bytes): Bytes {
  return concat([varint(num * 8 + 2), varint(value.length), value]);
}

function varintField(num: number, value: number): Bytes {
  return concat([varint(num * 8), varint(value)]);
}

/** DataMessage bytes: body (1), timestamp (7), expireTimer (5), isViewOnce (14), field 201. */
function dataMessage({
  body,
  audience,
  expireTimer,
  viewOnce,
}: Readonly<{
  body: string;
  audience?: Bytes;
  expireTimer?: number;
  viewOnce?: boolean;
}>): Bytes {
  return concat([
    lenField(1, new TextEncoder().encode(body)),
    ...(expireTimer !== undefined ? [varintField(5, expireTimer)] : []),
    varintField(7, 1_700_000_000_000),
    ...(viewOnce ? [varintField(14, 1)] : []),
    ...(audience !== undefined ? [lenField(201, audience)] : []),
  ]);
}

// Members and their identity keys (33 bytes; the stub only hashes them).
const ALICE = fill(0xa1, 16);
const BOB = fill(0xb0, 16);
const CAROL = fill(0xc0, 16);
const DAVE = fill(0xd0, 16);
const KEY = new Map<string, Bytes>([
  [hex(ALICE), fill(0x05, 33)],
  [hex(BOB), fill(0x06, 33)],
  [hex(CAROL), fill(0x07, 33)],
  [hex(DAVE), fill(0x08, 33)],
]);
const NEW_KEY = fill(0x09, 33);

function key(aci: Bytes): Bytes {
  const k = KEY.get(hex(aci));
  if (!k) {
    throw new Error('no key');
  }
  return k;
}

function seat(aci: Bytes): AudienceMember {
  return { aci, key: key(aci) };
}

function audienceOf(members: ReadonlyArray<AudienceMember>): Bytes {
  const result = buildAudience(members);
  if (result.kind !== 'ok') {
    throw new Error('too large');
  }
  return result.audience;
}

type Made = { digest: Bytes; record: Bytes; opening: Bytes };

let nonceByte = 0;

/** Commits and accepts a record with its opening, as a live receive does. */
async function make(
  backend: StubBackend,
  author: Bytes,
  links: ReadonlyArray<Bytes>,
  message: Bytes
): Promise<Made> {
  nonceByte += 1;
  const committed = commitWithOpening(
    GROUP,
    author,
    fill(nonceByte, 32),
    message
  );
  if (committed.kind !== 'ok') {
    throw new Error('malformed');
  }
  const accepted = await backend.accept(
    CHAT,
    { group: GROUP, commit: committed.commit, links, author },
    committed.opening
  );
  if (accepted.kind !== 'accepted') {
    throw new Error(`not accepted: ${accepted.kind}`);
  }
  return {
    digest: accepted.digest,
    record: accepted.record,
    opening: committed.opening,
  };
}

// The scene of ServeTest.lean: Bob joins after r1.
//   r1  Alice, to {Alice, Carol}               (before Bob was added)
//   r2  Carol, to {Alice, Bob, Carol}, links r1
//   r3  Carol, to {Alice, Carol}, links r2     (Carol's stale view)
//   r4  Alice, to {Alice, Bob, Carol, Dave(blocked: zero tag)}, links r3
type Scene = {
  backend: StubBackend;
  r1: Made;
  r2: Made;
  r3: Made;
  r4: Made;
};

async function scene(): Promise<Scene> {
  const backend = new StubBackend({ env: {} });
  await backend.create(CHAT, GROUP);
  const preJoin = audienceOf([seat(ALICE), seat(CAROL)]);
  const withBob = audienceOf([seat(ALICE), seat(BOB), seat(CAROL)]);
  const r1 = await make(
    backend,
    ALICE,
    [],
    dataMessage({ body: 'before Bob', audience: preJoin })
  );
  const r2 = await make(
    backend,
    CAROL,
    [r1.digest],
    dataMessage({ body: 'hi Bob', audience: withBob })
  );
  const r3 = await make(
    backend,
    CAROL,
    [r2.digest],
    dataMessage({ body: 'stale view', audience: preJoin })
  );
  const r4 = await make(
    backend,
    ALICE,
    [r3.digest],
    dataMessage({
      body: 'all here',
      audience: audienceOf([
        seat(ALICE),
        seat(BOB),
        seat(CAROL),
        { aci: DAVE },
      ]),
    })
  );
  return { backend, r1, r2, r3, r4 };
}

function request(
  s: Scene,
  overrides: Partial<ServeRequest> & { requesterAci: Bytes }
): ServeRequest {
  return {
    chat: CHAT,
    ownAci: ALICE,
    key: key(overrides.requesterAci),
    requestId: fill(0x1d, 16),
    since: [],
    ownSince: [],
    mode: 'catchup',
    wanted: [],
    forExport: false,
    strict: false,
    live: [s.r1.digest, s.r4.digest],
    disown: [],
    held: [s.r1, s.r2, s.r3, s.r4].map(m => ({
      digest: m.digest,
      opening: m.opening,
    })),
    ...overrides,
  };
}

/** Entries by kind, records named by their digest in the scene. */
function describeEntries(s: Scene, entries: ReadonlyArray<ServeEntry>) {
  const names = new Map([
    [hex(s.r1.record), 'r1'],
    [hex(s.r2.record), 'r2'],
    [hex(s.r3.record), 'r3'],
    [hex(s.r4.record), 'r4'],
    [hex(s.r1.digest), 'r1'],
    [hex(s.r2.digest), 'r2'],
    [hex(s.r3.digest), 'r3'],
    [hex(s.r4.digest), 'r4'],
  ]);
  return entries.map(e => {
    switch (e.kind) {
      case 'addressed':
        return `${names.get(hex(e.record))}:addressed${e.opening ? '+content' : ''}${e.authorCopy ? '+authorCopy' : ''}`;
      case 'after':
        return `${names.get(hex(e.record))}:after`;
      case 'boundary':
        return `${names.get(hex(e.digest))}:boundary`;
      default:
        throw new Error('unknown');
    }
  });
}

function contentOf(entries: ReadonlyArray<ServeEntry>): Array<Bytes> {
  return entries.flatMap(e =>
    e.kind === 'addressed' && e.opening ? [e.opening] : []
  );
}

describe('zrdt protocol 3 on the stub (JOIN_PLAN §3.2, §5)', () => {
  describe('audiences', () => {
    it('AUDIENCE sorts by ACI, tags keys, zero-tags keyless members, caps at 256', () => {
      const bytes = audienceOf([seat(CAROL), { aci: DAVE }, seat(ALICE)]);
      const seats = parseAudience(bytes);
      assert.isOk(seats);
      assert.deepEqual(
        seats?.map(s => [hex(s.aci), hex(s.tag), s.seated]),
        [
          [hex(ALICE), hex(stubKeyTag(key(ALICE))), true],
          [hex(CAROL), hex(stubKeyTag(key(CAROL))), true],
          [hex(DAVE), hex(fill(0, 16)), false],
        ]
      );
      const many = Array.from({ length: 257 }, (_, i) => ({
        aci: concat([fill(0, 14), Uint8Array.of(Math.floor(i / 256), i % 256)]),
      }));
      assert.deepEqual(buildAudience(many.slice(0, 256)).kind, 'ok');
      assert.deepEqual(buildAudience(many), { kind: 'tooLarge' });
      assert.deepEqual(buildAudience([seat(ALICE), { aci: ALICE }]), {
        kind: 'malformed',
      });
      assert.deepEqual(buildAudience([]), { kind: 'malformed' });
    });

    it('parseAudience: 1..256 entries, strictly increasing', () => {
      const a = concat([ALICE, fill(1, 16)]);
      const c = concat([CAROL, fill(1, 16)]);
      assert.isOk(parseAudience(concat([a, c])));
      assert.isUndefined(parseAudience(concat([c, a])));
      assert.isUndefined(parseAudience(concat([a, a])));
      assert.isUndefined(parseAudience(new Uint8Array(0)));
      assert.isUndefined(parseAudience(a.subarray(0, 31)));
    });

    it('an opening without exactly one field 201 has no audience; ACCEPT refuses it', async () => {
      const backend = new StubBackend({ env: {} });
      await backend.create(CHAT, GROUP);
      const aud = audienceOf([seat(ALICE)]);
      for (const message of [
        dataMessage({ body: 'none' }),
        concat([
          dataMessage({ body: 'two', audience: aud }),
          lenField(201, aud),
        ]),
        dataMessage({ body: 'bad', audience: fill(1, 31) }),
      ]) {
        const committed = commitWithOpening(GROUP, ALICE, fill(3, 32), message);
        assert.strictEqual(committed.kind, 'ok');
        if (committed.kind !== 'ok') {
          continue;
        }
        assert.isUndefined(audienceOfOpening(committed.opening));
        // oxlint-disable-next-line no-await-in-loop
        const accepted = await backend.accept(
          CHAT,
          { group: GROUP, commit: committed.commit, links: [], author: ALICE },
          committed.opening
        );
        assert.deepEqual(accepted, { kind: 'noAudience' });
        // oxlint-disable-next-line no-await-in-loop
        assert.deepEqual(await backend.heads(CHAT), [], 'nothing stored');
      }
    });

    it('ADDRESSED lists the stored records whose audience seats the account', async () => {
      const s = await scene();
      const sorted = (ds: Array<Bytes>) => ds.map(hex).sort();
      assert.deepEqual(
        sorted(await s.backend.addressed(CHAT, BOB, key(BOB))),
        sorted([s.r2.digest, s.r4.digest])
      );
      assert.deepEqual(await s.backend.addressed(CHAT, BOB, NEW_KEY), []);
      assert.deepEqual(await s.backend.addressed(CHAT, DAVE, key(DAVE)), []);
      assert.strictEqual(
        (await s.backend.addressed(CHAT, ALICE, key(ALICE))).length,
        4
      );
    });

    it('a rewritten audience does not open the record (audience_bound)', async () => {
      const s = await scene();
      // r1's opening with Bob added to its audience: the commit no longer
      // matches, so ACCEPT_RECORD refuses it and SERVE never sends it.
      const rewritten = concat([
        s.r1.opening.subarray(0, 32),
        dataMessage({
          body: 'before Bob',
          audience: audienceOf([seat(ALICE), seat(BOB), seat(CAROL)]),
        }),
      ]);
      assert.deepEqual(
        await s.backend.acceptRecord(CHAT, s.r1.record, rewritten),
        { kind: 'badOpening' }
      );
      const reply = await s.backend.serve(
        request(s, {
          requesterAci: BOB,
          held: [{ digest: s.r1.digest, opening: rewritten }],
        })
      );
      assert.notInclude(contentOf(reply.entries).map(hex), hex(rewritten));
    });
  });

  describe('SERVE', () => {
    it('a newcomer gets what was sent to him, after-structure, and a bare pre-join digest', async () => {
      const s = await scene();
      const reply = await s.backend.serve(request(s, { requesterAci: BOB }));
      assert.sameMembers(describeEntries(s, reply.entries), [
        'r1:boundary',
        'r2:addressed+content',
        'r3:after',
        'r4:addressed+content+authorCopy',
      ]);
      assert.deepEqual(
        contentOf(reply.entries).map(hex).sort(),
        [hex(s.r2.opening), hex(s.r4.opening)].sort()
      );
      // The header names the requester, the checked key's tag, the request.
      assert.strictEqual(hex(reply.header.requesterAci), hex(BOB));
      assert.strictEqual(hex(reply.header.keyTag), hex(stubKeyTag(key(BOB))));
      assert.strictEqual(hex(reply.header.requestId), hex(fill(0x1d, 16)));
      assert.strictEqual(
        hex(reply.headerBytes),
        hex(concat([BOB, stubKeyTag(key(BOB)), fill(0x1d, 16)]))
      );
      assert.strictEqual(
        hex(reply.entriesBytes),
        hex(encodeServeEntries(reply.entries))
      );
    });

    it('a requester whose key changed gets no content (the server swapped it)', async () => {
      const s = await scene();
      const reply = await s.backend.serve(
        request(s, { requesterAci: BOB, key: NEW_KEY })
      );
      assert.deepEqual(contentOf(reply.entries), []);
      assert.deepEqual(describeEntries(s, reply.entries), ['r4:boundary']);
    });

    it('no author shortcut: the author under a changed key gets none of its own records', async () => {
      const s = await scene();
      const reply = await s.backend.serve(
        request(s, { requesterAci: ALICE, key: NEW_KEY })
      );
      assert.deepEqual(contentOf(reply.entries), []);
    });

    it('a blocked member (zero tag) gets nothing', async () => {
      const s = await scene();
      const reply = await s.backend.serve(request(s, { requesterAci: DAVE }));
      assert.deepEqual(contentOf(reply.entries), []);
      assert.isFalse(reply.entries.some(e => e.kind === 'addressed'));
    });

    it('author copy only for the responder’s own live, undisowned records', async () => {
      const s = await scene();
      const notLive = await s.backend.serve(
        request(s, { requesterAci: BOB, live: [] })
      );
      assert.isFalse(
        notLive.entries.some(e => e.kind === 'addressed' && e.authorCopy)
      );
      const disowned = await s.backend.serve(
        request(s, { requesterAci: BOB, disown: [s.r4.digest] })
      );
      assert.isFalse(
        disowned.entries.some(e => e.kind === 'addressed' && e.authorCopy)
      );
      // Carol answering: r4 is Alice's, never Carol's author copy.
      const fromCarol = await s.backend.serve(
        request(s, {
          requesterAci: BOB,
          ownAci: CAROL,
          live: [s.r2.digest, s.r3.digest, s.r4.digest],
        })
      );
      assert.deepEqual(
        describeEntries(s, fromCarol.entries).filter(e =>
          e.includes('authorCopy')
        ),
        ['r2:addressed+content+authorCopy']
      );
    });

    it('strict mode: content only in author copies', async () => {
      const s = await scene();
      const reply = await s.backend.serve(
        request(s, { requesterAci: BOB, strict: true })
      );
      assert.deepEqual(contentOf(reply.entries).map(hex), [hex(s.r4.opening)]);
      assert.isTrue(
        reply.entries.some(
          e =>
            e.kind === 'addressed' &&
            hex(e.record) === hex(s.r2.record) &&
            e.opening === undefined
        ),
        'r2 still comes as structure'
      );
    });

    it('an export refuses disappearing and view-once content (serve_export)', async () => {
      const s = await scene();
      const aud = audienceOf([seat(ALICE), seat(BOB), seat(CAROL)]);
      const timed = await make(
        s.backend,
        CAROL,
        [s.r4.digest],
        dataMessage({ body: 'timed', audience: aud, expireTimer: 60 })
      );
      const once = await make(
        s.backend,
        CAROL,
        [timed.digest],
        dataMessage({ body: 'once', audience: aud, viewOnce: true })
      );
      assert.isTrue(isEphemeralOpening(timed.opening));
      assert.isTrue(isEphemeralOpening(once.opening));
      assert.isFalse(isEphemeralOpening(s.r2.opening));
      const held = [s.r2, timed, once].map(m => ({
        digest: m.digest,
        opening: m.opening,
      }));
      const relay = await s.backend.serve(
        request(s, { requesterAci: BOB, held })
      );
      assert.includeMembers(contentOf(relay.entries).map(hex), [
        hex(timed.opening),
        hex(once.opening),
      ]);
      const exported = await s.backend.serve(
        request(s, { requesterAci: BOB, held, forExport: true })
      );
      assert.deepEqual(contentOf(exported.entries).map(hex), [
        hex(s.r2.opening),
      ]);
    });

    it('per-digest: content whatever since says; a pre-join record only as a digest', async () => {
      const s = await scene();
      const repair = await s.backend.serve(
        request(s, {
          requesterAci: BOB,
          mode: 'perDigest',
          wanted: [s.r2.digest],
          since: [s.r4.digest],
        })
      );
      assert.deepEqual(describeEntries(s, repair.entries), [
        'r2:addressed+content',
      ]);
      const crawl = await s.backend.serve(
        request(s, {
          requesterAci: BOB,
          mode: 'perDigest',
          wanted: [s.r1.digest, s.r3.digest, fill(0xee, 32)],
        })
      );
      // r1 was not sent to Bob: its digest only. r3 (Carol's stale view)
      // links a record sent to him: its structure. The unknown digest: nothing.
      assert.sameMembers(describeEntries(s, crawl.entries), [
        'r1:boundary',
        'r3:after',
      ]);
    });

    it('since: a re-added member gets the gap as digests, not as structure', async () => {
      const s = await scene();
      const reply = await s.backend.serve(
        request(s, { requesterAci: BOB, since: [s.r2.digest] })
      );
      assert.sameMembers(describeEntries(s, reply.entries), [
        'r3:boundary',
        'r4:addressed+content+authorCopy',
      ]);
    });

    it('five crawl shapes never return the pre-join record’s content or structure', async () => {
      const s = await scene();
      const shapes: Array<Partial<ServeRequest>> = [
        {},
        { since: [s.r1.digest] },
        { mode: 'perDigest', wanted: [s.r1.digest] },
        { mode: 'perDigest', wanted: [s.r1.digest], since: [s.r4.digest] },
        { since: [s.r4.digest, s.r3.digest] },
      ];
      for (const shape of shapes) {
        // oxlint-disable-next-line no-await-in-loop
        const reply = await s.backend.serve(
          request(s, { requesterAci: BOB, ...shape })
        );
        for (const e of reply.entries) {
          if (e.kind !== 'boundary') {
            assert.notStrictEqual(hex(e.record), hex(s.r1.record));
          }
        }
        assert.notInclude(contentOf(reply.entries).map(hex), hex(s.r1.opening));
      }
    });

    it('without held openings, the recorded audience still shapes structure', async () => {
      const s = await scene();
      const reply = await s.backend.serve(
        request(s, { requesterAci: BOB, held: [] })
      );
      assert.deepEqual(contentOf(reply.entries), []);
      assert.sameMembers(describeEntries(s, reply.entries), [
        'r1:boundary',
        'r2:addressed',
        'r3:after',
        'r4:addressed+authorCopy',
      ]);
    });

    it('every record in a reply decodes and belongs to the store', async () => {
      const s = await scene();
      const reply = await s.backend.serve(request(s, { requesterAci: CAROL }));
      for (const e of reply.entries) {
        if (e.kind !== 'boundary') {
          assert.isOk(decodeRecord(e.record));
        }
      }
    });
  });

  describe('codec (protocol 3 frames)', () => {
    it('SERVE request and reply round-trip; reply layout header ‖ entries', async () => {
      const s = await scene();
      const req = request(s, {
        requesterAci: BOB,
        mode: 'perDigest',
        wanted: [s.r2.digest],
        since: [s.r1.digest],
        forExport: true,
        strict: true,
        ownSince: [s.r4.digest],
        held: [
          { digest: s.r2.digest, opening: s.r2.opening },
          { digest: s.r3.digest, opening: s.r3.opening },
        ],
      });
      const body = encodeRequestBody({ op: Op.SERVE, ...req });
      const decoded = decodeRequest(concat([Uint8Array.of(Op.SERVE), body]));
      assert.deepEqual(decoded, { op: Op.SERVE, ...req });
      // Catch-up carries no wanted list (mode byte 0, then the export flag).
      const catchup = request(s, { requesterAci: BOB });
      const catchupBody = encodeRequestBody({ op: Op.SERVE, ...catchup });
      assert.deepEqual(
        decodeRequest(concat([Uint8Array.of(Op.SERVE), catchupBody])),
        { op: Op.SERVE, ...catchup }
      );

      const reply = await s.backend.serve(req);
      const payload = encodeReply(Op.SERVE, reply);
      assert.strictEqual(payload[0], Code.OK);
      assert.strictEqual(
        hex(payload.subarray(1)),
        hex(concat([reply.headerBytes, reply.entriesBytes]))
      );
      const back = decodeReply(Op.SERVE, Code.OK, payload.slice(1));
      assert.deepEqual(back, reply);
      assert.deepEqual(decodeServeEntries(reply.entriesBytes), reply.entries);
      assert.isUndefined(decodeServeEntries(reply.entriesBytes.slice(0, -1)));
    });

    it('AUDIENCE, ADDRESSED and ACCEPT with an opening round-trip', () => {
      const members = [seat(ALICE), { aci: DAVE }];
      const a = encodeRequestBody({ op: Op.AUDIENCE, members });
      assert.deepEqual(decodeRequest(concat([Uint8Array.of(Op.AUDIENCE), a])), {
        op: Op.AUDIENCE,
        members,
      });
      const tooLarge = encodeReply(Op.AUDIENCE, { kind: 'tooLarge' });
      assert.deepEqual([...tooLarge], [Code.TOO_LARGE]);
      assert.deepEqual(
        decodeReply(Op.AUDIENCE, Code.TOO_LARGE, new Uint8Array(0)),
        {
          kind: 'tooLarge',
        }
      );

      const ad = {
        op: Op.ADDRESSED as const,
        chat: CHAT,
        aci: BOB,
        key: key(BOB),
      };
      assert.deepEqual(
        decodeRequest(
          concat([Uint8Array.of(Op.ADDRESSED), encodeRequestBody(ad)])
        ),
        ad
      );

      const parts = {
        group: GROUP,
        commit: fill(1, 32),
        links: [fill(2, 32)],
        author: ALICE,
      };
      const opening = fill(3, 40);
      const acc = encodeRequestBody({
        op: Op.ACCEPT,
        chat: CHAT,
        parts,
        opening,
      });
      assert.deepEqual(decodeRequest(concat([Uint8Array.of(Op.ACCEPT), acc])), {
        op: Op.ACCEPT,
        chat: CHAT,
        parts,
        opening,
      });
      // Protocol 3 only: ACCEPT without the opening flag is cut short, and
      // the flag is 0 or 1.
      const bare = encodeRequestBody({ op: Op.ACCEPT, chat: CHAT, parts });
      assert.strictEqual(bare.at(-1), 0);
      assert.deepEqual(
        decodeRequest(concat([Uint8Array.of(Op.ACCEPT), bare])),
        { op: Op.ACCEPT, chat: CHAT, parts }
      );
      assert.strictEqual(
        decodeRequest(concat([Uint8Array.of(Op.ACCEPT), bare.slice(0, -1)])),
        Code.BAD_REQUEST
      );
      const flag2 = bare.slice();
      flag2[flag2.length - 1] = 2;
      assert.strictEqual(
        decodeRequest(concat([Uint8Array.of(Op.ACCEPT), flag2])),
        Code.BAD_REQUEST
      );
      // The ACCEPT reply holds the record bytes, the COMMIT reply the opening:
      // a reply without them cannot be read.
      assert.isUndefined(decodeReply(Op.ACCEPT, Code.OK, fill(4, 32)));
      assert.isUndefined(decodeReply(Op.COMMIT, Code.OK, fill(5, 32)));
      assert.deepEqual(
        [...encodeReply(Op.ACCEPT, { kind: 'noAudience' })],
        [Code.NO_AUDIENCE]
      );
      assert.deepEqual(
        decodeReply(Op.ACCEPT, Code.NO_AUDIENCE, new Uint8Array(0)),
        { kind: 'noAudience' }
      );
    });
  });
});
