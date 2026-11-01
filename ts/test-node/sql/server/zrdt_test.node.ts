// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { cwd } from 'node:process';

import type { WritableDB } from '../../../sql/Interface.std.ts';
import { DataWriter, setupTests } from '../../../sql/Server.node.ts';
import { sql } from '../../../sql/util.std.ts';
import {
  deleteZrdtForConversation,
  deleteZrdtPending,
  deleteZrdtRecords,
  getMessageIdsByZrdtDigest,
  getZrdtConversationIds,
  getZrdtGapMessageIds,
  getZrdtPending,
  getZrdtProvenance,
  getZrdtRecords,
  insertZrdtPending,
  insertZrdtRecord,
  insertZrdtRecords,
  markZrdtDisowned,
  upsertZrdtProvenance,
} from '../../../sql/server/zrdt.std.ts';
import type { AciString } from '../../../types/ServiceId.std.ts';
import type { ZrdtProvenanceRowType } from '../../../types/Zrdt.std.ts';
import { makeZrdtGapMessageAttributes } from '../../../types/Zrdt.std.ts';
import { createDB, explain, insertData } from '../helpers.node.ts';

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AciString;
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as AciString;

function bytes(fill: number, length = 32): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).fill(fill);
}

function hex(value: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(value).toString('hex');
}

function simplify<T extends { digest: Uint8Array<ArrayBuffer> }>(
  rows: ReadonlyArray<T>
): Array<Omit<T, 'digest'> & { digest: string }> {
  return rows.map(row => ({ ...row, digest: hex(row.digest) }));
}

describe('sql/server/zrdt', () => {
  let db: WritableDB;

  beforeEach(() => {
    db = createDB();
    setupTests(db, { userDataPath: cwd() });
  });

  afterEach(() => {
    db.close();
  });

  describe('zrdt_records', () => {
    it('is append-only and idempotent, per conversation, in insert order', () => {
      assert.equal(
        insertZrdtRecords(db, [
          { conversationId: 'c1', digest: bytes(2), record: bytes(0x22, 90) },
          { conversationId: 'c1', digest: bytes(1), record: bytes(0x11, 90) },
          { conversationId: 'c2', digest: bytes(1), record: bytes(0x33, 90) },
        ]),
        3
      );
      // Same digest again: no change, even with other bytes (the daemon
      // reports COLLISION before the host would ever write).
      assert.equal(
        insertZrdtRecord(db, {
          conversationId: 'c1',
          digest: bytes(1),
          record: bytes(0x44, 90),
        }),
        false
      );

      const c1 = getZrdtRecords(db, 'c1');
      assert.deepEqual(
        c1.map(row => [row.conversationId, hex(row.digest), row.record[0]]),
        [
          ['c1', hex(bytes(2)), 0x22],
          ['c1', hex(bytes(1)), 0x11],
        ]
      );
      assert.ok(c1[0]?.record instanceof Uint8Array);
      assert.equal(getZrdtRecords(db, 'c2').length, 1);
      assert.deepEqual(getZrdtConversationIds(db).sort(), ['c1', 'c2']);
    });

    it('deletes dropped digests (the SALVAGE rewrite)', () => {
      insertZrdtRecords(db, [
        { conversationId: 'c1', digest: bytes(1), record: bytes(1) },
        { conversationId: 'c1', digest: bytes(2), record: bytes(2) },
      ]);
      assert.equal(deleteZrdtRecords(db, 'c1', [bytes(2), bytes(9)]), 1);
      assert.deepEqual(
        getZrdtRecords(db, 'c1').map(row => hex(row.digest)),
        [hex(bytes(1))]
      );
    });
  });

  describe('zrdt_pending', () => {
    it('upserts, keeps a known messageId, and deletes', () => {
      insertZrdtPending(db, {
        conversationId: 'c1',
        digest: bytes(5),
        record: bytes(5),
        messageId: null,
      });
      insertZrdtPending(db, {
        conversationId: 'c1',
        digest: bytes(5),
        record: bytes(5),
        messageId: 'm5',
      });
      insertZrdtPending(db, {
        conversationId: 'c1',
        digest: bytes(5),
        record: bytes(5),
        messageId: null,
      });
      insertZrdtPending(db, {
        conversationId: 'c1',
        digest: bytes(6),
        record: bytes(6),
        messageId: 'm6',
      });

      assert.deepEqual(
        getZrdtPending(db, 'c1').map(row => [hex(row.digest), row.messageId]),
        [
          [hex(bytes(5)), 'm5'],
          [hex(bytes(6)), 'm6'],
        ]
      );

      assert.equal(deleteZrdtPending(db, 'c1', [bytes(5)]), 1);
      assert.deepEqual(
        getZrdtPending(db, 'c1').map(row => row.messageId),
        ['m6']
      );
    });
  });

  describe('zrdt_provenance', () => {
    function row(
      kind: ZrdtProvenanceRowType['kind'],
      byAci: AciString | null = null,
      disownedBy: AciString | null = null
    ): ZrdtProvenanceRowType {
      return {
        conversationId: 'c1',
        digest: bytes(7),
        kind,
        byAci,
        disownedBy,
      };
    }

    it('upgrades imported < relayed < live and never downgrades', () => {
      upsertZrdtProvenance(db, [row('imported')]);
      upsertZrdtProvenance(db, [row('relayed', BOB)]);
      assert.deepEqual(simplify(getZrdtProvenance(db, 'c1')), [
        { ...row('relayed', BOB), digest: hex(bytes(7)) },
      ]);

      // A second relayer does not replace the first
      upsertZrdtProvenance(db, [row('relayed', ALICE)]);
      assert.equal(getZrdtProvenance(db, 'c1')[0]?.byAci, BOB);

      upsertZrdtProvenance(db, [row('live')]);
      upsertZrdtProvenance(db, [row('relayed', BOB)]);
      upsertZrdtProvenance(db, [row('imported')]);
      assert.deepEqual(simplify(getZrdtProvenance(db, 'c1')), [
        { ...row('live'), digest: hex(bytes(7)) },
      ]);
    });

    it("mode 'replace' downgrades (SALVAGE), keeping disownedBy", () => {
      upsertZrdtProvenance(db, [row('live', null, ALICE)]);
      upsertZrdtProvenance(db, [row('imported')], { mode: 'replace' });
      assert.deepEqual(simplify(getZrdtProvenance(db, 'c1')), [
        { ...row('imported', null, ALICE), digest: hex(bytes(7)) },
      ]);
    });

    it('marks disowned only on rows that exist', () => {
      upsertZrdtProvenance(db, [row('relayed', BOB)]);
      assert.equal(markZrdtDisowned(db, 'c1', [bytes(7), bytes(8)], ALICE), 1);
      const [only, ...rest] = getZrdtProvenance(db, 'c1');
      assert.equal(rest.length, 0);
      assert.equal(only?.disownedBy, ALICE);
      assert.equal(only?.kind, 'relayed');
    });
  });

  describe('messages lookups', () => {
    beforeEach(() => {
      insertData(db, 'messages', [
        {
          id: 'm1',
          conversationId: 'c1',
          type: 'incoming',
          received_at: 1,
          sent_at: 100,
          json: { id: 'm1', zrdtDigest: 'aa' },
        },
        {
          id: 'm2',
          conversationId: 'c1',
          type: 'outgoing',
          received_at: 2,
          sent_at: 200,
          json: { id: 'm2', zrdtDigest: 'bb' },
        },
        {
          id: 'm3',
          conversationId: 'c2',
          type: 'incoming',
          received_at: 3,
          sent_at: 300,
          json: { id: 'm3', zrdtDigest: 'aa' },
        },
        {
          id: 'g1',
          conversationId: 'c1',
          type: 'zrdt-gap',
          received_at: 4,
          sent_at: 399,
          json: { id: 'g1' },
        },
      ]);
    });

    it('maps digests to message ids within one conversation', () => {
      assert.deepEqual(getMessageIdsByZrdtDigest(db, 'c1', ['aa', 'cc']), [
        { digest: 'aa', messageId: 'm1' },
      ]);
      assert.deepEqual(getMessageIdsByZrdtDigest(db, 'c2', ['aa']), [
        { digest: 'aa', messageId: 'm3' },
      ]);
    });

    it('uses the expression index', () => {
      const plan = explain(
        db,
        sql`
          SELECT id FROM messages
          WHERE conversationId = ${'c1'}
            AND json_extract(json, '$.zrdtDigest') = ${'aa'};
        `
      );
      assert.match(plan, /messages_zrdtDigest/);
    });

    it('lists gap rows', () => {
      assert.deepEqual(getZrdtGapMessageIds(db, 'c1'), ['g1']);
      assert.deepEqual(getZrdtGapMessageIds(db, 'c2'), []);
    });
  });

  describe('cleanup', () => {
    beforeEach(() => {
      for (const conversationId of ['c1', 'c2']) {
        insertZrdtRecord(db, {
          conversationId,
          digest: bytes(1),
          record: bytes(1),
        });
        insertZrdtPending(db, {
          conversationId,
          digest: bytes(2),
          record: bytes(2),
          messageId: null,
        });
        upsertZrdtProvenance(db, [
          {
            conversationId,
            digest: bytes(1),
            kind: 'live',
            byAci: null,
            disownedBy: null,
          },
        ]);
      }
    });

    function counts(conversationId: string): [number, number, number] {
      return [
        getZrdtRecords(db, conversationId).length,
        getZrdtPending(db, conversationId).length,
        getZrdtProvenance(db, conversationId).length,
      ];
    }

    it('deleteZrdtForConversation removes one conversation', () => {
      deleteZrdtForConversation(db, 'c1');
      assert.deepEqual(counts('c1'), [0, 0, 0]);
      assert.deepEqual(counts('c2'), [1, 1, 1]);
    });

    it('_removeConversation removes its zrdt rows', () => {
      insertData(db, 'conversations', [{ id: 'c1' }]);
      DataWriter._removeConversation(db, 'c1');
      assert.deepEqual(counts('c1'), [0, 0, 0]);
      assert.deepEqual(counts('c2'), [1, 1, 1]);
    });

    it('removeAll clears every zrdt table', () => {
      DataWriter.removeAll(db);
      assert.deepEqual(counts('c1'), [0, 0, 0]);
      assert.deepEqual(counts('c2'), [0, 0, 0]);
    });
  });

  describe('makeZrdtGapMessageAttributes', () => {
    it('takes the referencing message received_at with sent_at - 1', () => {
      const gap = makeZrdtGapMessageAttributes({
        id: 'gap-id',
        conversationId: 'c1',
        referencing: {
          id: 'm1',
          received_at: 42,
          sent_at: 1000,
          sourceServiceId: BOB,
        },
        missingDigests: ['aa'],
      });
      assert.equal(gap.type, 'zrdt-gap');
      assert.equal(gap.received_at, 42);
      assert.equal(gap.sent_at, 999);
      assert.equal(gap.timestamp, 999);
      assert.deepEqual(gap.zrdtGap, {
        missingDigests: ['aa'],
        referencedBy: 'm1',
        referencedByAci: BOB,
        state: 'waiting',
      });
    });
  });
});
