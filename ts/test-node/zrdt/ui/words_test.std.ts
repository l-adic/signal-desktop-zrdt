// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import {
  bytesToHex,
  digestTag,
  digestToWords,
  formatTag,
  formatTagList,
  hexToBytes,
  isDigestHex,
} from '../../../zrdt/ui/words.std.ts';

const D1 = `9ac1${'0'.repeat(60)}`;
const D2 = `0b3e${'1'.repeat(60)}`;
const D3 = `77aa${'2'.repeat(60)}`;
const D4 = `c7f2${'3'.repeat(60)}`;

describe('zrdt/ui/words', () => {
  it('round-trips hex', () => {
    const bytes = hexToBytes('00ff10ab');
    assert.deepEqual([...bytes], [0x00, 0xff, 0x10, 0xab]);
    assert.strictEqual(bytesToHex(bytes), '00ff10ab');
    assert.strictEqual(bytesToHex(hexToBytes('ABCD')), 'abcd');
    assert.throws(() => hexToBytes('abc'));
    assert.throws(() => hexToBytes('zz'));
  });

  it('recognises 64-char lowercase hex digests', () => {
    assert.isTrue(isDigestHex(D1));
    assert.isFalse(isDigestHex(D1.slice(1)));
    assert.isFalse(isDigestHex(D1.toUpperCase().replace('0', 'G')));
  });

  it('maps all-zero and all-one digests to the first and last words', () => {
    assert.deepEqual(
      digestToWords(new Uint8Array(32)),
      new Array(12).fill('abandon')
    );
    assert.deepEqual(
      digestToWords(new Uint8Array(32).fill(0xff)),
      new Array(12).fill('zoo')
    );
  });

  it('matches the BIP-39 vectors on the first 11 words (no checksum)', () => {
    // Vectors from BIP-39's vectors.json; word 12 there holds a checksum,
    // which zrdt replaces with the digest's next bits.
    assert.deepEqual(
      digestToWords('7f'.repeat(32)).slice(0, 11),
      'legal winner thank year wave sausage worth useful legal winner thank'.split(
        ' '
      )
    );
    assert.deepEqual(
      digestToWords('80'.repeat(32)).slice(0, 11),
      'letter advice cage absurd amount doctor acoustic avoid letter advice cage'.split(
        ' '
      )
    );
  });

  it('gives at least 12 words and at most 23 from 32 bytes', () => {
    assert.lengthOf(digestToWords(D1), 12);
    assert.lengthOf(digestToWords(D1, 23), 23);
    assert.throws(() => digestToWords(D1, 24));
    assert.throws(() => digestToWords(D1, 0));
    // The first 12 of a longer rendering are the default rendering.
    assert.deepEqual(digestToWords(D1, 16).slice(0, 12), digestToWords(D1));
  });

  it('accepts bytes or hex alike', () => {
    assert.deepEqual(digestToWords(hexToBytes(D2)), digestToWords(D2));
  });

  it('formats tags', () => {
    assert.strictEqual(digestTag(D1), '9ac1');
    assert.strictEqual(formatTag(D1), '·9ac1');
    assert.strictEqual(formatTag(hexToBytes(D2)), '·0b3e');
    assert.strictEqual(formatTagList([D1]), '·9ac1');
    assert.strictEqual(formatTagList([D1, D2]), '·9ac1 and ·0b3e');
    assert.strictEqual(formatTagList([D1, D2, D3]), '·9ac1, ·0b3e and ·77aa');
    assert.strictEqual(
      formatTagList([D1, D2, D3, D4, D4]),
      '·9ac1, ·0b3e, ·77aa and 2 more'
    );
    assert.strictEqual(formatTagList([]), '');
  });
});
