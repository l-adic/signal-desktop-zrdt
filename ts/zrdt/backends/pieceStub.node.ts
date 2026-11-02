// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Piece stores in the protocol-5 stub (zrdt docs/apps/BUILD_M1.md §B.2,
// §B.5): the ids, the piece context, piece and manifest records and openings,
// `pieceOk`, `bindCtx`, the context of an author op, and the torrent's names
// and manifest. Used by ./appsStub.node.ts (base and torrent ops) and
// ./gitStub.node.ts (git ops). Mirrors Lean `Zrdt.AppBase`.

import type {
  BadApp,
  BadAppReason,
  Bytes,
  Digest,
} from '../ZrdtBackend.std.ts';
import { parseAudience } from '../audience.std.ts';
import type { Seat } from '../audience.std.ts';
import {
  FIELD_AUDIENCE,
  FIELD_MANIFEST,
  FIELD_ORDERED,
  FIELD_PIECE_BYTES,
  FIELD_PIECE_INDEX,
  MANIFEST_INDEX,
  MAX_POINTERS_BYTES,
  appOfOpening,
  concat,
  descriptorWellFormed,
  equalBytes,
  fromUtf8,
  lenField,
  parseDescriptor,
  pieceCount,
  pieceExpOk,
  u32be,
  u64be,
  utf8,
  varintField,
} from '../apps/appMessage.std.ts';
import type { AppHeader, Descriptor } from '../apps/appMessage.std.ts';
import { pieceLength, slicePiece } from '../apps/pieces.std.ts';
import { hashRecord, makeRecord, opens, sha256 } from './stub.node.ts';
import type { StubRecord } from './stub.node.ts';

// ---------------------------------------------------------------------------
// Ids (BUILD_M1 §B.2)
// ---------------------------------------------------------------------------

const CHANNEL_TAG = utf8('zrdtC1');
const STORE_TAG = utf8('zrdtT1');
const NONCE_TAG = utf8('zrdtN1');
const COMMIT_TAG = utf8('zrdtP1');

/** SHA-256("zrdtC1" ‖ signal group ‖ u8 |app| ‖ app ‖ u8 |name| ‖ name). */
export function channelIdOf(
  signalGroup: Bytes,
  app: Bytes,
  name: Bytes
): Bytes {
  return sha256(
    CHANNEL_TAG,
    signalGroup,
    Uint8Array.of(app.length),
    app,
    Uint8Array.of(name.length),
    name
  );
}

/** SHA-256("zrdtT1" ‖ channel ‖ author ‖ store nonce). */
export function storeIdOf(channel: Bytes, author: Bytes, nonce: Bytes): Bytes {
  return sha256(STORE_TAG, channel, author, nonce);
}

/** SHA-256("zrdtN1" ‖ store nonce ‖ u32 i). */
export function pieceNonce(nonce: Bytes, index: number): Bytes {
  return sha256(NONCE_TAG, nonce, u32be(index));
}

/** SHA-256("zrdtP1" ‖ g ‖ a ‖ n ‖ m): COMMIT of a message without 15 or 200. */
export function commitOf(
  group: Bytes,
  author: Bytes,
  nonce: Bytes,
  message: Bytes
): Bytes {
  return sha256(COMMIT_TAG, group, author, nonce, message);
}

// ---------------------------------------------------------------------------
// Piece contexts (Lean `PieceCtx`, `bindCtx`)
// ---------------------------------------------------------------------------

export type PieceCtx = Readonly<{
  announcement: Digest;
  channel: Bytes;
  author: Bytes;
  header: AppHeader;
  seats: ReadonlyArray<Seat>;
  desc: Descriptor;
}>;

export function ctxStoreId(ctx: PieceCtx): Bytes {
  return storeIdOf(ctx.channel, ctx.author, ctx.desc.nonce);
}

/** `[201 audience] [220 varint i] [221 bytes]`. */
export function pieceMessage(
  audience: Bytes,
  index: number,
  piece: Bytes
): Bytes {
  return concat([
    lenField(FIELD_AUDIENCE, audience),
    varintField(FIELD_PIECE_INDEX, index),
    lenField(FIELD_PIECE_BYTES, piece),
  ]);
}

export function pieceOpening(
  ctx: PieceCtx,
  index: number,
  piece: Bytes
): Bytes {
  return concat([
    pieceNonce(ctx.desc.nonce, index),
    pieceMessage(ctx.header.audience, index, piece),
  ]);
}

export function pieceRecord(
  ctx: PieceCtx,
  index: number,
  piece: Bytes
): StubRecord {
  const store = ctxStoreId(ctx);
  return makeRecord({
    group: store,
    commit: commitOf(
      store,
      ctx.author,
      pieceNonce(ctx.desc.nonce, index),
      pieceMessage(ctx.header.audience, index, piece)
    ),
    links: [],
    author: ctx.author,
  });
}

export function manifestMessage(ctx: PieceCtx): Bytes {
  return concat([
    lenField(FIELD_AUDIENCE, ctx.header.audience),
    lenField(FIELD_ORDERED, concat([...ctx.desc.ordered])),
    lenField(FIELD_MANIFEST, ctx.desc.manifest),
  ]);
}

export function manifestOpening(ctx: PieceCtx): Bytes {
  return concat([
    pieceNonce(ctx.desc.nonce, MANIFEST_INDEX),
    manifestMessage(ctx),
  ]);
}

/** F: (storeId, its commitment, links = the N piece digests, A's author). */
export function manifestRecord(ctx: PieceCtx): StubRecord {
  const store = ctxStoreId(ctx);
  return makeRecord({
    group: store,
    commit: commitOf(
      store,
      ctx.author,
      pieceNonce(ctx.desc.nonce, MANIFEST_INDEX),
      manifestMessage(ctx)
    ),
    links: ctx.desc.ordered,
    author: ctx.author,
  });
}

/** `piece` is piece `index` of the context: its length, and A's digest for it. */
export function pieceOk(ctx: PieceCtx, index: number, piece: Bytes): boolean {
  const want = ctx.desc.ordered[index];
  if (want === undefined) {
    return false;
  }
  return (
    piece.length === pieceLength(ctx.desc.exp, ctx.desc.len, index) &&
    equalBytes(hashRecord(pieceRecord(ctx, index, piece)), want)
  );
}

/** The first index whose slice fails `pieceOk` (N if the length is not L). */
export function firstBadSlice(
  ctx: PieceCtx,
  stream: Bytes
): number | undefined {
  if (stream.length !== ctx.desc.len) {
    return ctx.desc.ordered.length;
  }
  for (let i = 0; i < ctx.desc.ordered.length; i += 1) {
    if (!pieceOk(ctx, i, slicePiece(stream, ctx.desc.exp, i))) {
      return i;
    }
  }
  return undefined;
}

export function badApp(reason: BadAppReason): BadApp {
  return { kind: 'badApp', reason };
}

/**
 * The context of announcement `a` with opening `o`, for app `app` in Signal
 * group `sg` (Lean `bindCtx`): the opening matches A; it commits a canonical
 * app message of `app` whose channel id is A's group; it carries a
 * well-formed descriptor.
 */
export function bindCtx(
  sg: Bytes,
  app: Bytes,
  a: StubRecord,
  o: Bytes
): PieceCtx | BadApp {
  if (!opens(a, o)) {
    return badApp('opening');
  }
  const h = appOfOpening(o);
  if (h === undefined) {
    return badApp('notApp');
  }
  if (
    !equalBytes(h.app, app) ||
    !equalBytes(channelIdOf(sg, h.app, h.channel), a.group)
  ) {
    return badApp('notApp');
  }
  if (h.descriptor === undefined) {
    return badApp('descriptor');
  }
  const desc = parseDescriptor(h.descriptor);
  if (desc === undefined || !descriptorWellFormed(desc)) {
    return badApp('descriptor');
  }
  const seats = parseAudience(h.audience);
  if (seats === undefined) {
    return badApp('notApp');
  }
  return {
    announcement: hashRecord(a),
    channel: new Uint8Array(a.group),
    author: new Uint8Array(a.author),
    header: h,
    seats,
    desc,
  };
}

/** Builds a context for an author op (BT_BUILD, GIT_PREPARE): the digests from the slices. */
export function authorCtx({
  channel,
  author,
  nonce,
  exp,
  header,
  stream,
  manifest,
}: Readonly<{
  channel: Bytes;
  author: Bytes;
  nonce: Bytes;
  exp: number;
  header: AppHeader;
  stream: Bytes;
  manifest: Bytes;
}>): PieceCtx {
  const base: PieceCtx = {
    announcement: new Uint8Array(32),
    channel,
    author,
    header,
    seats: parseAudience(header.audience) ?? [],
    desc: { nonce, len: stream.length, exp, ordered: [], manifest },
  };
  const ordered = new Array<Digest>();
  for (let i = 0; i < pieceCount(exp, stream.length); i += 1) {
    ordered.push(hashRecord(pieceRecord(base, i, slicePiece(stream, exp, i))));
  }
  return { ...base, desc: { ...base.desc, ordered } };
}

// ---------------------------------------------------------------------------
// The torrent (BUILD_M1 §B.6)
// ---------------------------------------------------------------------------

export const TORRENT_BODY = utf8('zbt1');
const TORRENT_MANIFEST_TAG = utf8('zbtF1');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A file name that is one safe path component on every platform. */
export function safeComponent(name: string): boolean {
  const bytes = utf8(name);
  if (bytes.length < 1 || bytes.length > 255) {
    return false;
  }
  if (name === '.' || name === '..') {
    return false;
  }
  for (const byte of bytes) {
    if (byte < 0x20 || byte === 0x7f) {
      return false;
    }
  }
  if (/[/\\:<>"|?*]/.test(name)) {
    return false;
  }
  if (/^[ .]|[ .]$/.test(name)) {
    return false;
  }
  return !WINDOWS_RESERVED.test(name);
}

/** `"zbtF1" ‖ name (str) ‖ u64 L`. */
export function torrentManifest(name: string, len: number): Bytes {
  const n = utf8(name);
  return concat([TORRENT_MANIFEST_TAG, u32be(n.length), n, u64be(len)]);
}

export function parseTorrentManifest(
  m: Bytes
): { name: string; len: number } | undefined {
  if (
    m.length < 5 + 4 + 8 ||
    !equalBytes(m.slice(0, 5), TORRENT_MANIFEST_TAG)
  ) {
    return undefined;
  }
  const view = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const n = view.getUint32(5);
  if (5 + 4 + n + 8 !== m.length) {
    return undefined;
  }
  const name = fromUtf8(m.slice(9, 9 + n));
  if (name === undefined) {
    return undefined;
  }
  const len = view.getUint32(9 + n) * 2 ** 32 + view.getUint32(13 + n);
  return { name, len };
}

/** The limits of an author op's inputs (BAD_APP 6). */
export function authorLimitsOk(
  exp: number,
  audience: Bytes,
  pointers: Bytes,
  streamLength: number,
  allowEmpty: boolean
): boolean {
  if (!pieceExpOk(exp) || parseAudience(audience) === undefined) {
    return false;
  }
  if (pointers.length > MAX_POINTERS_BYTES) {
    return false;
  }
  if (streamLength === 0) {
    return allowEmpty;
  }
  return streamLength <= 64 * 2 ** exp;
}
