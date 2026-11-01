// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import {
  classifyCompare,
  encodeCompareCode,
  headsFingerprint,
  headsFingerprintWords,
  parseCompareCode,
} from '../../../zrdt/ui/compareCode.std.ts';
import { bytesToHex } from '../../../zrdt/ui/words.std.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const OWNER = '0b3e2c5a-1111-4222-8333-444455556666';

describe('zrdt/ui/compareCode', () => {
  it('encodes sorted, de-duplicated heads and parses them back', () => {
    const text = encodeCompareCode({
      chat: 'g1',
      owner: OWNER,
      heads: [B, A, B.toUpperCase()],
    });
    assert.strictEqual(text, `zrdt1:g1:${OWNER}:${A},${B}`);
    const parsed = parseCompareCode(text, 'g1');
    assert.deepEqual(parsed, {
      ok: true,
      code: { chat: 'g1', owner: OWNER, heads: [A, B] },
    });
  });

  it('handles an empty heads set', () => {
    const text = encodeCompareCode({ chat: 'g1', owner: OWNER, heads: [] });
    assert.strictEqual(text, `zrdt1:g1:${OWNER}:`);
    const parsed = parseCompareCode(text);
    assert.isTrue(parsed.ok);
    assert.deepEqual(parsed.ok ? parsed.code.heads : null, []);
  });

  it('ignores whitespace from wrapped pastes', () => {
    const text = encodeCompareCode({ chat: 'g1', owner: OWNER, heads: [A] });
    const wrapped = ` ${text.slice(0, 30)}\n${text.slice(30)}  `;
    assert.deepEqual(parseCompareCode(wrapped), parseCompareCode(text));
  });

  it('refuses junk, damaged digests and other chats', () => {
    assert.deepEqual(parseCompareCode('hello'), {
      ok: false,
      error: 'not-a-compare-code',
    });
    assert.deepEqual(parseCompareCode(`zrdt2:g1:${OWNER}:${A}`), {
      ok: false,
      error: 'not-a-compare-code',
    });
    assert.deepEqual(parseCompareCode(`zrdt1:g1:${OWNER}:${A.slice(1)}`), {
      ok: false,
      error: 'bad-digest',
    });
    assert.deepEqual(parseCompareCode(`zrdt1:g2:${OWNER}:${A}`, 'g1'), {
      ok: false,
      error: 'other-chat',
    });
    assert.throws(() =>
      encodeCompareCode({ chat: 'a:b', owner: OWNER, heads: [] })
    );
    assert.throws(() =>
      encodeCompareCode({ chat: 'g', owner: OWNER, heads: ['x'] })
    );
  });

  it('classifies per APP.md §7', () => {
    assert.deepEqual(classifyCompare([A, B], [B, A], []), {
      kind: 'identical',
    });
    // Their head A is in our store; ours has moved on to B.
    assert.deepEqual(classifyCompare([B], [A], []), {
      kind: 'they-are-behind',
    });
    assert.deepEqual(classifyCompare([A], [A, C], [C]), {
      kind: 'you-are-behind',
      missing: [C],
    });
    // notInStore entries that are not their heads are ignored.
    assert.deepEqual(classifyCompare([A], [B], [C]), {
      kind: 'they-are-behind',
    });
  });

  it('fingerprints the sorted set, independent of order', async () => {
    const f1 = await headsFingerprint([A, B]);
    const f2 = await headsFingerprint([B, A, A]);
    assert.strictEqual(bytesToHex(f1), bytesToHex(f2));
    assert.lengthOf(f1, 32);
    const f3 = await headsFingerprint([A]);
    assert.notStrictEqual(bytesToHex(f1), bytesToHex(f3));
    // SHA-256 of the empty string.
    assert.strictEqual(
      bytesToHex(await headsFingerprint([])),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    const words = await headsFingerprintWords([A, B]);
    assert.lengthOf(words, 12);
    assert.deepEqual(words, await headsFingerprintWords([B, A]));
  });
});
