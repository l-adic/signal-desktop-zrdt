// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// The compare code (APP.md §7 "Compare"): a copyable string carrying the
// FULL sorted heads set of one member's store, plus who made it and for
// which chat. The >= 12 words are only an "equal?" fingerprint by eye
// (SHA-256 of the sorted heads); the app always compares the full set.
//
// Format (v1): "zrdt1:<chat>:<owner>:<head>,<head>,..."
//   chat  = any colon-free id of the chat the parent picks (e.g. group id
//           hex); a code for another chat is refused
//   owner = the ACI of the member who copied it (colon-free)
//   heads = sorted, de-duplicated 64-char lowercase hex digests; may be empty
//
// Pure helpers only; no imports from Signal's ts/.

import type { ZrdtDigestHex } from './words.std.ts';
import {
  DEFAULT_WORD_COUNT,
  digestToWords,
  hexToBytes,
  isDigestHex,
  DIGEST_BYTES,
} from './words.std.ts';

export const COMPARE_CODE_PREFIX = 'zrdt1';

export type ZrdtCompareCode = Readonly<{
  chat: string;
  owner: string;
  heads: ReadonlyArray<ZrdtDigestHex>;
}>;

export type ZrdtParseCompareCodeResult =
  | Readonly<{ ok: true; code: ZrdtCompareCode }>
  | Readonly<{
      ok: false;
      error: 'not-a-compare-code' | 'bad-digest' | 'other-chat';
    }>;

export function normalizeHeads(
  heads: ReadonlyArray<ZrdtDigestHex>
): Array<ZrdtDigestHex> {
  const set = new Set(heads.map(head => head.trim().toLowerCase()));
  return [...set].sort();
}

function checkField(name: string, value: string): void {
  if (value.length === 0 || value.includes(':') || /\s/.test(value)) {
    throw new Error(`encodeCompareCode: bad ${name}`);
  }
}

export function encodeCompareCode(code: ZrdtCompareCode): string {
  checkField('chat', code.chat);
  checkField('owner', code.owner);
  const heads = normalizeHeads(code.heads);
  for (const head of heads) {
    if (!isDigestHex(head)) {
      throw new Error('encodeCompareCode: bad head digest');
    }
  }
  return [COMPARE_CODE_PREFIX, code.chat, code.owner, heads.join(',')].join(
    ':'
  );
}

/**
 * Parses a pasted code. Whitespace anywhere is ignored (pastes can wrap).
 * If `expectedChat` is given, a code for another chat is refused.
 */
export function parseCompareCode(
  text: string,
  expectedChat?: string
): ZrdtParseCompareCodeResult {
  const compact = text.replace(/\s+/g, '');
  const parts = compact.split(':');
  if (parts.length !== 4) {
    return { ok: false, error: 'not-a-compare-code' };
  }
  const [prefix, chat, owner, headList] = parts;
  if (
    prefix !== COMPARE_CODE_PREFIX ||
    chat == null ||
    chat.length === 0 ||
    owner == null ||
    owner.length === 0 ||
    headList == null
  ) {
    return { ok: false, error: 'not-a-compare-code' };
  }
  const rawHeads = headList.length === 0 ? [] : headList.split(',');
  const heads = normalizeHeads(rawHeads);
  if (!heads.every(isDigestHex)) {
    return { ok: false, error: 'bad-digest' };
  }
  if (expectedChat != null && chat !== expectedChat) {
    return { ok: false, error: 'other-chat' };
  }
  return { ok: true, code: { chat, owner, heads } };
}

/** The outcome kinds of APP.md §7 "Compare screen logic", before any ask. */
export type ZrdtCompareKind =
  | Readonly<{ kind: 'identical' }>
  | Readonly<{ kind: 'they-are-behind' }>
  | Readonly<{ kind: 'you-are-behind'; missing: ReadonlyArray<ZrdtDigestHex> }>;

/**
 * `ours` = our HEADS, `theirs` = the pasted code's heads, `notInStore` =
 * the subset of `theirs` for which our store's HAS said false (the parent
 * asks the backend; this file has no store).
 */
export function classifyCompare(
  ours: ReadonlyArray<ZrdtDigestHex>,
  theirs: ReadonlyArray<ZrdtDigestHex>,
  notInStore: ReadonlyArray<ZrdtDigestHex>
): ZrdtCompareKind {
  const a = normalizeHeads(ours);
  const b = normalizeHeads(theirs);
  if (a.length === b.length && a.every((head, i) => head === b[i])) {
    return { kind: 'identical' };
  }
  const theirSet = new Set(b);
  const missing = normalizeHeads(notInStore).filter(d => theirSet.has(d));
  if (missing.length === 0) {
    return { kind: 'they-are-behind' };
  }
  return { kind: 'you-are-behind', missing };
}

/**
 * SHA-256 over the concatenated raw bytes of the sorted, de-duplicated heads
 * (an empty set hashes the empty string). Uses WebCrypto, which exists in
 * Electron's renderer and main process and in Node >= 19.
 */
export async function headsFingerprint(
  heads: ReadonlyArray<ZrdtDigestHex>
): Promise<Uint8Array<ArrayBuffer>> {
  const sorted = normalizeHeads(heads);
  const buf = new Uint8Array(sorted.length * DIGEST_BYTES);
  sorted.forEach((head, i) => {
    if (!isDigestHex(head)) {
      throw new Error('headsFingerprint: bad head digest');
    }
    buf.set(hexToBytes(head), i * DIGEST_BYTES);
  });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return new Uint8Array(digest);
}

/** The "equal?" words for a heads set: >= 12 words of headsFingerprint. */
export async function headsFingerprintWords(
  heads: ReadonlyArray<ZrdtDigestHex>,
  count: number = DEFAULT_WORD_COUNT
): Promise<Array<string>> {
  return digestToWords(await headsFingerprint(heads), count);
}
