// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import type { ChooseLabelInput } from '../../../zrdt/ui/labels.std.ts';
import {
  OWN_NAME_ALARM_TEXT,
  UNAVAILABLE_TEXT,
  chooseProvenanceLabel,
  contentUnavailableText,
  gapTitle,
  identicalText,
  labelText,
  labelTooltip,
  rejectedText,
  salvageReportText,
  theyAreBehindText,
  unconfirmedSectionTitle,
  withheldText,
  youAreBehindText,
} from '../../../zrdt/ui/labels.std.ts';

const ALICE = 'aci-alice';
const BOB = 'aci-bob';
const NAMES: Record<string, string> = { [ALICE]: 'Alice', [BOB]: 'Bob' };
const nameOf = (aci: string): string => NAMES[aci] ?? 'Unknown';
const K7F2 = `c7f2${'0'.repeat(60)}`;
const N9AC1 = `9ac1${'1'.repeat(60)}`;

function input(over: Partial<ChooseLabelInput>): ChooseLabelInput {
  return {
    status: { kind: 'unconfirmed' },
    provenance: { kind: 'live' },
    authorAci: ALICE,
    arrivedIndirectly: false,
    nameOf,
    ...over,
  };
}

describe('zrdt/ui/labels', () => {
  it('words the gap row as in the demo', () => {
    assert.strictEqual(
      gapTitle(1, 'Bob'),
      "1 message you haven't received. Bob replied to it."
    );
    assert.strictEqual(
      gapTitle(2, 'Bob'),
      "2 messages you haven't received. Bob replied to them."
    );
    assert.strictEqual(
      contentUnavailableText('Alice'),
      'A message from Alice (content unavailable)'
    );
  });

  it('words the compare outcomes as in the demo', () => {
    assert.strictEqual(
      withheldText('Bob', [K7F2]),
      "Bob has 1 message you don't (·c7f2). Asked; no answer."
    );
    assert.strictEqual(
      youAreBehindText('Bob', [K7F2]),
      "Bob has 1 message you don't (·c7f2)."
    );
  });

  it('words the rejected banner as in the demo', () => {
    assert.strictEqual(
      rejectedText({ kind: 'unverifiable', missing: [N9AC1] }),
      'This copy of the chat does not verify: message ·9ac1 is missing'
    );
    assert.strictEqual(
      rejectedText({ kind: 'unverifiable', missing: [N9AC1, K7F2] }),
      'This copy of the chat does not verify: messages ·9ac1 and ·c7f2 are missing'
    );
    assert.include(salvageReportText(5, [N9AC1]), 'Dropped 1 message: ·9ac1');
  });

  it('never mentions the server or blames anyone', () => {
    const texts = [
      gapTitle(1, 'Bob'),
      contentUnavailableText('Alice'),
      withheldText('Bob', [K7F2]),
      youAreBehindText('Bob', [K7F2]),
      identicalText('Bob'),
      theyAreBehindText('Bob'),
      rejectedText({ kind: 'unverifiable', missing: [N9AC1] }),
      rejectedText({ kind: 'malformed' }),
      rejectedText({ kind: 'too-large' }),
      rejectedText({ kind: 'wrong-chat' }),
      rejectedText({ kind: 'collision', digest: N9AC1 }),
      UNAVAILABLE_TEXT,
      OWN_NAME_ALARM_TEXT,
      unconfirmedSectionTitle(3),
    ];
    for (const text of texts) {
      assert.notMatch(
        text,
        /\b(?:server|attack\w*|malicious|forg\w*|lied|tamper\w*)\b/i,
        text
      );
    }
  });

  it('labels per the CLASSIFY precedence', () => {
    // Normal live message confirmed by its author: no label.
    assert.isNull(
      chooseProvenanceLabel(input({ status: { kind: 'confirmedByAuthor' } }))
    );
    // Relayed first, then confirmed: "confirmed by Alice".
    assert.deepEqual(
      chooseProvenanceLabel(
        input({
          status: { kind: 'confirmedByAuthor' },
          arrivedIndirectly: true,
        })
      ),
      { kind: 'confirmed', name: 'Alice' }
    );
    // Relayed by Bob; Bob's reply reaches it (heldBy Bob): "relayed by Bob".
    assert.deepEqual(
      chooseProvenanceLabel(
        input({
          status: { kind: 'heldBy', aci: BOB },
          provenance: { kind: 'relayed', byAci: BOB },
          arrivedIndirectly: true,
        })
      ),
      { kind: 'relayed', name: 'Bob' }
    );
    // Imported, held by Alice.
    assert.deepEqual(
      chooseProvenanceLabel(
        input({
          authorAci: BOB,
          status: { kind: 'heldBy', aci: ALICE },
          provenance: { kind: 'imported' },
          arrivedIndirectly: true,
        })
      ),
      { kind: 'held', name: 'Alice' }
    );
    // Disowned fake in Bob's name: "not confirmed by Bob", even if relayed.
    assert.deepEqual(
      chooseProvenanceLabel(
        input({
          authorAci: BOB,
          status: { kind: 'notConfirmedByAuthor' },
          provenance: { kind: 'relayed', byAci: ALICE },
        })
      ),
      { kind: 'not-confirmed', name: 'Bob' }
    );
    assert.deepEqual(
      chooseProvenanceLabel(input({ provenance: { kind: 'imported' } })),
      { kind: 'unconfirmed' }
    );
  });

  it('renders label text', () => {
    assert.strictEqual(
      labelText({ kind: 'relayed', name: 'Bob' }),
      'relayed by Bob'
    );
    assert.strictEqual(
      labelText({ kind: 'confirmed', name: 'Alice' }),
      'confirmed by Alice'
    );
    assert.strictEqual(
      labelText({ kind: 'held', name: 'Alice' }),
      'held by Alice'
    );
    assert.strictEqual(labelText({ kind: 'unconfirmed' }), 'unconfirmed');
    assert.strictEqual(
      labelText({ kind: 'not-confirmed', name: 'Bob' }),
      'not confirmed by Bob'
    );
    assert.isString(labelTooltip({ kind: 'held', name: 'Alice' }));
  });

  it('counts unconfirmed messages', () => {
    assert.strictEqual(
      unconfirmedSectionTitle(1),
      '1 message not yet confirmed by any member'
    );
    assert.strictEqual(
      unconfirmedSectionTitle(4),
      '4 messages not yet confirmed by any member'
    );
  });
});
