// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { renderToStaticMarkup } from 'react-dom/server';

import type {
  BtPieceView,
  BtTransferView,
} from '../../../../zrdt/apps/bt/manager.std.ts';
import { PIECE_BYTES } from '../../../../zrdt/apps/bt/manager.std.ts';
import { BtManager } from '../../../../zrdt/apps/bt/manager.std.ts';
import {
  ZrdtGroupFiles,
  ZrdtGroupFilesView,
} from '../../../../zrdt/apps/ui/ZrdtGroupFiles.dom.tsx';
import {
  ZrdtShareFileDialog,
  ZrdtShareFileDialogHost,
  ZrdtShareQuestions,
} from '../../../../zrdt/apps/ui/ZrdtShareFileDialog.dom.tsx';
import { ZrdtTransferRow } from '../../../../zrdt/apps/ui/ZrdtTransferRow.dom.tsx';
import { FakeBtApi, fileBytes } from '../bt/fakeBtApi.std.ts';
import { MemoryWriter } from '../bt/memoryWriter.std.ts';

const noop = (): void => undefined;
const alice = { aci: 'aci-alice', name: 'Alice' };
const bob = { aci: 'aci-bob', name: 'Bob' };
const D = 'ab'.repeat(32);

// renderToStaticMarkup escapes apostrophes; compare on decoded text.
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function transfer(over: Partial<BtTransferView>): BtTransferView {
  return {
    id: D,
    conversationId: 'conv',
    direction: 'in',
    announcement: D,
    name: 'trip.mp4',
    size: 20 * PIECE_BYTES,
    author: alice,
    phase: 'fetching',
    pieces: [],
    checked: 0,
    resent: [],
    notices: [],
    audience: undefined,
    savedTo: undefined,
    failure: undefined,
    ...over,
  };
}

function pieces(n: number, p: BtPieceView): Array<BtPieceView> {
  return Array.from({ length: n }, () => p);
}

const CHECKED: BtPieceView = { state: 'checked', source: { kind: 'cdn' } };

describe('zrdt/apps/ui render', () => {
  it('the share dialog asks the question of BUILD_M1 §A.1', () => {
    const html = renderToStaticMarkup(
      <ZrdtShareFileDialog
        question={{
          groupTitle: 'Camping',
          memberCount: 4,
          name: 'trip.mp4',
          size: 20 * PIECE_BYTES,
        }}
        onShare={noop}
        onCancel={noop}
      />
    );
    assert.include(
      text(html),
      'Share trip.mp4 (20 MiB) with Camping (4 members)?'
    );
    assert.include(html, 'role="dialog"');
    assert.include(text(html), 'Cancel');
    assert.include(text(html), 'Share');
  });

  it('the dialog host shows the first waiting question, answers resolve it', async () => {
    const questions = new ZrdtShareQuestions();
    assert.strictEqual(
      renderToStaticMarkup(<ZrdtShareFileDialogHost questions={questions} />),
      ''
    );
    const answer = questions.confirmShare({
      conversationId: 'conv',
      groupTitle: 'Camping',
      memberCount: 3,
      name: 'a.txt',
      size: 10,
    });
    const second = questions.confirmShare({
      conversationId: 'conv',
      groupTitle: 'Camping',
      memberCount: 3,
      name: 'b.txt',
      size: 10,
    });
    assert.include(
      text(
        renderToStaticMarkup(<ZrdtShareFileDialogHost questions={questions} />)
      ),
      'Share a.txt (10 bytes) with Camping (3 members)?'
    );
    questions.answer(true);
    assert.isTrue(await answer);
    assert.include(
      text(
        renderToStaticMarkup(<ZrdtShareFileDialogHost questions={questions} />)
      ),
      'Share b.txt'
    );
    questions.answer(false);
    assert.isFalse(await second);
    assert.isUndefined(questions.current());
  });

  it('a row while fetching: progress and one cell per piece', () => {
    const html = renderToStaticMarkup(
      <ZrdtTransferRow
        transfer={transfer({
          phase: 'fetching',
          pieces: [...pieces(17, CHECKED), ...pieces(3, { state: 'fetching' })],
          checked: 17,
        })}
      />
    );
    assert.include(text(html), 'trip.mp4');
    assert.include(text(html), '20 MiB · from Alice');
    assert.include(text(html), '17 of 20 pieces checked');
    assert.strictEqual(html.match(/data-piece=/g)?.length, 20);
    assert.include(html, 'title="piece 18: downloading"');
    assert.include(html, 'ZrdtSpinner');
  });

  it("Carol's row after repair: checked, resent by Bob, Dave's failed piece", () => {
    const all = pieces(20, CHECKED).map((p, i) =>
      [2, 6, 11, 14].includes(i)
        ? ({
            state: 'checked',
            source: { kind: 'member', member: bob },
          } as const)
        : p
    );
    const html = renderToStaticMarkup(
      <ZrdtTransferRow
        transfer={transfer({
          phase: 'checked',
          pieces: all,
          checked: 20,
          resent: [{ member: bob, pieces: [2, 6, 11, 14] }],
          notices: ['piece 7 from Dave failed its check'],
          savedTo: '/Users/carol/Downloads/trip/trip.mp4',
        })}
        onShowFile={noop}
      />
    );
    const t = text(html);
    assert.include(t, 'Checked: every piece passed its check');
    assert.include(t, 'pieces 3, 7, 12 and 15 resent by Bob');
    assert.include(t, 'piece 7 from Dave failed its check');
    assert.include(t, 'Show in folder');
    assert.include(html, 'title="piece 7: checked, resent by Bob"');
    assert.include(html, 'role="alert"');
    assert.notInclude(html, 'ZrdtSpinner');
    assert.include(html, 'data-phase="checked"');
  });

  it('an offered row has Download; a failed one says why and has Try again', () => {
    const offered = renderToStaticMarkup(
      <ZrdtTransferRow
        transfer={transfer({
          phase: 'offered',
          pieces: pieces(2, { state: 'waiting' }),
        })}
        onDownload={noop}
      />
    );
    assert.include(text(offered), 'Not downloaded');
    assert.include(text(offered), 'Download');

    const failed = renderToStaticMarkup(
      <ZrdtTransferRow
        transfer={transfer({
          phase: 'failed',
          pieces: [CHECKED, { state: 'unavailable' }],
          checked: 1,
          failure: { kind: 'incomplete', missing: [1] },
        })}
        onDownload={noop}
      />
    );
    assert.include(
      text(failed),
      'piece 2 did not pass a check from anyone who has it'
    );
    assert.include(text(failed), 'Try again');
    assert.include(failed, 'title="piece 2: nobody had it"');
  });

  it('an outgoing row: shared by you, no Download', () => {
    const html = renderToStaticMarkup(
      <ZrdtTransferRow
        transfer={transfer({
          direction: 'out',
          phase: 'checked',
          pieces: pieces(2, { state: 'checked', source: { kind: 'local' } }),
          checked: 2,
          audience: 4,
        })}
        onDownload={noop}
      />
    );
    assert.include(text(html), 'shared by you');
    assert.include(text(html), 'Shared with 4 members: every piece checked');
    assert.notInclude(text(html), 'Download');
    assert.notInclude(text(html), 'Try again');
  });

  it('the group view: "Share a file" and the rows', () => {
    const html = renderToStaticMarkup(
      <ZrdtGroupFilesView
        transfers={[transfer({ phase: 'offered' })]}
        onPickFile={noop}
        onDownload={noop}
      />
    );
    assert.include(text(html), 'Share a file');
    assert.include(html, 'type="file"');
    assert.strictEqual(html.match(/data-testid="ZrdtTransferRow"/g)?.length, 1);
  });

  it("ZrdtGroupFiles shows the manager's rows of its group only", async () => {
    const api = new FakeBtApi();
    const manager = new BtManager({
      api,
      writer: new MemoryWriter(),
      confirmShare: async () => true,
    });
    const camping = api.addFile({
      name: 'trip.mp4',
      bytes: fileBytes(10),
      author: alice,
    });
    const work = api.addFile({
      name: 'report.pdf',
      bytes: fileBytes(10),
      author: alice,
    });
    await manager.onAnnouncement({
      conversationId: 'camping',
      announcement: camping,
      author: alice,
      confirmedByAuthor: true,
    });
    await manager.onAnnouncement({
      conversationId: 'work',
      announcement: work,
      author: alice,
      confirmedByAuthor: true,
    });
    const html = renderToStaticMarkup(
      <ZrdtGroupFiles
        manager={manager}
        conversationId="camping"
        groupTitle="Camping"
        memberCount={4}
        self={bob}
      />
    );
    assert.include(text(html), 'trip.mp4');
    assert.include(text(html), 'Checked: every piece passed its check');
    assert.notInclude(text(html), 'report.pdf');
  });
});
