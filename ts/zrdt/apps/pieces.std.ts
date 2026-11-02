// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Piece stores on the host side (zrdt docs/apps/BUILD_M1.md §B.2, §B.9):
// slicing a stream, the sizes a piece must have, pointer checks before a
// download, the receiver's per-announcement progress, and reading (index,
// bytes) out of a repair reply's piece opening.
//
// The host never decides that a piece is good: PIECE_ACCEPT recomputes the
// piece record from (index, bytes) and compares it with the digest A
// committed. A host bug here only makes zrdtd refuse (BAD_PIECE).

import type { Digest } from '../ZrdtBackend.std.ts';
import { NONCE_BYTES } from '../ZrdtBackend.std.ts';
import {
  FIELD_AUDIENCE,
  FIELD_PIECE_BYTES,
  FIELD_PIECE_INDEX,
  MAX_PIECES,
  pieceCount,
  pieceExpOk,
  toHex,
  topFields,
  varintValue,
} from './appMessage.std.ts';

type Bytes = Uint8Array<ArrayBuffer>;

/** The length of piece `index` of a stream of `len` bytes in pieces of 2^exp. */
export function pieceLength(exp: number, len: number, index: number): number {
  const size = 2 ** exp;
  return Math.max(0, Math.min(size, len - index * size));
}

/** Piece `index` of `stream` in pieces of 2^exp bytes (the last is short). */
export function slicePiece(
  stream: Uint8Array<ArrayBuffer>,
  exp: number,
  index: number
): Bytes {
  const size = 2 ** exp;
  return stream.slice(index * size, (index + 1) * size);
}

/** Every piece of `stream`, in index order. */
export function slicePieces(
  stream: Uint8Array<ArrayBuffer>,
  exp: number
): Array<Bytes> {
  const out = new Array<Bytes>();
  for (let i = 0; i < pieceCount(exp, stream.length); i += 1) {
    out.push(slicePiece(stream, exp, i));
  }
  return out;
}

/** A stream the host may announce: 1 B to 64 pieces, at an accepted piece size. */
export function streamFits(exp: number, len: number): boolean {
  return pieceExpOk(exp) && len >= 1 && len <= MAX_PIECES * 2 ** exp;
}

/** What a CDN pointer of piece `index` must say before it is downloaded. */
export type PointerShape = Readonly<{
  /** The plaintext size the pointer claims. */
  size: number | undefined;
  /** It names a CDN object, a key and a digest. */
  complete: boolean;
}>;

/**
 * Whether the pointers can be the pieces of the bound announcement (FORK_MAP
 * O3): one pointer per piece, each complete, each claiming exactly its
 * piece's length. A mismatch means the author's pointers are wrong; nothing
 * is downloaded, and every piece goes to repair.
 */
export function checkPointers(
  pointers: ReadonlyArray<PointerShape>,
  exp: number,
  len: number
):
  | { ok: true }
  | { ok: false; reason: 'count' | 'incomplete' | 'size'; index?: number } {
  if (pointers.length !== pieceCount(exp, len)) {
    return { ok: false, reason: 'count' };
  }
  for (let i = 0; i < pointers.length; i += 1) {
    const p = pointers[i];
    if (p === undefined || !p.complete) {
      return { ok: false, reason: 'incomplete', index: i };
    }
    if (p.size !== pieceLength(exp, len, i)) {
      return { ok: false, reason: 'size', index: i };
    }
  }
  return { ok: true };
}

/**
 * The (index, bytes) a piece opening commits to: a 32-byte nonce, then
 * exactly `[201 audience] [220 varint index] [221 bytes]`. The requester
 * reads them from a repair reply's addressed entries and hands them to
 * PIECE_ACCEPT, which rebuilds the opening itself; a wrong read only gets
 * BAD_PIECE (BUILD_M1 §B.9, "Requester, on a reply").
 */
export function pieceOfOpening(
  opening: Uint8Array<ArrayBuffer>
): { index: number; bytes: Bytes } | undefined {
  if (opening.length < NONCE_BYTES) {
    return undefined;
  }
  const message = opening.slice(NONCE_BYTES);
  const fields = topFields(message);
  if (fields?.length !== 3) {
    return undefined;
  }
  const [audience, index, bytes] = fields;
  if (
    audience === undefined ||
    index === undefined ||
    bytes === undefined ||
    audience.num !== FIELD_AUDIENCE ||
    audience.wireType !== 2 ||
    index.num !== FIELD_PIECE_INDEX ||
    bytes.num !== FIELD_PIECE_BYTES ||
    bytes.wireType !== 2
  ) {
    return undefined;
  }
  const i = varintValue(message, index);
  if (i === undefined || i >= 2 ** 32) {
    return undefined;
  }
  return { index: i, bytes: message.slice(bytes.valueStart, bytes.stop) };
}

// --- the receiver's progress on one announcement ---------------------------

/**
 * Where piece `i` stands.
 * - `wanted`: not tried yet;
 * - `ok`: PIECE_ACCEPT took it (from the CDN, a repair or local bytes);
 * - `cdnMissing`: the CDN had no object (404), or the pointers were unusable;
 * - `cdnBad`: Signal's attachment check failed (bad MAC or digest): the
 *   server or the network changed it;
 * - `authorBad`: the CDN bytes passed Signal's check but PIECE_ACCEPT said
 *   BAD_PIECE: the author uploaded wrong bytes (blame A's author);
 * - `repairing`: asked of a member.
 */
export type PieceState =
  | 'wanted'
  | 'ok'
  | 'cdnMissing'
  | 'cdnBad'
  | 'authorBad'
  | 'repairing';

/** Progress of one bound announcement. Pure; the transport drives it. */
export class PieceProgress {
  readonly ordered: ReadonlyArray<string>;
  readonly #states: Array<PieceState>;

  constructor(ordered: ReadonlyArray<Digest>) {
    this.ordered = ordered.map(toHex);
    this.#states = ordered.map(() => 'wanted');
  }

  get count(): number {
    return this.#states.length;
  }

  state(index: number): PieceState | undefined {
    return this.#states[index];
  }

  set(index: number, state: PieceState): void {
    if (index < 0 || index >= this.#states.length) {
      throw new RangeError(`no piece ${index}`);
    }
    // A checked piece stays checked.
    if (this.#states[index] !== 'ok') {
      this.#states[index] = state;
    }
  }

  /** The index of a piece digest (hex), as PIECES_COMPLETE's MISSING names it. */
  indexOf(digest: Digest): number | undefined {
    const i = this.ordered.indexOf(toHex(digest));
    return i < 0 ? undefined : i;
  }

  /** Marks every listed digest missing (PIECES_COMPLETE said MISSING). */
  markMissing(digests: ReadonlyArray<Digest>): Array<number> {
    const out = new Array<number>();
    for (const d of digests) {
      const i = this.indexOf(d);
      if (i !== undefined) {
        // zrdtd says the store does not hold it: whatever the host thought.
        this.#states[i] =
          this.#states[i] === 'ok' ? 'wanted' : (this.#states[i] ?? 'wanted');
        out.push(i);
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** The pieces that need a member: every piece that is not checked. */
  needRepair(): Array<number> {
    return this.#states.flatMap((s, i) => (s === 'ok' ? [] : [i]));
  }

  get done(): boolean {
    return this.#states.every(s => s === 'ok');
  }

  summary(): Readonly<Record<PieceState, number>> {
    const out: Record<PieceState, number> = {
      wanted: 0,
      ok: 0,
      cdnMissing: 0,
      cdnBad: 0,
      authorBad: 0,
      repairing: 0,
    };
    for (const s of this.#states) {
      out[s] += 1;
    }
    return out;
  }
}
