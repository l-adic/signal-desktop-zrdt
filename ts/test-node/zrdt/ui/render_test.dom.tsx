// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZrdtBackendBadge } from '../../../zrdt/ui/ZrdtBackendBadge.dom.tsx';
import { ZrdtCompareModal } from '../../../zrdt/ui/ZrdtCompareModal.dom.tsx';
import { ZrdtGapRow } from '../../../zrdt/ui/ZrdtGapRow.dom.tsx';
import {
  ZrdtCodeDetail,
  ZrdtMessageCode,
} from '../../../zrdt/ui/ZrdtMessageCode.dom.tsx';
import { ZrdtOwnNameAlarm } from '../../../zrdt/ui/ZrdtOwnNameAlarm.dom.tsx';
import { ZrdtProvenanceLabel } from '../../../zrdt/ui/ZrdtProvenanceLabel.dom.tsx';
import { ZrdtRejectedBanner } from '../../../zrdt/ui/ZrdtRejectedBanner.dom.tsx';
import { ZrdtUnavailableBanner } from '../../../zrdt/ui/ZrdtUnavailableBanner.dom.tsx';
import { ZrdtUnconfirmedSection } from '../../../zrdt/ui/ZrdtUnconfirmedSection.dom.tsx';
import { digestToWords } from '../../../zrdt/ui/words.std.ts';

const D = `9ac1${'0'.repeat(60)}`;
const K = `c7f2${'1'.repeat(60)}`;
const noop = (): void => undefined;

// renderToStaticMarkup escapes apostrophes; compare on decoded text.
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('zrdt/ui render', () => {
  it('ZrdtGapRow states', () => {
    const waiting = renderToStaticMarkup(
      <ZrdtGapRow state="waiting" count={1} replierName="Bob" />
    );
    assert.include(
      text(waiting),
      "1 message you haven't received. Bob replied to it."
    );
    assert.include(waiting, 'ZrdtSpinner');
    assert.notInclude(waiting, 'Ask again');

    const requested = renderToStaticMarkup(
      <ZrdtGapRow state="requested" count={1} replierName="Bob" />
    );
    assert.include(text(requested), 'Requested');

    const missing = renderToStaticMarkup(
      <ZrdtGapRow
        state="still-missing"
        count={1}
        replierName="Bob"
        digests={[D]}
        onAskAgain={noop}
      />
    );
    assert.include(text(missing), 'Still missing');
    assert.include(text(missing), 'Ask again');
    assert.include(text(missing), '·9ac1');

    const unavailable = renderToStaticMarkup(
      <ZrdtGapRow
        state="content-unavailable"
        count={1}
        replierName="Bob"
        authorName="Alice"
      />
    );
    assert.include(
      text(unavailable),
      'A message from Alice (content unavailable)'
    );
  });

  it('ZrdtProvenanceLabel', () => {
    assert.strictEqual(
      renderToStaticMarkup(<ZrdtProvenanceLabel label={null} />),
      ''
    );
    assert.include(
      renderToStaticMarkup(
        <ZrdtProvenanceLabel label={{ kind: 'relayed', name: 'Bob' }} />
      ),
      'relayed by Bob'
    );
    assert.include(
      renderToStaticMarkup(
        <ZrdtProvenanceLabel label={{ kind: 'not-confirmed', name: 'Bob' }} />
      ),
      'ZrdtLabel--not-confirmed'
    );
  });

  it('ZrdtCompareModal outcomes', () => {
    const base = {
      ourCode: `zrdt1:g:o:${D}`,
      ourWords: digestToWords(D),
      theirName: 'Bob',
      onCompare: noop,
      onAsk: noop,
      onClose: noop,
      onCopy: noop,
    };
    const ident = renderToStaticMarkup(
      <ZrdtCompareModal {...base} outcome={{ kind: 'identical' }} />
    );
    assert.include(text(ident), 'Copy compare code');
    assert.include(text(ident), 'Paste compare code');
    assert.include(text(ident), digestToWords(D).join(' '));
    assert.include(ident, `zrdt1:g:o:${D}`);
    assert.include(text(ident), 'Identical');

    const behind = renderToStaticMarkup(
      <ZrdtCompareModal
        {...base}
        outcome={{ kind: 'you-are-behind', missing: [K], asking: false }}
      />
    );
    assert.include(text(behind), "Bob has 1 message you don't (·c7f2).");
    assert.include(text(behind), 'Ask for it');

    const withheld = renderToStaticMarkup(
      <ZrdtCompareModal
        {...base}
        outcome={{ kind: 'withheld', missing: [K] }}
      />
    );
    assert.include(
      text(withheld),
      "Bob has 1 message you don't (·c7f2). Asked; no answer."
    );
    assert.include(text(withheld), 'Ask again');

    const theyBehind = renderToStaticMarkup(
      <ZrdtCompareModal {...base} outcome={{ kind: 'they-are-behind' }} />
    );
    assert.include(text(theyBehind), 'Bob is behind');
  });

  it('banners', () => {
    const rejected = renderToStaticMarkup(
      <ZrdtRejectedBanner
        reason={{ kind: 'unverifiable', missing: [D] }}
        onKeepWhatVerifies={noop}
        onImportCopy={noop}
      />
    );
    assert.include(
      text(rejected),
      'This copy of the chat does not verify: message ·9ac1 is missing'
    );
    assert.include(text(rejected), 'Keep what verifies');
    assert.include(text(rejected), 'Import a copy');

    const salvaged = renderToStaticMarkup(
      <ZrdtRejectedBanner
        reason={{ kind: 'unverifiable', missing: [D] }}
        salvage={{ kept: 4, dropped: [K] }}
        onKeepWhatVerifies={noop}
        onImportCopy={noop}
      />
    );
    assert.include(text(salvaged), 'Kept 4 messages that verify.');

    assert.include(
      text(renderToStaticMarkup(<ZrdtUnavailableBanner />)),
      'zrdt unavailable'
    );
    assert.include(
      text(renderToStaticMarkup(<ZrdtOwnNameAlarm digests={[D]} />)),
      'Someone linked a message in your name that you did not send.'
    );
    assert.strictEqual(
      renderToStaticMarkup(<ZrdtOwnNameAlarm digests={[]} />),
      ''
    );
  });

  it('ZrdtBackendBadge', () => {
    const lean = renderToStaticMarkup(
      <ZrdtBackendBadge kind="lean" version="1 (ab12cd3)" floating />
    );
    assert.include(text(lean), 'zrdt: lean 1 (ab12cd3)');
    assert.include(lean, 'ZrdtBackendBadge--lean');
    assert.include(lean, 'ZrdtBackendBadge__floating');
    const down = renderToStaticMarkup(
      <ZrdtBackendBadge kind="stub" version="0" available={false} />
    );
    assert.include(down, 'ZrdtBackendBadge--down');
    assert.include(text(down), '(unavailable)');
  });

  it('ZrdtUnconfirmedSection is collapsed, without avatars or links', () => {
    const items = [
      { digest: D, attributedTo: 'Bob', text: 'see https://example.com' },
      { digest: K, attributedTo: 'Bob' },
    ];
    const collapsed = renderToStaticMarkup(
      <ZrdtUnconfirmedSection items={items} />
    );
    assert.include(
      text(collapsed),
      '2 messages not yet confirmed by any member'
    );
    assert.notInclude(collapsed, 'example.com');
    const open = renderToStaticMarkup(
      <ZrdtUnconfirmedSection items={items} defaultExpanded />
    );
    assert.include(text(open), 'see https://example.com');
    assert.include(text(open), '(content unavailable)');
    assert.notInclude(open, '<a ');
    assert.notInclude(open, '<img');
    assert.strictEqual(
      renderToStaticMarkup(<ZrdtUnconfirmedSection items={[]} />),
      ''
    );
  });

  it('per-message code tag and detail', () => {
    assert.include(
      text(renderToStaticMarkup(<ZrdtMessageCode digest={D} />)),
      '·9ac1'
    );
    const detail = renderToStaticMarkup(<ZrdtCodeDetail digest={D} />);
    assert.include(text(detail), digestToWords(D).join(' '));
    assert.include(detail, D);
    assert.include(text(detail), 'Copy');
  });
});
