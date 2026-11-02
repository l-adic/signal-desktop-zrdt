// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import type {
  BtMember,
  BtShareQuestion,
  BtTransferView,
} from '../../../../zrdt/apps/bt/manager.std.ts';
import {
  AUTO_FETCH_MAX_BYTES,
  BtManager,
  MAX_FILE_BYTES,
  PIECE_BYTES,
  formatSize,
  pieceCount,
  pieceFailedText,
  pieceTitle,
  piecesCheckedText,
  resentSummaryText,
  safeComponent,
  shareQuestion,
  statusText,
  uploadFailedText,
} from '../../../../zrdt/apps/bt/manager.std.ts';
import { FakeBtApi, fileBytes } from './fakeBtApi.std.ts';
import { MemoryWriter } from './memoryWriter.std.ts';

const alice: BtMember = { aci: 'aci-alice', name: 'Alice' };
const bob: BtMember = { aci: 'aci-bob', name: 'Bob' };
const dave: BtMember = { aci: 'aci-dave', name: 'Dave' };
const CONV = 'conv-camping';

function setup(confirm: boolean | ((q: BtShareQuestion) => boolean) = true) {
  const api = new FakeBtApi();
  const writer = new MemoryWriter();
  const questions: Array<BtShareQuestion> = [];
  const log: Array<string> = [];
  const manager = new BtManager({
    api,
    writer,
    confirmShare: async q => {
      questions.push(q);
      return typeof confirm === 'function' ? confirm(q) : confirm;
    },
    log: line => log.push(line),
  });
  return { api, writer, questions, log, manager };
}

function only(manager: BtManager): BtTransferView {
  const all = manager.transfers();
  assert.lengthOf(all, 1);
  const [t] = all;
  if (t === undefined) {
    throw new Error('no transfer');
  }
  return t;
}

describe('zrdt/apps/bt/manager', () => {
  describe('safeComponent (BUILD_M1 §B.6)', () => {
    it('accepts ordinary names', () => {
      for (const name of [
        'trip.mp4',
        'a',
        'Photos 2026.zip',
        'été.txt',
        'x'.repeat(255),
      ]) {
        assert.isTrue(safeComponent(name), name);
      }
    });

    it('refuses every rule', () => {
      const bad = [
        '',
        '.',
        '..',
        'a/b',
        'a\\b',
        'a:b',
        'a<b',
        'a>b',
        'a"b',
        'a|b',
        'a?b',
        'a*b',
        'a\u0000b',
        'a\u001fb',
        'a\u007fb',
        ' lead',
        'trail ',
        '.hidden',
        'dot.',
        'CON',
        'con.txt',
        'Lpt9.mp4',
        'COM1',
        'aux',
        'é'.repeat(128), // 256 bytes of UTF-8
        '\ud800',
      ];
      for (const name of bad) {
        assert.isFalse(safeComponent(name), JSON.stringify(name));
      }
    });
  });

  describe('wording', () => {
    it('sizes and the share question (§A.1 step 1)', () => {
      assert.strictEqual(formatSize(20 * PIECE_BYTES), '20 MiB');
      assert.strictEqual(formatSize(300 * 1024), '300 KiB');
      assert.strictEqual(formatSize(1536 * 1024), '1.5 MiB');
      assert.strictEqual(formatSize(512), '512 bytes');
      assert.strictEqual(
        shareQuestion({
          groupTitle: 'Camping',
          memberCount: 4,
          name: 'trip.mp4',
          size: 20 * PIECE_BYTES,
        }),
        'Share trip.mp4 (20 MiB) with Camping (4 members)?'
      );
    });

    it('pieces count from 1 for people', () => {
      assert.strictEqual(
        pieceFailedText(6, 'Dave'),
        'piece 7 from Dave failed its check'
      );
      assert.strictEqual(
        uploadFailedText(4, 'Alice'),
        'piece 5 as uploaded by Alice failed its check'
      );
      assert.strictEqual(piecesCheckedText(17, 20), '17 of 20 pieces checked');
      assert.strictEqual(
        resentSummaryText({ member: bob, pieces: [2, 6, 11, 14] }),
        'pieces 3, 7, 12 and 15 resent by Bob'
      );
      assert.strictEqual(
        resentSummaryText({ member: bob, pieces: [2] }),
        'piece 3 resent by Bob'
      );
      assert.strictEqual(
        pieceTitle(2, {
          state: 'checked',
          source: { kind: 'member', member: bob },
        }),
        'piece 3: checked, resent by Bob'
      );
    });

    it('never mentions the server', () => {
      const texts = [
        pieceTitle(0, { state: 'missing', reason: 'notFound' }),
        pieceTitle(0, { state: 'missing', reason: 'badMac' }),
        pieceTitle(0, { state: 'missing', reason: 'badReply' }),
        pieceTitle(0, { state: 'unavailable' }),
      ];
      for (const text of texts) {
        assert.notMatch(text, /server/i);
      }
    });
  });

  describe('sharing', () => {
    it('asks first, then publishes; every piece checked from the local file', async () => {
      const { api, questions, manager } = setup(true);
      const stream = fileBytes(2 * PIECE_BYTES + 5);
      const outcome = await manager.share({
        conversationId: CONV,
        groupTitle: 'Camping',
        memberCount: 4,
        self: alice,
        name: 'trip.mp4',
        stream,
      });
      assert.strictEqual(outcome.kind, 'published');
      assert.lengthOf(questions, 1);
      assert.deepEqual(questions[0], {
        conversationId: CONV,
        groupTitle: 'Camping',
        memberCount: 4,
        name: 'trip.mp4',
        size: stream.byteLength,
      });
      assert.deepEqual(
        api.calls.map(c => c.op),
        ['publish']
      );
      const t = only(manager);
      assert.strictEqual(t.direction, 'out');
      assert.strictEqual(t.phase, 'checked');
      assert.strictEqual(t.checked, 3);
      assert.strictEqual(t.audience, 4);
      assert.strictEqual(
        statusText(t),
        'Shared with 4 members: every piece checked'
      );
      if (outcome.kind === 'published') {
        assert.strictEqual(t.announcement, outcome.announcement);
        assert.strictEqual(manager.transfer(outcome.announcement)?.id, t.id);
      }
    });

    it('shows the row while the dialog is open', async () => {
      let release: (ok: boolean) => void = () => undefined;
      const api = new FakeBtApi();
      const manager = new BtManager({
        api,
        writer: new MemoryWriter(),
        confirmShare: () =>
          new Promise<boolean>(resolve => {
            release = resolve;
          }),
      });
      const pending = manager.share({
        conversationId: CONV,
        groupTitle: 'Camping',
        memberCount: 4,
        self: alice,
        name: 'trip.mp4',
        stream: fileBytes(10),
      });
      await Promise.resolve();
      assert.strictEqual(only(manager).phase, 'confirming');
      assert.lengthOf(api.calls, 0, 'nothing is published before Share');
      release(false);
      assert.deepEqual(await pending, { kind: 'declined' });
      assert.lengthOf(manager.transfers(), 0);
    });

    it('declined: nothing is published, no row', async () => {
      const { api, manager } = setup(false);
      const outcome = await manager.share({
        conversationId: CONV,
        groupTitle: 'Camping',
        memberCount: 4,
        self: alice,
        name: 'trip.mp4',
        stream: fileBytes(10),
      });
      assert.deepEqual(outcome, { kind: 'declined' });
      assert.lengthOf(api.calls, 0);
      assert.lengthOf(manager.transfers(), 0);
    });

    it('refuses before the dialog: empty, too large, unsafe name', async () => {
      const { api, questions, manager } = setup(true);
      const base = {
        conversationId: CONV,
        groupTitle: 'Camping',
        memberCount: 4,
        self: alice,
      };
      assert.strictEqual(
        (await manager.share({ ...base, name: 'a', stream: new Uint8Array(0) }))
          .kind,
        'refused'
      );
      const big = await manager.share({
        ...base,
        name: 'big.bin',
        stream: new Uint8Array(MAX_FILE_BYTES + 1),
      });
      assert.deepInclude(big, { kind: 'refused', reason: 'tooLarge' });
      const bad = await manager.share({
        ...base,
        name: '../etc/passwd',
        stream: fileBytes(3),
      });
      assert.deepInclude(bad, { kind: 'refused', reason: 'badName' });
      assert.lengthOf(questions, 0);
      assert.lengthOf(api.calls, 0);
      assert.lengthOf(manager.transfers(), 0);
    });

    it('a refused publish leaves a failed row that says why', async () => {
      const { api, manager } = setup(true);
      api.refusePublish = 'badName';
      const outcome = await manager.share({
        conversationId: CONV,
        groupTitle: 'Camping',
        memberCount: 4,
        self: alice,
        name: 'trip.mp4',
        stream: fileBytes(10),
      });
      assert.deepInclude(outcome, { kind: 'refused', reason: 'badName' });
      const t = only(manager);
      assert.strictEqual(t.phase, 'failed');
      assert.strictEqual(statusText(t), 'Not shared: badName');
    });
  });

  describe('receiving', () => {
    it('fetches a confirmed file at once, saves it, and checks the saved bytes', async () => {
      const { api, writer, manager } = setup();
      const bytes = fileBytes(3 * PIECE_BYTES);
      const a = api.addFile({ name: 'trip.mp4', bytes, author: alice });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      const t = only(manager);
      assert.strictEqual(t.phase, 'checked');
      assert.strictEqual(t.checked, 3);
      assert.strictEqual(t.savedTo, '/downloads/1/trip.mp4');
      assert.deepEqual(writer.files.get('/downloads/1/trip.mp4'), bytes);
      assert.deepEqual(
        api.calls.map(c => c.op),
        ['bind', 'file', 'fetchPieces', 'readStream', 'assemble']
      );
      assert.strictEqual(
        statusText(t),
        'Checked: every piece passed its check'
      );
      assert.lengthOf(t.resent, 0);
      assert.lengthOf(t.notices, 0);
    });

    it('waits for a click when not confirmed by its author, or over 32 MiB (T-M4)', async () => {
      const { api, manager } = setup();
      const relayed = api.addFile({
        name: 'a.bin',
        bytes: fileBytes(10),
        author: alice,
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: relayed,
        author: alice,
        confirmedByAuthor: false,
      });
      const big = api.addFile({
        name: 'big.bin',
        bytes: new Uint8Array(AUTO_FETCH_MAX_BYTES + 1),
        author: alice,
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: big,
        author: alice,
        confirmedByAuthor: true,
      });
      assert.deepEqual(
        manager.transfers().map(t => t.phase),
        ['offered', 'offered']
      );
      assert.notInclude(
        api.calls.map(c => c.op),
        'fetchPieces'
      );
      await manager.download(relayed);
      assert.strictEqual(manager.transfer(relayed)?.phase, 'checked');
    });

    it('never offers an announcement that does not seat us (T-m12)', async () => {
      const { api, manager } = setup();
      const a = api.addFile({
        name: 'secret.bin',
        bytes: fileBytes(10),
        author: alice,
        notSeated: true,
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      assert.lengthOf(manager.transfers(), 0);
      assert.deepEqual(
        api.calls.map(c => c.op),
        ['bind']
      );
    });

    it('never offers a file whose BT_FILE disagrees with its binding', async () => {
      const { api, manager } = setup();
      const a = api.addFile({
        name: 'x.bin',
        bytes: fileBytes(10),
        author: alice,
      });
      const original = api.file;
      Object.defineProperty(api, 'file', {
        value: async (d: string) => {
          const f = await original(d);
          return f.kind === 'file' ? { ...f, size: f.size + 1 } : f;
        },
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      assert.lengthOf(manager.transfers(), 0);
    });

    it('ignores a second delivery of the same announcement', async () => {
      const { api, manager } = setup();
      const a = api.addFile({
        name: 'x.bin',
        bytes: fileBytes(10),
        author: alice,
      });
      const ann = {
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      };
      await Promise.all([
        manager.onAnnouncement(ann),
        manager.onAnnouncement(ann),
      ]);
      await manager.onAnnouncement(ann);
      assert.lengthOf(manager.transfers(), 1);
      assert.lengthOf(
        api.calls.filter(c => c.op === 'bind'),
        1
      );
    });

    it("Carol's repair (§A.1 steps 4-5): resent by Bob, Dave's piece failed its check", async () => {
      const { api, manager } = setup();
      const carolsView: Array<BtTransferView> = [];
      manager.subscribe(() => {
        const [t] = manager.transfers();
        if (t !== undefined) {
          carolsView.push(t);
        }
      });
      // 1-based pieces 3, 7, 12 deleted; 15 corrupted on its way to Carol.
      const a = api.addFile({
        name: 'trip.mp4',
        bytes: fileBytes(20 * PIECE_BYTES),
        author: alice,
        cdn: new Map([
          [2, 'notFound'],
          [6, 'notFound'],
          [11, 'notFound'],
          [14, 'badMac'],
        ]),
        repair: new Map([
          [
            2,
            [
              [alice, 'silent'],
              [bob, 'good'],
            ],
          ],
          [
            6,
            [
              [dave, 'tamper'],
              [bob, 'good'],
            ],
          ],
          [11, [[bob, 'good']]],
          [14, [[bob, 'good']]],
        ]),
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      const t = only(manager);
      assert.strictEqual(t.phase, 'checked');
      assert.strictEqual(t.checked, 20);
      assert.deepEqual(t.notices, ['piece 7 from Dave failed its check']);
      assert.lengthOf(t.resent, 1);
      assert.strictEqual(t.resent[0]?.member.name, 'Bob');
      assert.deepEqual(t.resent[0]?.pieces, [2, 6, 11, 14]);
      assert.strictEqual(
        resentSummaryText(t.resent[0] ?? { member: bob, pieces: [] }),
        'pieces 3, 7, 12 and 15 resent by Bob'
      );
      // Along the way: the row went through repair, and asked Alice and Dave.
      assert.include(
        carolsView.map(v => v.phase),
        'repairing'
      );
      const asked = new Set(
        carolsView.flatMap(v =>
          v.pieces.flatMap(p => (p.state === 'asking' ? [p.member.name] : []))
        )
      );
      assert.deepEqual([...asked].sort(), ['Alice', 'Bob', 'Dave']);
      const midway = carolsView.find(v => v.phase === 'repairing');
      assert.match(
        midway === undefined ? '' : statusText(midway),
        /^16 of 20 pieces checked$/
      );
    });

    it('a piece nobody can give: failed, then "Try again" finishes', async () => {
      const { api, manager } = setup();
      const repair = new Map([[1, [[bob, 'silent'] as const]]]);
      const file = {
        name: 'x.bin',
        bytes: fileBytes(2 * PIECE_BYTES),
        author: alice,
        cdn: new Map([[1, 'notFound' as const]]),
        repair,
      };
      const a = api.addFile(file);
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      let t = only(manager);
      assert.strictEqual(t.phase, 'failed');
      assert.deepEqual(t.failure, { kind: 'incomplete', missing: [1] });
      assert.strictEqual(t.pieces[1]?.state, 'unavailable');
      assert.strictEqual(
        statusText(t),
        'piece 2 did not pass a check from anyone who has it'
      );

      file.cdn.clear();
      await manager.download(a);
      t = only(manager);
      assert.strictEqual(t.phase, 'checked');
      assert.isDefined(t.savedTo);
    });

    it('CDN bytes that fail the check name the upload, not a member', async () => {
      const { api, manager } = setup();
      const a = api.addFile({
        name: 'x.bin',
        bytes: fileBytes(2 * PIECE_BYTES),
        author: alice,
        cdn: new Map([[0, 'badUpload' as const]]),
        repair: new Map([[0, [[bob, 'good'] as const]]]),
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      const t = only(manager);
      assert.deepEqual(t.notices, [
        'piece 1 as uploaded by Alice failed its check',
      ]);
      assert.strictEqual(t.phase, 'checked');
    });

    it('a saved file that fails ASSEMBLE is removed and the row says so', async () => {
      const { api, writer, manager } = setup();
      const a = api.addFile({
        name: 'x.bin',
        bytes: fileBytes(2 * PIECE_BYTES),
        author: alice,
      });
      writer.lie = fileBytes(2 * PIECE_BYTES, 99);
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      const t = only(manager);
      assert.strictEqual(t.phase, 'failed');
      assert.deepEqual(t.failure, { kind: 'notSaved', index: 0 });
      assert.isUndefined(t.savedTo);
      assert.deepEqual(writer.discarded, ['/downloads/1/x.bin']);
      assert.match(
        statusText(t),
        /failed its check at piece 1; it was removed/
      );
    });

    it('a backend error stops the row, which can try again', async () => {
      const { api, manager, log } = setup();
      const a = api.addFile({
        name: 'x.bin',
        bytes: fileBytes(5),
        author: alice,
      });
      const original = api.readStream;
      let fail = true;
      Object.defineProperty(api, 'readStream', {
        value: async (d: string) => {
          if (fail) {
            fail = false;
            throw new Error('daemon timeout');
          }
          return original(d);
        },
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      assert.strictEqual(only(manager).phase, 'failed');
      assert.strictEqual(statusText(only(manager)), 'Stopped: daemon timeout');
      assert.isTrue(log.some(line => line.includes('daemon timeout')));
      await manager.download(a);
      assert.strictEqual(only(manager).phase, 'checked');
    });

    it('ignores events for pieces that do not exist, and keeps checked pieces checked', async () => {
      const { manager, api } = setup();
      const a = api.addFile({
        name: 'x.bin',
        bytes: fileBytes(5),
        author: alice,
      });
      const original = api.fetchPieces;
      Object.defineProperty(api, 'fetchPieces', {
        value: async (d: string, onPiece: Parameters<typeof original>[1]) => {
          onPiece({ kind: 'checked', index: 0, source: { kind: 'cdn' } });
          onPiece({ kind: 'cdnFailed', index: 0, reason: 'notFound' });
          onPiece({ kind: 'fetching', index: 5 });
          onPiece({ kind: 'fetching', index: -1 });
          return original(d, onPiece);
        },
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      const t = only(manager);
      assert.deepEqual(t.pieces, [
        { state: 'checked', source: { kind: 'cdn' } },
      ]);
      assert.strictEqual(t.phase, 'checked');
    });
  });

  describe('reading', () => {
    it('keeps the same snapshot until something changes', async () => {
      const { api, manager } = setup();
      const first = manager.transfers();
      assert.strictEqual(manager.transfers(), first);
      let calls = 0;
      const unsubscribe = manager.subscribe(() => {
        calls += 1;
      });
      const a = api.addFile({
        name: 'x.bin',
        bytes: fileBytes(5),
        author: alice,
      });
      await manager.onAnnouncement({
        conversationId: CONV,
        announcement: a,
        author: alice,
        confirmedByAuthor: true,
      });
      assert.isAbove(calls, 0);
      assert.notStrictEqual(manager.transfers(), first);
      assert.strictEqual(manager.transfers(), manager.transfers());
      unsubscribe();
      const before = calls;
      await manager.download(a); // not failed or offered: nothing happens
      assert.strictEqual(calls, before);
      assert.lengthOf(manager.transfersOf('other'), 0);
      assert.lengthOf(manager.transfersOf(CONV), 1);
    });

    it('pieceCount', () => {
      assert.strictEqual(pieceCount(1), 1);
      assert.strictEqual(pieceCount(PIECE_BYTES), 1);
      assert.strictEqual(pieceCount(PIECE_BYTES + 1), 2);
      assert.strictEqual(pieceCount(MAX_FILE_BYTES), 64);
      assert.strictEqual(pieceCount(2048, 1024), 2);
    });
  });
});
