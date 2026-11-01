// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The seal on a SERVE reply (zrdt docs/JOIN_PLAN.md section 4.3): the reply's
// entries are readable only by the holder of the identity key SERVE checked.
// It is sealed sender v1's sender layer (an ephemeral key agreed with the
// recipient's identity key), with libsignal's own primitives:
//
//   e      <- PrivateKey.generate()                      fresh per reply
//   K      =  the requester's identity key (33 bytes) SERVE checked
//   okm    =  HKDF-SHA256(ikm  = e.agree(K),
//                         salt = e_pub ‖ K,
//                         info = "zrdt-seal-v1" ‖ group ‖ requester aci ‖ request id,
//                         44 bytes)
//   k, n   =  okm[0..32], okm[32..44]
//   sealed =  AES-256-GCM-SIV(k, n, entries, aad = header ‖ e_pub)
//
// header = requester aci(16) ‖ key tag(16) ‖ request id(16), from SERVE's
// reply. The nonce comes from HKDF: the key is fresh per reply, so a fixed
// derivation is safe, and the wire carries no nonce.
//
// The seal authenticates nothing (JOIN_PLAN §10a): anyone holding K's public
// half can seal to it. Who sent a reply is Signal's 1:1 channel; which
// request it answers is the requester's check (served.preload.ts).
//
// libsignal-client 0.105.4 exposes `hkdf`, `Aes256GcmSiv` and
// `PrivateKey.agree` to Node (checked on the Mac mini, node_modules/
// @signalapp/libsignal-client/dist/index.d.ts and EcKeys.d.ts).

import { createHash } from 'node:crypto';

import {
  Aes256GcmSiv,
  PrivateKey,
  PublicKey,
  hkdf,
} from '@signalapp/libsignal-client';

import {
  ACI_BYTES,
  GROUP_ID_BYTES,
  IDENTITY_KEY_BYTES,
  KEY_TAG_BYTES,
  REQUEST_ID_BYTES,
  SERVE_HEADER_BYTES,
} from './ZrdtBackend.std.ts';
import type { ServeHeader } from './ZrdtBackend.std.ts';

type Bytes = Uint8Array<ArrayBuffer>;

const SEAL_INFO = new TextEncoder().encode('zrdt-seal-v1');
const KEY_TAG_PREFIX = new TextEncoder().encode('zrdtK1');
const SEAL_KEY_BYTES = 32;
const SEAL_NONCE_BYTES = 12;

function concat(parts: ReadonlyArray<Bytes>): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equal(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function check(name: string, value: Bytes, size: number): void {
  if (value.length !== size) {
    throw new Error(
      `zrdt seal: ${name} has ${value.length} bytes, not ${size}`
    );
  }
}

/**
 * The key tag of a serialized identity key: the first 16 bytes of
 * SHA-256("zrdtK1" ‖ key) (JOIN_PLAN §3.2; Lean `keyTag`). The same value
 * zrdtd puts in field 201 and in SERVE's reply header.
 */
export function keyTag(identityKey: Bytes): Bytes {
  check('identity key', identityKey, IDENTITY_KEY_BYTES);
  const digest = createHash('sha256')
    .update(KEY_TAG_PREFIX)
    .update(identityKey)
    .digest();
  return new Uint8Array(digest.subarray(0, KEY_TAG_BYTES));
}

/**
 * header = requester aci ‖ key tag ‖ request id.
 * @testexport
 */
export function encodeServeHeader(header: ServeHeader): Bytes {
  check('requester aci', header.requesterAci, ACI_BYTES);
  check('key tag', header.keyTag, KEY_TAG_BYTES);
  check('request id', header.requestId, REQUEST_ID_BYTES);
  return concat([header.requesterAci, header.keyTag, header.requestId]);
}

/** The header bytes as fields, or undefined if they are not 48 bytes. */
export function decodeServeHeader(bytes: Bytes): ServeHeader | undefined {
  if (bytes.length !== SERVE_HEADER_BYTES) {
    return undefined;
  }
  return {
    requesterAci: new Uint8Array(bytes.subarray(0, ACI_BYTES)),
    keyTag: new Uint8Array(
      bytes.subarray(ACI_BYTES, ACI_BYTES + KEY_TAG_BYTES)
    ),
    requestId: new Uint8Array(bytes.subarray(ACI_BYTES + KEY_TAG_BYTES)),
  };
}

function sealKeyAndNonce(
  sharedSecret: Bytes,
  ephemeralPublic: Bytes,
  recipientKey: Bytes,
  group: Bytes,
  header: ServeHeader
): { key: Bytes; nonce: Bytes } {
  const okm = hkdf(
    SEAL_KEY_BYTES + SEAL_NONCE_BYTES,
    sharedSecret,
    concat([SEAL_INFO, group, header.requesterAci, header.requestId]),
    concat([ephemeralPublic, recipientKey])
  );
  return {
    key: new Uint8Array(okm.subarray(0, SEAL_KEY_BYTES)),
    nonce: new Uint8Array(okm.subarray(SEAL_KEY_BYTES)),
  };
}

export type SealedReply = Readonly<{
  /** The 33-byte serialized ephemeral public key. */
  ephemeralKey: Bytes;
  /** The entries, encrypted, with the 16-byte AES-GCM-SIV tag appended. */
  sealed: Bytes;
}>;

/**
 * Seals SERVE's entries to `recipientKey`, the identity key SERVE checked.
 * Throws unless the key's tag is the header's: the host never seals to a key
 * SERVE did not check. `ephemeral` is for test vectors only.
 */
export function sealServeReply({
  group,
  headerBytes,
  entriesBytes,
  recipientKey,
  ephemeral = PrivateKey.generate(),
}: Readonly<{
  group: Bytes;
  headerBytes: Bytes;
  entriesBytes: Bytes;
  recipientKey: Bytes;
  ephemeral?: PrivateKey;
}>): SealedReply {
  check('group', group, GROUP_ID_BYTES);
  const header = decodeServeHeader(headerBytes);
  if (header === undefined) {
    throw new Error('zrdt seal: header is not 48 bytes');
  }
  if (!equal(keyTag(recipientKey), header.keyTag)) {
    throw new Error('zrdt seal: the key is not the one SERVE checked');
  }
  const recipient = PublicKey.deserialize(recipientKey);
  const ephemeralPublic = new Uint8Array(ephemeral.getPublicKey().serialize());
  const { key, nonce } = sealKeyAndNonce(
    new Uint8Array(ephemeral.agree(recipient)),
    ephemeralPublic,
    new Uint8Array(recipient.serialize()),
    group,
    header
  );
  const sealed = Aes256GcmSiv.new(key).encrypt(
    entriesBytes,
    nonce,
    concat([headerBytes, ephemeralPublic])
  );
  return {
    ephemeralKey: new Uint8Array(ephemeralPublic),
    sealed: new Uint8Array(sealed),
  };
}

/**
 * Opens a sealed reply with this account's identity key pair. Undefined if
 * the header is not for that key, or the bytes do not open (another key, a
 * changed header, group or ephemeral key, or tampered bytes).
 */
export function openServeReply({
  group,
  headerBytes,
  ephemeralKey,
  sealed,
  ourPrivateKey,
  ourPublicKey,
}: Readonly<{
  group: Bytes;
  headerBytes: Bytes;
  ephemeralKey: Bytes;
  sealed: Bytes;
  ourPrivateKey: PrivateKey;
  ourPublicKey: PublicKey;
}>): Bytes | undefined {
  const header = decodeServeHeader(headerBytes);
  if (
    header === undefined ||
    group.length !== GROUP_ID_BYTES ||
    ephemeralKey.length !== IDENTITY_KEY_BYTES
  ) {
    return undefined;
  }
  const ourKey = new Uint8Array(ourPublicKey.serialize());
  if (!equal(keyTag(ourKey), header.keyTag)) {
    return undefined;
  }
  try {
    const ephemeral = PublicKey.deserialize(ephemeralKey);
    const { key, nonce } = sealKeyAndNonce(
      new Uint8Array(ourPrivateKey.agree(ephemeral)),
      ephemeralKey,
      ourKey,
      group,
      header
    );
    return new Uint8Array(
      Aes256GcmSiv.new(key).decrypt(
        sealed,
        nonce,
        concat([headerBytes, ephemeralKey])
      )
    );
  } catch {
    return undefined;
  }
}
