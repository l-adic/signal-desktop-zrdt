// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { assert } from 'chai';
import { BIP39_ENGLISH } from '../../../zrdt/ui/bip39English.std.ts';

describe('zrdt/ui/bip39English', () => {
  it('is the BIP-39 English list, byte for byte', () => {
    assert.lengthOf(BIP39_ENGLISH, 2048);
    assert.strictEqual(new Set(BIP39_ENGLISH).size, 2048);
    const file = `${BIP39_ENGLISH.join('\n')}\n`;
    assert.strictEqual(
      createHash('sha256').update(file).digest('hex'),
      '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda'
    );
  });
});
