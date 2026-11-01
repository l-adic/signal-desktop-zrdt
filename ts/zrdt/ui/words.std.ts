// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Pure helpers that turn digests (32-byte SHA-256 values) into the short
// forms the zrdt UI shows: the 4-char tag ("·9ac1") and >= 12 words.
// No imports from Signal's ts/: the fallback mini-client reuses this file.

import { BIP39_ENGLISH } from './bip39English.std.ts';

/** A digest as 64 lowercase hex chars; the form every zrdt UI prop uses. */
export type ZrdtDigestHex = string;

export const DIGEST_BYTES = 32;
export const TAG_CHARS = 4;
export const TAG_PREFIX = '·'; // "·"
export const DEFAULT_WORD_COUNT = 12;

const BITS_PER_WORD = 11;
const WORD_MASK = 0x7ff;
const HEX_RE = /^(?:[0-9a-f]{2})*$/;
const DIGEST_HEX_RE = /^[0-9a-f]{64}$/;

export function isDigestHex(value: string): boolean {
  return DIGEST_HEX_RE.test(value);
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim().toLowerCase();
  if (!HEX_RE.test(clean)) {
    throw new Error('hexToBytes: not an even-length hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function toBytes(
  digest: Uint8Array<ArrayBuffer> | ZrdtDigestHex
): Uint8Array<ArrayBuffer> {
  return typeof digest === 'string' ? hexToBytes(digest) : digest;
}

/**
 * The first `count` * 11 bits of `digest`, big-endian, as BIP-39 English
 * words. 12 words cover 132 bits, so they include the digest's first 128
 * bits. This is NOT a BIP-39 mnemonic: there is no checksum word; the 12th
 * word takes bits 121-132 of the digest.
 */
export function digestToWords(
  digest: Uint8Array<ArrayBuffer> | ZrdtDigestHex,
  count: number = DEFAULT_WORD_COUNT
): Array<string> {
  const bytes = toBytes(digest);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('digestToWords: count must be a positive integer');
  }
  if (count * BITS_PER_WORD > bytes.length * 8) {
    throw new Error('digestToWords: digest too short for that many words');
  }

  const words: Array<string> = [];
  let acc = 0;
  let accBits = 0;
  let next = 0;
  while (words.length < count) {
    while (accBits < BITS_PER_WORD) {
      const byte = bytes[next];
      if (byte === undefined) {
        throw new Error('digestToWords: ran out of bytes');
      }
      // acc never holds more than 18 bits, so plain arithmetic is exact.
      acc = acc * 256 + byte;
      accBits += 8;
      next += 1;
    }
    const shift = accBits - BITS_PER_WORD;
    const divisor = 2 ** shift;
    const index = Math.floor(acc / divisor) % (WORD_MASK + 1);
    const word = BIP39_ENGLISH[index];
    if (word === undefined) {
      throw new Error('digestToWords: word list is not 2048 words');
    }
    words.push(word);
    acc %= divisor;
    accBits = shift;
  }
  return words;
}

/** The first 4 hex chars of a digest, e.g. "9ac1". */
export function digestTag(
  digest: Uint8Array<ArrayBuffer> | ZrdtDigestHex
): string {
  const hex =
    typeof digest === 'string'
      ? digest.trim().toLowerCase()
      : bytesToHex(digest);
  if (hex.length < TAG_CHARS) {
    throw new Error('digestTag: digest too short');
  }
  return hex.slice(0, TAG_CHARS);
}

/** The tag as shown in text: "·9ac1". */
export function formatTag(
  digest: Uint8Array<ArrayBuffer> | ZrdtDigestHex
): string {
  return `${TAG_PREFIX}${digestTag(digest)}`;
}

/** "·9ac1", "·9ac1 and ·0b3e", "·9ac1, ·0b3e, ·77aa and 2 more". */
export function formatTagList(
  digests: ReadonlyArray<Uint8Array<ArrayBuffer> | ZrdtDigestHex>,
  max = 3
): string {
  const tags = digests.map(formatTag);
  if (tags.length <= 1) {
    return tags.join('');
  }
  if (tags.length <= max) {
    return `${tags.slice(0, -1).join(', ')} and ${tags.at(-1)}`;
  }
  return `${tags.slice(0, max).join(', ')} and ${tags.length - max} more`;
}
