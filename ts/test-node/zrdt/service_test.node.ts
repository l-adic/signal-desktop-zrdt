// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The zrdt service (ts/zrdt/serviceCore.node.ts) on the stub and, if built,
// on zrdtd, with an in-memory stand-in for the zrdt SQL functions.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { assert } from 'chai';

import type {
  UpsertZrdtProvenanceOptionsType,
  ZrdtPendingRowType,
  ZrdtProvenanceRowType,
  ZrdtRecordRowType,
  ZrdtBoundaryRowType,
  ZrdtStoreModeType,
} from '../../types/Zrdt.std.ts';
import type { ZrdtBackend } from '../../zrdt/ZrdtBackend.std.ts';
import { DaemonBackend } from '../../zrdt/backends/daemon.node.ts';
import { StubBackend, decodeRecord } from '../../zrdt/backends/stub.node.ts';
import {
  createZrdtBackend,
  intendedBackendKind,
} from '../../zrdt/backendFactory.node.ts';
import {
  ZrdtServiceCore,
  aciStringToBytes,
  toHex,
} from '../../zrdt/serviceCore.node.ts';
import type {
  ZrdtServiceStorage,
  ZrdtProvenance,
} from '../../zrdt/serviceCore.node.ts';

const ZRDTD =
  process.env.ZRDTD ??
  join(process.cwd(), 'zrdt', 'core', '.lake', 'build', 'bin', 'zrdtd');

type B = Uint8Array<ArrayBuffer>;

function filled(n: number, byte: number): B {
  return new Uint8Array(n).fill(byte);
}

const GROUP = filled(32, 0x67);
const OTHER_GROUP = filled(32, 0x68);
const ALICE = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
const BOB = 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b0b0';
const CAROL = 'c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0';
const DAVE = 'd0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0';
const CHAT = 'conversation-camping';

// Field 201 (JOIN_PLAN §3.2): one entry, Alice with a non-zero key tag.
const AUDIENCE = new Uint8Array([...filled(16, 0xa1), ...filled(16, 0x11)]);

/** DataMessage { body = text, zrdtAudience = AUDIENCE } */
function dataMessage(text: string): B {
  const body = new TextEncoder().encode(text);
  return new Uint8Array([
    0x0a,
    body.length,
    ...body,
    0xca,
    0x0c,
    AUDIENCE.length,
    ...AUDIENCE,
  ]);
}

let nonceCounter = 0;
function nonce(): B {
  nonceCounter += 1;
  return filled(32, nonceCounter % 256);
}

/** An in-memory version of ts/sql/server/zrdt.std.ts. */
class MemoryStorage implements ZrdtServiceStorage {
  records = new Array<ZrdtRecordRowType>();
  pending = new Array<ZrdtPendingRowType>();
  provenance = new Array<ZrdtProvenanceRowType>();
  modes = new Map<string, ZrdtStoreModeType>();
  boundary = new Array<ZrdtBoundaryRowType>();
  // The openings the host holds (message rows), for the re-OPEN.
  held = new Array<{ digest: B; opening: B }>();

  async getZrdtConversationIds(): Promise<Array<string>> {
    return [
      ...new Set([
        ...this.records.map(r => r.conversationId),
        ...this.pending.map(r => r.conversationId),
        ...this.modes.keys(),
        ...this.boundary.map(r => r.conversationId),
      ]),
    ];
  }

  async getZrdtStoreMode(id: string): Promise<ZrdtStoreModeType> {
    return this.modes.get(id) ?? 'closed';
  }

  async setZrdtStoreMode(id: string, mode: ZrdtStoreModeType): Promise<void> {
    if (mode === 'closed') {
      this.modes.delete(id);
    } else {
      this.modes.set(id, mode);
    }
  }

  async getZrdtBoundary(id: string): Promise<Array<ZrdtBoundaryRowType>> {
    return this.boundary.filter(r => r.conversationId === id);
  }

  async insertZrdtBoundary(
    rows: ReadonlyArray<ZrdtBoundaryRowType>
  ): Promise<number> {
    let n = 0;
    for (const row of rows) {
      if (
        !this.boundary.some(
          r =>
            r.conversationId === row.conversationId &&
            toHex(r.digest) === toHex(row.digest)
        )
      ) {
        this.boundary.push(row);
        n += 1;
      }
    }
    return n;
  }

  async archiveZrdtConversation(id: string, archiveId: string): Promise<void> {
    const move = <T extends { conversationId: string }>(rows: Array<T>) =>
      rows.map(r =>
        r.conversationId === id ? { ...r, conversationId: archiveId } : r
      );
    this.records = move(this.records);
    this.pending = move(this.pending);
    this.provenance = move(this.provenance);
    this.boundary = move(this.boundary);
    const mode = this.modes.get(id);
    if (mode !== undefined) {
      this.modes.delete(id);
      this.modes.set(archiveId, mode);
    }
  }

  async getZrdtRecords(id: string): Promise<Array<ZrdtRecordRowType>> {
    return this.records.filter(r => r.conversationId === id);
  }

  async insertZrdtRecords(
    rows: ReadonlyArray<ZrdtRecordRowType>
  ): Promise<number> {
    let n = 0;
    for (const row of rows) {
      if (
        !this.records.some(
          r =>
            r.conversationId === row.conversationId &&
            toHex(r.digest) === toHex(row.digest)
        )
      ) {
        this.records.push(row);
        n += 1;
      }
    }
    return n;
  }

  async deleteZrdtRecords(
    id: string,
    digests: ReadonlyArray<B>
  ): Promise<number> {
    const drop = new Set(digests.map(toHex));
    const before = this.records.length;
    this.records = this.records.filter(
      r => !(r.conversationId === id && drop.has(toHex(r.digest)))
    );
    return before - this.records.length;
  }

  async getZrdtPending(id: string): Promise<Array<ZrdtPendingRowType>> {
    return this.pending.filter(r => r.conversationId === id);
  }

  async insertZrdtPending(row: ZrdtPendingRowType): Promise<void> {
    if (
      !this.pending.some(
        r =>
          r.conversationId === row.conversationId &&
          toHex(r.digest) === toHex(row.digest)
      )
    ) {
      this.pending.push(row);
    }
  }

  async deleteZrdtPending(
    id: string,
    digests: ReadonlyArray<B>
  ): Promise<number> {
    const drop = new Set(digests.map(toHex));
    const before = this.pending.length;
    this.pending = this.pending.filter(
      r => !(r.conversationId === id && drop.has(toHex(r.digest)))
    );
    return before - this.pending.length;
  }

  async getZrdtProvenance(id: string): Promise<Array<ZrdtProvenanceRowType>> {
    return this.provenance.filter(r => r.conversationId === id);
  }

  async upsertZrdtProvenance(
    rows: ReadonlyArray<ZrdtProvenanceRowType>,
    { mode = 'upgrade' }: UpsertZrdtProvenanceOptionsType = {}
  ): Promise<void> {
    const rank = { imported: 1, relayed: 2, live: 3 };
    for (const row of rows) {
      const i = this.provenance.findIndex(
        r =>
          r.conversationId === row.conversationId &&
          toHex(r.digest) === toHex(row.digest)
      );
      const old = this.provenance[i];
      if (old === undefined) {
        this.provenance.push(row);
        continue;
      }
      const take = mode === 'replace' || rank[row.kind] > rank[old.kind];
      this.provenance[i] = {
        ...old,
        kind: take ? row.kind : old.kind,
        byAci: take ? row.byAci : old.byAci,
        disownedBy: row.disownedBy ?? old.disownedBy,
      };
    }
  }

  async markZrdtDisowned(
    id: string,
    digests: ReadonlyArray<B>,
    by: string
  ): Promise<number> {
    const set = new Set(digests.map(toHex));
    let n = 0;
    this.provenance = this.provenance.map(r => {
      if (r.conversationId === id && set.has(toHex(r.digest))) {
        n += 1;
        return { ...r, disownedBy: by as ZrdtProvenanceRowType['disownedBy'] };
      }
      return r;
    });
    return n;
  }
}

type Make = () => ZrdtBackend;

function newService(
  storage: MemoryStorage,
  make: Make,
  me: string = CAROL,
  awaitingCatchUp?: () => boolean
): ZrdtServiceCore {
  return new ZrdtServiceCore({
    awaitingCatchUp,
    createBackend: make,
    intendedKind: () => 'stub',
    storage,
    groupIdOf: id => (id === CHAT ? GROUP : undefined),
    ourAci: () => me,
    heldOpenings: async (id, digests) =>
      id === CHAT
        ? storage.held.filter(
            h =>
              digests === undefined ||
              digests.some(d => toHex(d) === toHex(h.digest))
          )
        : [],
  });
}

async function incoming(
  service: ZrdtServiceCore,
  author: string,
  text: string,
  links: Array<B>,
  provenance: ZrdtProvenance = { kind: 'live' }
): ReturnType<ZrdtServiceCore['acceptIncoming']> {
  return service.acceptIncoming(CHAT, {
    groupId: GROUP,
    authorAci: aciStringToBytes(author),
    nonce: nonce(),
    dataMessageBytes: dataMessage(text),
    links,
    provenance,
  });
}

function digestOf(
  outcome: Awaited<ReturnType<ZrdtServiceCore['acceptIncoming']>>
): B {
  if (outcome.status !== 'accepted') {
    throw new Error(`expected accepted, got ${outcome.status}`);
  }
  return outcome.digest;
}

const backends: Array<[string, Make | undefined]> = [
  ['stub', () => new StubBackend({ env: {} })],
  [
    'zrdtd',
    existsSync(ZRDTD) ? () => new DaemonBackend({ path: ZRDTD }) : undefined,
  ],
];

describe('zrdt service', function (this: Mocha.Suite) {
  this.timeout(30_000);

  describe('backend factory', () => {
    it('picks the daemon; the stub only in tests; else refuses', () => {
      // The app (no NODE_ENV=test): the Lean daemon or nothing.
      assert.strictEqual(intendedBackendKind({}), 'lean');
      assert.throws(() => createZrdtBackend({}), /needs the Lean daemon/);
      assert.strictEqual(
        intendedBackendKind({ ZRDT_DAEMON: '/path/to/zrdtd' }),
        'lean'
      );
      // Tests may run the stub, unless ZRDT_REQUIRE_LEAN=1.
      assert.strictEqual(intendedBackendKind({ NODE_ENV: 'test' }), 'stub');
      assert.strictEqual(createZrdtBackend({ NODE_ENV: 'test' }).kind, 'stub');
      assert.strictEqual(
        createZrdtBackend({ ZRDT_ALLOW_STUB: '1' }).kind,
        'stub'
      );
      assert.strictEqual(
        intendedBackendKind({ NODE_ENV: 'test', ZRDT_REQUIRE_LEAN: '1' }),
        'lean'
      );
      assert.throws(
        () => createZrdtBackend({ NODE_ENV: 'test', ZRDT_REQUIRE_LEAN: '1' }),
        /needs the Lean daemon/
      );
    });

    it('is unavailable without a backend, and every call rejects', async () => {
      const service = new ZrdtServiceCore({
        createBackend: () => createZrdtBackend({ ZRDT_REQUIRE_LEAN: '1' }),
        intendedKind: () => 'lean',
        storage: new MemoryStorage(),
        groupIdOf: () => GROUP,
        ourAci: () => CAROL,
      });
      const events = new Array<unknown>();
      service.events.on('backend', info => events.push(info));
      await service.init();
      assert.deepEqual(service.backendInfo(), {
        kind: 'lean',
        version: '',
        available: false,
      });
      assert.isAbove(events.length, 0);
      await assert.isRejected(service.heads(CHAT), /unavailable/);
    });
  });

  for (const [name, make] of backends) {
    if (make === undefined) {
      continue;
    }
    describe(`on ${name}`, () => {
      const services = new Array<ZrdtServiceCore>();
      const fresh = (
        storage: MemoryStorage,
        me?: string,
        awaitingCatchUp?: () => boolean
      ) => {
        if (make === undefined) {
          throw new Error('no backend');
        }
        const s = newService(storage, make, me, awaitingCatchUp);
        services.push(s);
        return s;
      };

      it('refuses a message without an audience (NO_AUDIENCE, JOIN_PLAN §3.2)', async () => {
        const storage = new MemoryStorage();
        const service = fresh(storage);
        await service.init();
        await service.ensureConversation(CHAT, GROUP);
        const body = new TextEncoder().encode('no field 201');
        const outcome = await service.acceptIncoming(CHAT, {
          groupId: GROUP,
          authorAci: aciStringToBytes(ALICE),
          nonce: nonce(),
          dataMessageBytes: new Uint8Array([0x0a, body.length, ...body]),
          links: [],
          provenance: { kind: 'live' },
        });
        assert.deepEqual(outcome, { status: 'noAudience' });
        assert.strictEqual(storage.records.length, 0);
      });

      it('records audiences, and records them again from held openings after a restart', async () => {
        const storage = new MemoryStorage();
        const service = fresh(storage);
        await service.init();
        await service.ensureConversation(CHAT, GROUP);
        const aliceAci = aciStringToBytes(ALICE);
        const key = filled(33, 0x05);
        const audience = await service.audience([{ aci: aliceAci, key }]);
        assert.notStrictEqual(audience, 'tooLarge');
        const aud = audience === 'tooLarge' ? new Uint8Array(0) : audience;
        const body = new TextEncoder().encode('seated');
        const outcome = await service.acceptIncoming(CHAT, {
          groupId: GROUP,
          authorAci: aliceAci,
          nonce: nonce(),
          dataMessageBytes: new Uint8Array([
            0x0a,
            body.length,
            ...body,
            0xca,
            0x0c,
            aud.length,
            ...aud,
          ]),
          links: [],
          provenance: { kind: 'live' },
        });
        const digest = digestOf(outcome);
        const opening =
          outcome.status === 'accepted' ? outcome.opening : undefined;
        assert.isOk(opening);
        assert.deepEqual(
          (await service.addressed(CHAT, aliceAci, key)).map(toHex),
          [toHex(digest)]
        );
        assert.deepEqual(
          await service.addressed(CHAT, aliceAci, filled(33, 0x06)),
          [],
          'another key is not seated'
        );

        // A restart re-OPENs the rows; the audiences are not in them.
        const bare = fresh(storage);
        await bare.init();
        assert.deepEqual(await bare.addressed(CHAT, aliceAci, key), []);

        // With the openings the host holds, they are recorded again.
        if (make === undefined || opening === undefined) {
          return;
        }
        const withOpenings = new ZrdtServiceCore({
          createBackend: make,
          intendedKind: () => 'stub',
          storage,
          groupIdOf: id => (id === CHAT ? GROUP : undefined),
          ourAci: () => CAROL,
          heldOpenings: async () => [{ digest, opening }],
        });
        services.push(withOpenings);
        await withOpenings.init();
        assert.deepEqual(
          (await withOpenings.addressed(CHAT, aliceAci, key)).map(toHex),
          [toHex(digest)]
        );
      });

      it('accepts own and incoming messages, writes rows, and re-opens after a restart', async () => {
        const storage = new MemoryStorage();
        const service = fresh(storage);
        const accepted = new Array<string>();
        service.events.on('accepted', (_id, hex) => accepted.push(hex));
        await service.init();
        assert.strictEqual(service.backendInfo().available, true);
        assert.strictEqual(
          service.backendInfo().kind,
          name === 'stub' ? 'stub' : 'lean'
        );

        await service.ensureConversation(CHAT, GROUP);
        const first = await incoming(service, ALICE, 'tent?', []);
        const a = digestOf(first);
        const own = await service.acceptOwn(CHAT, {
          groupId: GROUP,
          authorAci: aciStringToBytes(CAROL),
          nonce: nonce(),
          dataMessageBytes: dataMessage('stove'),
          links: await service.heads(CHAT),
        });
        // The host keeps both openings (message rows): the re-OPEN records
        // their audiences again, so the blob (zrdtS3, with the audiences)
        // comes back the same.
        if (first.status !== 'accepted' || first.opening === undefined) {
          throw new Error('expected an accepted record with its opening');
        }
        storage.held.push(
          { digest: a, opening: first.opening },
          { digest: own.digest, opening: own.opening }
        );
        assert.strictEqual(
          own.opening.length,
          32 + dataMessage('stove').length
        );
        assert.deepEqual((await service.heads(CHAT)).map(toHex), [
          toHex(own.digest),
        ]);
        assert.deepEqual(accepted, [toHex(a), toHex(own.digest)]);
        assert.strictEqual(storage.records.length, 2);
        assert.isTrue(await service.has(CHAT, a));
        const got = await service.get(CHAT, own.digest);
        assert.strictEqual(
          toHex(got?.record ?? new Uint8Array()),
          toHex(own.record)
        );
        assert.deepEqual(got?.links.map(toHex), [toHex(a)]);

        // Restart: a new service on the same rows re-OPENs them.
        const again = fresh(storage);
        await again.init();
        assert.deepEqual((await again.heads(CHAT)).map(toHex), [
          toHex(own.digest),
        ]);
        assert.strictEqual(
          toHex(await again.exportBlob(CHAT)),
          toHex(await service.exportBlob(CHAT))
        );
      });

      it('buffers a record with missing links and drains it when a relay fills the gap', async () => {
        const storage = new MemoryStorage();
        // Bob's device holds everything.
        const bob = fresh(new MemoryStorage(), BOB);
        await bob.ensureConversation(CHAT, GROUP);
        const aliceNonce = nonce();
        const aliceMessage = await bob.acceptIncoming(CHAT, {
          groupId: GROUP,
          authorAci: aciStringToBytes(ALICE),
          nonce: aliceNonce,
          dataMessageBytes: dataMessage('lost the poles'),
          links: [],
          provenance: { kind: 'live' },
        });
        assert.strictEqual(aliceMessage.status, 'accepted');
        if (aliceMessage.status !== 'accepted' || !aliceMessage.opening) {
          return;
        }
        const bobReply = digestOf(
          await incoming(bob, BOB, 'spares', [aliceMessage.digest])
        );

        // Carol missed Alice's message.
        const carol = fresh(storage);
        await carol.ensureConversation(CHAT, GROUP);
        const gap = await incoming(carol, BOB, 'spares', [aliceMessage.digest]);
        assert.strictEqual(gap.status, 'missing');
        if (gap.status !== 'missing') {
          return;
        }
        assert.deepEqual(gap.digests.map(toHex), [toHex(aliceMessage.digest)]);
        assert.strictEqual(storage.pending.length, 1);
        // Carol's copy of Bob's reply (Bob's own copy used another nonce in
        // this test): the digest of the pending record.
        const carolReply = gap.digest;
        assert.isDefined(carolReply);
        assert.strictEqual(
          toHex(storage.pending[0]?.digest ?? new Uint8Array()),
          toHex(carolReply ?? new Uint8Array())
        );

        // A bad opening is refused, then the relay with the right one lands.
        const bad = new Uint8Array(aliceMessage.opening);
        bad[40] = ((bad[40] ?? 0) + 1) % 256;
        assert.deepEqual(
          await carol.acceptRecord(CHAT, {
            record: aliceMessage.record,
            opening: bad,
            provenance: { kind: 'relayed', byAci: BOB },
          }),
          { status: 'badOpening' }
        );
        const relayed = await carol.acceptRecord(CHAT, {
          record: aliceMessage.record,
          opening: aliceMessage.opening,
          provenance: { kind: 'relayed', byAci: BOB },
        });
        assert.strictEqual(relayed.status, 'accepted');
        assert.strictEqual(storage.pending.length, 0);
        assert.deepEqual((await carol.heads(CHAT)).map(toHex), [
          toHex(carolReply ?? new Uint8Array()),
        ]);
        assert.notStrictEqual(toHex(bobReply), '');

        // Statuses: Alice's message is held by Bob (relayed, Bob linked it live).
        let statuses = await carol.classify(CHAT);
        assert.deepEqual(statuses.get(toHex(aliceMessage.digest)), {
          kind: 'heldBy',
          aci: BOB,
        });
        assert.deepEqual(statuses.get(toHex(carolReply ?? new Uint8Array())), {
          kind: 'confirmedByAuthor',
        });

        // Alice's original arrives live: confirmed by Alice.
        const live = await carol.acceptIncoming(CHAT, {
          groupId: GROUP,
          authorAci: aciStringToBytes(ALICE),
          nonce: aliceNonce,
          dataMessageBytes: dataMessage('lost the poles'),
          links: [],
          provenance: { kind: 'live' },
        });
        assert.strictEqual(live.status, 'accepted');
        statuses = await carol.classify(CHAT);
        assert.deepEqual(statuses.get(toHex(aliceMessage.digest)), {
          kind: 'confirmedByAuthor',
        });
      });

      it('buffers a record whose links come unsorted and repeated', async () => {
        const storage = new MemoryStorage();
        const service = fresh(storage);
        await service.ensureConversation(CHAT, GROUP);
        const x1 = filled(32, 0x01);
        const x2 = filled(32, 0xfe);
        const gap = await incoming(service, BOB, 'b', [x2, x1, x2]);
        assert.strictEqual(gap.status, 'missing');
        if (gap.status !== 'missing') {
          return;
        }
        assert.deepEqual(gap.digests.map(toHex), [toHex(x1), toHex(x2)]);
        assert.isDefined(gap.digest);
        const row = storage.pending[0];
        assert.isDefined(row);
        assert.isDefined(decodeRecord(row?.record ?? new Uint8Array()));
        assert.strictEqual(
          toHex(row?.record ?? new Uint8Array()),
          toHex(gap.record ?? new Uint8Array(1))
        );
      });

      it('rejects doctored rows at start, and salvages them', async () => {
        const storage = new MemoryStorage();
        const service = fresh(storage);
        await service.ensureConversation(CHAT, GROUP);
        const a = digestOf(await incoming(service, ALICE, 'a', []));
        const b = digestOf(await incoming(service, BOB, 'b', [a]));
        const c = digestOf(await incoming(service, ALICE, 'c', [b]));
        // Remove a linked, non-head record from the rows.
        await storage.deleteZrdtRecords(CHAT, [b]);

        const restarted = fresh(storage);
        const rejected = new Array<unknown>();
        restarted.events.on('rejected', (_id, outcome) =>
          rejected.push(outcome)
        );
        await restarted.init();
        const outcome = restarted.rejection(CHAT);
        assert.strictEqual(outcome?.status, 'unverifiable');
        if (outcome?.status === 'unverifiable') {
          assert.deepEqual(outcome.missing.map(toHex), [toHex(b)]);
          assert.deepEqual(outcome.unverifiable.map(toHex), [toHex(c)]);
        }
        assert.strictEqual(rejected.length, 1);
        await assert.isRejected(
          incoming(restarted, ALICE, 'd', []),
          /rejected/
        );

        const salvaged = await restarted.salvageStored(CHAT);
        assert.deepEqual(salvaged, { dropped: [c], missing: [b] });
        assert.deepEqual(
          storage.records.map(r => toHex(r.digest)),
          [toHex(a)]
        );
        assert.deepEqual((await restarted.heads(CHAT)).map(toHex), [toHex(a)]);
      });

      it('imports a blob (new records start imported) and salvages a doctored one', async () => {
        const bobStorage = new MemoryStorage();
        const bob = fresh(bobStorage, BOB);
        await bob.ensureConversation(CHAT, GROUP);
        const a = digestOf(await incoming(bob, ALICE, 'a', []));
        const b = digestOf(await incoming(bob, BOB, 'b', [a]));
        const c = digestOf(await incoming(bob, CAROL, 'c', [b]));
        const blob = await bob.exportBlob(CHAT);

        const daveStorage = new MemoryStorage();
        const dave = fresh(daveStorage, 'd0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0');
        await dave.ensureConversation(CHAT, GROUP);
        assert.deepEqual(await dave.importBlob(CHAT, blob), { status: 'ok' });
        assert.deepEqual((await dave.heads(CHAT)).map(toHex), [toHex(c)]);
        assert.deepEqual(
          daveStorage.provenance.map(p => p.kind),
          ['imported', 'imported', 'imported']
        );
        // Rows are in an order OPEN can take: re-open them.
        const daveAgain = fresh(daveStorage);
        await daveAgain.init();
        assert.isUndefined(daveAgain.rejection(CHAT));
        let statuses = await dave.classify(CHAT);
        assert.deepEqual(
          [...statuses.values()].map(s => s.kind),
          ['unconfirmed', 'unconfirmed', 'unconfirmed']
        );
        // Alice writes live on top: everything she reaches is held by her
        // or confirmed.
        const a2 = digestOf(await incoming(dave, ALICE, 'a2', [c]));
        statuses = await dave.classify(CHAT);
        assert.deepEqual(statuses.get(toHex(a)), { kind: 'confirmedByAuthor' });
        assert.deepEqual(statuses.get(toHex(b)), {
          kind: 'heldBy',
          aci: ALICE,
        });
        assert.deepEqual(statuses.get(toHex(a2)), {
          kind: 'confirmedByAuthor',
        });

        // A blob of another group is refused.
        const other = fresh(new MemoryStorage());
        await other.ensureConversation('x', OTHER_GROUP);
        assert.deepEqual(
          await dave.importBlob(CHAT, await other.exportBlob('x')),
          { status: 'wrongChat' }
        );

        // Doctored: Bob's blob without b. Import fails; salvage keeps a.
        const records = bobStorage.records.filter(
          r => toHex(r.digest) !== toHex(b)
        );
        const doctored = concatBlob(
          GROUP,
          records.map(r => r.record)
        );
        const fresh2 = fresh(new MemoryStorage());
        await fresh2.ensureConversation(CHAT, GROUP);
        const failed = await fresh2.importBlob(CHAT, doctored);
        assert.strictEqual(failed.status, 'unverifiable');
        const kept = await fresh2.salvageBlob(CHAT, doctored);
        assert.deepEqual(kept, { dropped: [c], missing: [b] });
        assert.deepEqual((await fresh2.heads(CHAT)).map(toHex), [toHex(a)]);
      });

      it("a newcomer's relative store: ACCEPT_VIEW, the boundary, LINKABLE, re-open, archive (JOIN_PLAN §6)", async () => {
        // Bob holds a1 <- b1 <- b2. Dave is sent b1 and b2 (here as
        // structure-only entries) and gets a1 as a boundary digest.
        const bob = fresh(new MemoryStorage(), BOB);
        await bob.ensureConversation(CHAT, GROUP);
        const a1 = digestOf(await incoming(bob, ALICE, 'a1', []));
        const b1 = digestOf(await incoming(bob, BOB, 'b1', [a1]));
        const b2 = digestOf(await incoming(bob, BOB, 'b2', [b1]));
        const recordOf = async (d: B) => {
          const got = await bob.get(CHAT, d);
          if (got === undefined) {
            throw new Error('Bob lacks a record');
          }
          return got.record;
        };

        const storage = new MemoryStorage();
        const dave = fresh(storage, DAVE);
        await dave.init();
        assert.isFalse(await dave.hasStore(CHAT));
        assert.deepEqual(await dave.heads(CHAT), [], 'heads makes no store');
        assert.isFalse(await dave.hasStore(CHAT));
        assert.strictEqual(await dave.startRelative(CHAT, GROUP), 'relative');
        assert.isTrue(await dave.isRelative(CHAT));
        assert.strictEqual(storage.modes.get(CHAT), 'relative');

        // A live record from Alice that links b2 arrives first: it waits.
        const early = await incoming(dave, ALICE, 'c0', [b2]);
        assert.strictEqual(early.status, 'missing');

        const boundaryEvents = new Array<Array<string>>();
        dave.events.on('boundary', (_id, digests) =>
          boundaryEvents.push(digests)
        );
        const outcomes = await dave.acceptView(CHAT, {
          voucherAci: BOB,
          forImport: false,
          mode: 'catchup',
          items: [
            {
              entry: { kind: 'after', record: await recordOf(b2) },
              provenance: { kind: 'relayed', byAci: BOB },
            },
            {
              entry: { kind: 'after', record: await recordOf(b1) },
              provenance: { kind: 'relayed', byAci: BOB },
            },
            {
              entry: { kind: 'boundary', digest: a1 },
              provenance: { kind: 'relayed', byAci: BOB },
            },
          ],
        });
        assert.deepEqual(
          outcomes.map(o => [o.result.kind, o.isNew]),
          [
            ['ok', true],
            ['ok', true],
            ['ok', false],
          ]
        );
        assert.deepEqual(boundaryEvents, [[toHex(a1)]]);
        assert.deepEqual(
          storage.boundary.map(r => [toHex(r.digest), r.voucherAci]),
          [[toHex(a1), BOB]]
        );
        // The pending record drained; b1 and b2 are stored, a1 is not.
        assert.isTrue(await dave.has(CHAT, b2));
        assert.isFalse(await dave.has(CHAT, a1));
        assert.deepEqual(storage.pending, []);
        const c0 = early.digest;
        if (c0 === undefined) {
          throw new Error('no digest for the pending record');
        }
        assert.deepEqual((await dave.heads(CHAT)).map(toHex), [toHex(c0)]);

        // LINKABLE: only heads held live (c0 is Alice's live record).
        assert.deepEqual((await dave.linkable(CHAT)).map(toHex), [toHex(c0)]);

        // Protocol 4, per-digest mode: a boundary digest no stored record
        // links is not kept, so it adds no head (the round-2 stray head).
        const stray = new Uint8Array(32).fill(0x5a);
        const headsBefore = (await dave.heads(CHAT)).map(toHex);
        const perDigest = await dave.acceptView(CHAT, {
          voucherAci: BOB,
          forImport: false,
          mode: 'perDigest',
          items: [
            {
              entry: { kind: 'boundary', digest: stray },
              provenance: { kind: 'relayed', byAci: BOB },
            },
            {
              entry: { kind: 'boundary', digest: a1 },
              provenance: { kind: 'relayed', byAci: BOB },
            },
          ],
        });
        assert.deepEqual(
          perDigest.map(o => o.result.kind),
          ['ignored', 'ok'],
          'the stray digest is dropped; a1 was taken before'
        );
        assert.deepEqual((await dave.heads(CHAT)).map(toHex), headsBefore);
        assert.isFalse(
          storage.boundary.some(r => toHex(r.digest) === toHex(stray))
        );

        // A pending record resolves through a per-digest boundary digest:
        // the host passes it in the same request, so the digest is kept.
        const deep = new Uint8Array(32).fill(0x6b);
        const late = await incoming(dave, CAROL, 'c1', [c0, deep]);
        assert.strictEqual(late.status, 'missing');
        const resolved = await dave.acceptView(CHAT, {
          voucherAci: BOB,
          forImport: false,
          mode: 'perDigest',
          items: [
            {
              entry: { kind: 'boundary', digest: deep },
              provenance: { kind: 'relayed', byAci: BOB },
            },
          ],
        });
        assert.deepEqual(
          resolved.map(o => o.result.kind),
          ['ok']
        );
        const c1 = late.digest;
        if (c1 === undefined) {
          throw new Error('no digest for the second pending record');
        }
        assert.isTrue(await dave.has(CHAT, c1), 'the pending record is stored');
        assert.deepEqual(storage.pending, []);
        assert.deepEqual((await dave.heads(CHAT)).map(toHex), [toHex(c1)]);

        // Re-open after a restart: the same store, still relative, and the
        // audiences of the live records (the host re-sends the openings its
        // message rows hold).
        for (const o of [early, late]) {
          if (o.status === 'missing' && o.digest && o.opening) {
            storage.held.push({ digest: o.digest, opening: o.opening });
          }
        }
        const exported = toHex(await dave.exportBlob(CHAT));
        const again = fresh(storage, DAVE);
        await again.init();
        assert.isTrue(await again.isRelative(CHAT));
        assert.deepEqual((await again.heads(CHAT)).map(toHex), [toHex(c1)]);
        assert.strictEqual(toHex(await again.exportBlob(CHAT)), exported);

        // A closed store ignores boundary entries.
        const carol = fresh(new MemoryStorage(), CAROL);
        await carol.ensureConversation(CHAT, GROUP);
        const ignored = await carol.acceptView(CHAT, {
          voucherAci: BOB,
          forImport: false,
          mode: 'catchup',
          items: [
            {
              entry: { kind: 'boundary', digest: a1 },
              provenance: { kind: 'relayed', byAci: BOB },
            },
          ],
        });
        assert.deepEqual(
          ignored.map(o => o.result.kind),
          ['ignored']
        );
        assert.isFalse(await carol.isRelative(CHAT));

        // A re-add archives the store: the conversation has none, and its rows
        // moved to the archive key.
        const archiveId = await again.archive(CHAT);
        assert.isFalse(await again.hasStore(CHAT));
        assert.isTrue(
          storage.records.every(r => r.conversationId === archiveId)
        );
        assert.strictEqual(storage.modes.get(archiveId), 'relative');
      });

      it('a store opened while the catch-up waits is relative; the first reply decides it (JOIN_PLAN §6.1)', async () => {
        // Bob holds a1 <- b1 <- c1.
        const bob = fresh(new MemoryStorage(), BOB);
        await bob.ensureConversation(CHAT, GROUP);
        const a1 = digestOf(await incoming(bob, ALICE, 'a1', []));
        const b1 = digestOf(await incoming(bob, BOB, 'b1', [a1]));
        const c1 = await incoming(bob, CAROL, 'c1', [b1]);
        const recordOf = async (d: B) => {
          const got = await bob.get(CHAT, d);
          if (got === undefined) {
            throw new Error('Bob lacks a record');
          }
          return got.record;
        };
        if (c1.status !== 'accepted') {
          throw new Error('c1 not accepted at Bob');
        }

        // Dave, a newcomer, writes before his catch-up has a reply: the
        // store his send opens is relative (it was closed before the fix,
        // and then ignored the reply's boundary).
        let daveWaits = true;
        const storage = new MemoryStorage();
        const dave = fresh(storage, DAVE, () => daveWaits);
        const hi = await dave.acceptOwn(CHAT, {
          groupId: GROUP,
          authorAci: aciStringToBytes(DAVE),
          nonce: nonce(),
          dataMessageBytes: dataMessage('hi all, dave here'),
          links: await dave.linkable(CHAT),
        });
        assert.isTrue(await dave.isRelative(CHAT), 'opened relative');
        assert.strictEqual(storage.modes.get(CHAT), 'relative');
        // Carol's live c1 links history: it waits.
        const early = await dave.acceptRecord(CHAT, {
          record: c1.record,
          opening: c1.opening,
          provenance: { kind: 'live' },
        });
        assert.strictEqual(early.status, 'missing');
        // Bob takes Dave's record live.
        assert.strictEqual(
          (
            await bob.acceptRecord(CHAT, {
              record: hi.record,
              opening: hi.opening,
              provenance: { kind: 'live' },
            })
          ).status,
          'accepted'
        );
        // The first reply carries a boundary: kept, and c1 resolves.
        daveWaits = false;
        const outcomes = await dave.acceptView(CHAT, {
          voucherAci: BOB,
          forImport: false,
          mode: 'catchup',
          items: [
            {
              entry: { kind: 'after', record: await recordOf(b1) },
              provenance: { kind: 'relayed', byAci: BOB },
            },
            {
              entry: { kind: 'boundary', digest: a1 },
              provenance: { kind: 'relayed', byAci: BOB },
            },
          ],
        });
        assert.deepEqual(
          outcomes.map(o => o.result.kind),
          ['ok', 'ok']
        );
        assert.deepEqual(storage.pending, [], 'nothing pending');
        const sortedHeads = async (s: ZrdtServiceCore) =>
          (await s.heads(CHAT)).map(toHex).sort();
        assert.deepEqual(await sortedHeads(dave), await sortedHeads(bob));
        assert.strictEqual(
          await dave.closeRelative(CHAT),
          'relative',
          'a store that took a boundary digest stays relative'
        );
        assert.isTrue(await dave.isRelative(CHAT));

        // Carol's new device (a member from the start, no store) writes
        // before her catch-up has a reply; the reply has no boundary
        // digest: the store is closed again, and stays closed.
        let carolWaits = true;
        const carolRows = new MemoryStorage();
        const carol = fresh(carolRows, CAROL, () => carolWaits);
        const back = await carol.acceptOwn(CHAT, {
          groupId: GROUP,
          authorAci: aciStringToBytes(CAROL),
          nonce: nonce(),
          dataMessageBytes: dataMessage('back again'),
          links: await carol.linkable(CHAT),
        });
        carolRows.held.push({ digest: back.digest, opening: back.opening });
        assert.isTrue(await carol.isRelative(CHAT));
        carolWaits = false;
        assert.strictEqual(await carol.closeRelative(CHAT), 'closed');
        assert.isFalse(await carol.isRelative(CHAT));
        assert.isFalse(carolRows.modes.has(CHAT));
        assert.isTrue(await carol.has(CHAT, back.digest));
        const view = await carol.acceptView(CHAT, {
          voucherAci: BOB,
          forImport: false,
          mode: 'catchup',
          items: [
            {
              entry: { kind: 'after', record: await recordOf(a1) },
              provenance: { kind: 'relayed', byAci: BOB },
            },
            {
              entry: { kind: 'after', record: await recordOf(b1) },
              provenance: { kind: 'relayed', byAci: BOB },
            },
            {
              entry: { kind: 'boundary', digest: new Uint8Array(32).fill(7) },
              provenance: { kind: 'relayed', byAci: BOB },
            },
          ],
        });
        assert.deepEqual(
          view.map(o => o.result.kind),
          ['ok', 'ok', 'ignored'],
          'a closed store takes no boundary digest'
        );
        const carolHeads = await sortedHeads(carol);
        assert.deepEqual(carolHeads, [toHex(back.digest), toHex(b1)].sort());
        const carolAgain = fresh(carolRows, CAROL);
        await carolAgain.init();
        assert.isFalse(await carolAgain.isRelative(CHAT), 'closed at restart');
        assert.deepEqual(await sortedHeads(carolAgain), carolHeads);

        // A restart while the catch-up still waits: the store reopens
        // relative, and the first reply can still close it.
        const aliceRows = new MemoryStorage();
        const alice = fresh(aliceRows, ALICE, () => true);
        const x = digestOf(await incoming(alice, BOB, 'x', []));
        assert.isTrue(await alice.isRelative(CHAT));
        const aliceAgain = fresh(aliceRows, ALICE, () => true);
        await aliceAgain.init();
        assert.isTrue(await aliceAgain.isRelative(CHAT));
        assert.strictEqual(await aliceAgain.closeRelative(CHAT), 'closed');
        assert.isTrue(await aliceAgain.has(CHAT, x));
        assert.deepEqual(await sortedHeads(aliceAgain), [toHex(x)]);
      });

      it('disowns records in our name that we did not create', async () => {
        const storage = new MemoryStorage();
        const carol = fresh(storage, CAROL);
        await carol.ensureConversation(CHAT, GROUP);
        const a = digestOf(await incoming(carol, ALICE, 'a', []));
        // A fake in Carol's name, relayed by the server's accomplice.
        const fake = digestOf(
          await incoming(carol, CAROL, 'fake', [a], {
            kind: 'relayed',
            byAci: BOB,
          })
        );
        const mine = await carol.acceptOwn(CHAT, {
          groupId: GROUP,
          authorAci: aciStringToBytes(CAROL),
          nonce: nonce(),
          dataMessageBytes: dataMessage('real'),
          links: await carol.heads(CHAT),
        });
        assert.deepEqual((await carol.disownSet(CHAT)).map(toHex), [
          toHex(fake),
        ]);

        // Alice's view: Carol's live message disowns the fake.
        const alice = fresh(new MemoryStorage(), ALICE);
        await alice.ensureConversation(CHAT, GROUP);
        await alice.acceptRecord(CHAT, {
          record: (await carol.get(CHAT, a))?.record ?? new Uint8Array(),
          provenance: { kind: 'live' },
        });
        await alice.acceptRecord(CHAT, {
          record: (await carol.get(CHAT, fake))?.record ?? new Uint8Array(),
          provenance: { kind: 'relayed', byAci: BOB },
        });
        await alice.acceptRecord(CHAT, {
          record: mine.record,
          provenance: { kind: 'live' },
        });
        await alice.markDisowned(CHAT, fake, CAROL);
        const statuses = await alice.classify(CHAT);
        assert.deepEqual(statuses.get(toHex(fake)), {
          kind: 'notConfirmedByAuthor',
        });
        assert.deepEqual(statuses.get(toHex(mine.digest)), {
          kind: 'confirmedByAuthor',
        });
      });

      afterEach(() => {
        for (const s of services.splice(0)) {
          s.events.removeAllListeners();
        }
      });
    });
  }

  const itDaemon = existsSync(ZRDTD) ? it : () => undefined;
  itDaemon('fails closed when zrdtd dies', async () => {
    let daemon: DaemonBackend | undefined;
    const service = newService(new MemoryStorage(), () => {
      daemon = new DaemonBackend({ path: ZRDTD });
      return daemon;
    });
    await service.init();
    await service.ensureConversation(CHAT, GROUP);
    const down = new Promise<unknown>(resolve => {
      service.events.on('backend', info => {
        if (!(info as { available: boolean }).available) {
          resolve(info);
        }
      });
    });
    daemon?.dispose();
    await down;
    assert.isFalse(service.backendInfo().available);
    await assert.isRejected(service.heads(CHAT), /unavailable/);

    // restart(): a new zrdtd, every chat re-opened.
    await service.restart();
    assert.isTrue(service.backendInfo().available);
    assert.deepEqual(await service.heads(CHAT), []);
    daemon?.dispose();
  });
});

/** A store blob from encoded records (any order). */
/** A closed zrdtS3 blob without audiences around these records. */
function concatBlob(
  group: B,
  records: ReadonlyArray<Uint8Array<ArrayBuffer>>
): B {
  const parts: Array<Uint8Array<ArrayBuffer>> = [
    new TextEncoder().encode('zrdtS3'),
    Uint8Array.of(0),
    u32(0),
    u32(0),
    new TextEncoder().encode('zrdtS2'),
    group,
    u32(records.length),
  ];
  for (const r of records) {
    parts.push(u32(r.length), r);
  }
  return new Uint8Array(Buffer.concat(parts));
}

function u32(n: number): B {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}
