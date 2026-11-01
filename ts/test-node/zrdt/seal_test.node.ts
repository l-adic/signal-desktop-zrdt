// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The seal on SERVE replies (ts/zrdt/seal.node.ts, JOIN_PLAN §4.3): a fixed
// test vector, the round trip, and the attacks it must stop: an attacker key
// (a key the server swapped in after SERVE checked the real one) cannot open
// a reply, and nothing bound by the seal can be changed.

import { assert } from 'chai';
import { PrivateKey } from '@signalapp/libsignal-client';

import {
  decodeServeHeader,
  encodeServeHeader,
  keyTag,
  openServeReply,
  sealServeReply,
} from '../../zrdt/seal.node.ts';
import { stubKeyTag } from '../../zrdt/backends/stub.node.ts';

type Bytes = Uint8Array<ArrayBuffer>;

function fill(byte: number, size: number): Bytes {
  return new Uint8Array(size).fill(byte);
}

function hex(bytes: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, 'hex'));
}

const GROUP = fill(0x47, 32);
const REQUESTER_ACI = fill(0xb0, 16);
const REQUEST_ID = fill(0x1d, 16);
const ENTRIES = new TextEncoder().encode('SERVE entries: u32 count || entries');

// Fixed keys for the vector (X25519 clamps any 32 bytes).
const REQUESTER = PrivateKey.deserialize(fill(0x21, 32));
const EPHEMERAL = PrivateKey.deserialize(fill(0x42, 32));
const ATTACKER = PrivateKey.deserialize(fill(0x66, 32));

function serialized(key: PrivateKey): Bytes {
  return new Uint8Array(key.getPublicKey().serialize());
}

function headerFor(key: Bytes): Bytes {
  return encodeServeHeader({
    requesterAci: REQUESTER_ACI,
    keyTag: keyTag(key),
    requestId: REQUEST_ID,
  });
}

function seal(ephemeral?: PrivateKey) {
  const key = serialized(REQUESTER);
  const headerBytes = headerFor(key);
  return {
    headerBytes,
    ...sealServeReply({
      group: GROUP,
      headerBytes,
      entriesBytes: ENTRIES,
      recipientKey: key,
      ephemeral,
    }),
  };
}

function open(
  sealed: ReturnType<typeof seal>,
  as: PrivateKey,
  overrides: Partial<{
    group: Bytes;
    headerBytes: Bytes;
    ephemeralKey: Bytes;
    sealed: Bytes;
  }> = {}
): Bytes | undefined {
  return openServeReply({
    group: GROUP,
    headerBytes: sealed.headerBytes,
    ephemeralKey: sealed.ephemeralKey,
    sealed: sealed.sealed,
    ourPrivateKey: as,
    ourPublicKey: as.getPublicKey(),
    ...overrides,
  });
}

// Pinned output of the construction for the fixed inputs above. Changing
// the HKDF inputs, the nonce derivation or the associated data changes it.
const VECTOR = {
  keyTag: '0c89e70e3d3b229ee0b13f18bdaedbc0',
  ephemeralKey:
    '05132c442be010fbd57e72603328aa76e71fccc1503aae219327d14d9c9993f472',
  sealed:
    '84c0fa36f980265f265e472936e067def9f29ee152adb7a9aa0e059e5ecb9632' +
    '655af5f7f79c9c7a4ff2291c5b05493b1099fe',
};

describe('zrdt seal (JOIN_PLAN §4.3)', () => {
  it('the key tag is SHA-256("zrdtK1" ‖ key)[0..16], as zrdtd computes it', () => {
    const key = serialized(REQUESTER);
    assert.strictEqual(hex(keyTag(key)), hex(stubKeyTag(key)));
    assert.strictEqual(keyTag(key).byteLength, 16);
    assert.throws(() => keyTag(fill(5, 32)));
  });

  it('test vector', () => {
    const sealed = seal(EPHEMERAL);
    const got = {
      keyTag: hex(keyTag(serialized(REQUESTER))),
      ephemeralKey: hex(sealed.ephemeralKey),
      sealed: hex(sealed.sealed),
    };
    assert.deepEqual(got, VECTOR);
    assert.strictEqual(
      hex(open(sealed, REQUESTER) ?? new Uint8Array()),
      hex(ENTRIES)
    );
    assert.strictEqual(
      hex(
        open(
          {
            ...sealed,
            ephemeralKey: fromHex(VECTOR.ephemeralKey),
            sealed: fromHex(VECTOR.sealed),
          },
          REQUESTER
        ) ?? new Uint8Array()
      ),
      hex(ENTRIES)
    );
  });

  it('round trip with a fresh ephemeral key; two seals differ', () => {
    const a = seal();
    const b = seal();
    assert.notStrictEqual(hex(a.ephemeralKey), hex(b.ephemeralKey));
    assert.notStrictEqual(hex(a.sealed), hex(b.sealed));
    assert.strictEqual(hex(open(a, REQUESTER) ?? fill(0, 1)), hex(ENTRIES));
    assert.strictEqual(hex(open(b, REQUESTER) ?? fill(0, 1)), hex(ENTRIES));
  });

  it('an attacker key cannot open a reply', () => {
    const sealed = seal();
    // The attacker holds its own identity key pair; the header names the
    // checked key's tag, so it is refused before decryption...
    assert.isUndefined(open(sealed, ATTACKER));
    // ...and with a header rewritten to the attacker's tag, the associated
    // data and the agreement both differ: decryption fails.
    const forged = headerFor(serialized(ATTACKER));
    assert.isUndefined(open(sealed, ATTACKER, { headerBytes: forged }));
  });

  it('a reply re-targeted to a swapped key carries bytes it cannot open', () => {
    // SERVE checked the requester's real key; Signal then encrypts the 1:1
    // message to a key the server swapped in. The swapped key's holder gets
    // the ZrdtServed bytes and still cannot read the entries.
    const sealed = seal();
    const swapped = PrivateKey.generate();
    assert.isUndefined(open(sealed, swapped));
    assert.isUndefined(
      open(sealed, swapped, {
        headerBytes: headerFor(serialized(swapped)),
      })
    );
  });

  it('refuses to seal to a key SERVE did not check', () => {
    const key = serialized(REQUESTER);
    assert.throws(
      () =>
        sealServeReply({
          group: GROUP,
          headerBytes: headerFor(serialized(ATTACKER)),
          entriesBytes: ENTRIES,
          recipientKey: key,
        }),
      /not the one SERVE checked/
    );
  });

  it('binds the group, the header and the ephemeral key', () => {
    const sealed = seal();
    assert.isUndefined(open(sealed, REQUESTER, { group: fill(0x48, 32) }));
    const otherId = encodeServeHeader({
      requesterAci: REQUESTER_ACI,
      keyTag: keyTag(serialized(REQUESTER)),
      requestId: fill(0x1e, 16),
    });
    assert.isUndefined(open(sealed, REQUESTER, { headerBytes: otherId }));
    const otherAci = encodeServeHeader({
      requesterAci: fill(0xc0, 16),
      keyTag: keyTag(serialized(REQUESTER)),
      requestId: REQUEST_ID,
    });
    assert.isUndefined(open(sealed, REQUESTER, { headerBytes: otherAci }));
    assert.isUndefined(
      open(sealed, REQUESTER, {
        ephemeralKey: serialized(PrivateKey.generate()),
      })
    );
    const tampered = new Uint8Array(sealed.sealed);
    tampered[0] = ((tampered[0] ?? 0) + 1) % 256;
    assert.isUndefined(open(sealed, REQUESTER, { sealed: tampered }));
  });

  it('header encoding', () => {
    const header = {
      requesterAci: REQUESTER_ACI,
      keyTag: fill(7, 16),
      requestId: REQUEST_ID,
    };
    const bytes = encodeServeHeader(header);
    assert.strictEqual(bytes.byteLength, 48);
    assert.deepEqual(decodeServeHeader(bytes), header);
    assert.isUndefined(decodeServeHeader(bytes.subarray(0, 47)));
  });
});
