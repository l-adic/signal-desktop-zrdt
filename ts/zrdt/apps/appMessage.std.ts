// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// App messages (zrdt docs/apps/BUILD_M1.md §B.2): the committed bytes of a
// channel record, and Content 205 around them.
//
//   committed  = [201 audience] [210 app] [211 channel] [212 body]
//                [215 descriptor]? [216 pointers]?
//   Content 205 (ZrdtAppMessage) = [15 groupV2] [200 ZrdtMeta] committed
//
// The host never assembles the committed bytes: BT_BUILD and GIT_PREPARE
// return them, and the receiver passes field 205 as received to COMMIT. This
// module mirrors Lean's `appMessage`/`appHeader` (Zrdt.AppBase) so the host
// can route a received message (app, channel) and so the TypeScript stub can
// build and check the same bytes; it reads protobuf the way
// ../audience.std.ts does. It also holds the descriptor's encoding (field
// 215) and the constants of §B.2-§B.3.

import { NONCE_BYTES } from '../ZrdtBackend.std.ts';
import type { Digest } from '../ZrdtBackend.std.ts';
import { parseAudience } from '../audience.std.ts';

type Bytes = Uint8Array<ArrayBuffer>;

// --- constants (BUILD_M1 §B.2, §B.3) ------------------------------------------

/** The torrent app: tag (210) and its one channel per Signal group (211). */
export const APP_TORRENT = 'bt';
export const CHANNEL_TORRENT = 'files';
/** The git app (SHA-256 repositories only) and its one channel per group. */
export const APP_GIT = 'git-sha256';
export const CHANNEL_GIT = 'repos';

export type AppTag = typeof APP_TORRENT | typeof APP_GIT;

/** The channel name of each app (one channel per Signal group and app). */
export const CHANNEL_OF: Readonly<Record<AppTag, string>> = {
  [APP_TORRENT]: CHANNEL_TORRENT,
  [APP_GIT]: CHANNEL_GIT,
};

export function isAppTag(value: string): value is AppTag {
  return value === APP_TORRENT || value === APP_GIT;
}

export const FIELD_GROUP_V2 = 15;
export const FIELD_META = 200;
export const FIELD_AUDIENCE = 201;
export const FIELD_APP = 210;
export const FIELD_CHANNEL = 211;
export const FIELD_BODY = 212;
export const FIELD_DESCRIPTOR = 215;
export const FIELD_POINTERS = 216;
export const FIELD_PIECE_INDEX = 220;
export const FIELD_PIECE_BYTES = 221;
export const FIELD_ORDERED = 225;
export const FIELD_MANIFEST = 226;

/** Content field number of ZrdtAppMessage. */
export const CONTENT_ZRDT_APP = 205;

/** log2 of the piece size hosts use: 1 MiB. */
export const PIECE_EXP = 20;
/** log2 of the piece size vectors and tests use: 1 KiB. */
export const TEST_PIECE_EXP = 10;
/** At most 64 pieces: 64 MiB at the host's piece size. */
export const MAX_PIECES = 64;
export const MAX_TAG_BYTES = 64;
export const MAX_BODY_BYTES = 24 * 1024;
export const MAX_MANIFEST_BYTES = 4096;
export const MAX_POINTERS_BYTES = 16 * 1024;
/** Content 205: checked by the host before sending. */
export const MAX_CONTENT_BYTES = 64 * 1024;
/** At most 8 pieces per repair request. */
export const MAX_REPAIR_PIECES = 8;
/** A sealed repair reply over this size goes as `sealedOnCdn`. */
export const MAX_INLINE_SEALED_BYTES = 48 * 1024;
/** The manifest's nonce index. */
export const MANIFEST_INDEX = 2 ** 32 - 1;

/** A piece size M1 accepts. */
export function pieceExpOk(exp: number): boolean {
  return exp === PIECE_EXP || exp === TEST_PIECE_EXP;
}

// --- bytes --------------------------------------------------------------------

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

/** Strict UTF-8, or undefined. */
export function fromUtf8(bytes: Bytes): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function concat(parts: ReadonlyArray<Uint8Array<ArrayBuffer>>): Bytes {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function toHex(bytes: Uint8Array<ArrayBuffer>): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Lowercase or uppercase hex of even length, or undefined. */
export function fromHex(hex: string): Bytes | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Code-unit order of two strings (byte order for hex and ASCII names). */
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

export function u32be(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function u64be(value: number): Bytes {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 2 ** 32), false);
  view.setUint32(4, value % 2 ** 32, false);
  return out;
}

// --- protobuf -------------------------------------------------------------------

/** The minimal protobuf varint of a safe integer. */
export function varint(value: number): Bytes {
  const out = new Array<number>();
  let n = value;
  while (n >= 128) {
    out.push((n % 128) + 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}

/** A length-delimited field (wire type 2). */
export function lenField(num: number, value: Uint8Array<ArrayBuffer>): Bytes {
  return concat([varint(num * 8 + 2), varint(value.length), value]);
}

/** A varint field (wire type 0). */
export function varintField(num: number, value: number): Bytes {
  return concat([varint(num * 8), varint(value)]);
}

function readVarint(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number
): { value: number; next: number } | undefined {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) {
      return undefined;
    }
    value += (byte % 128) * scale;
    scale *= 128;
    if (byte < 128) {
      return { value, next: offset + i + 1 };
    }
  }
  return undefined;
}

/** One top-level protobuf field. */
export type TopField = Readonly<{
  num: number;
  wireType: number;
  /** Where the field's key starts. */
  start: number;
  /** Where the value starts (after the length for wire type 2). */
  valueStart: number;
  /** Just after the value. */
  stop: number;
}>;

/**
 * The top-level fields of a protobuf message (Lean `fields`: wire types 0, 1,
 * 2, 5; a key below 2^32 with a field number of at least 1), or undefined.
 */
export function topFields(
  message: Uint8Array<ArrayBuffer>
): Array<TopField> | undefined {
  const out = new Array<TopField>();
  let offset = 0;
  while (offset < message.length) {
    const start = offset;
    const key = readVarint(message, offset);
    if (key === undefined || key.value >= 2 ** 32) {
      return undefined;
    }
    const num = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (num === 0) {
      return undefined;
    }
    let valueStart = key.next;
    let stop: number;
    if (wireType === 0) {
      const v = readVarint(message, key.next);
      if (v === undefined) {
        return undefined;
      }
      stop = v.next;
    } else if (wireType === 1) {
      stop = key.next + 8;
    } else if (wireType === 2) {
      const len = readVarint(message, key.next);
      if (len === undefined) {
        return undefined;
      }
      valueStart = len.next;
      stop = len.next + len.value;
    } else if (wireType === 5) {
      stop = key.next + 4;
    } else {
      return undefined;
    }
    if (stop > message.length) {
      return undefined;
    }
    out.push({ num, wireType, start, valueStart, stop });
    offset = stop;
  }
  return out;
}

/** The value of a varint field. */
export function varintValue(
  message: Uint8Array<ArrayBuffer>,
  field: TopField
): number | undefined {
  return field.wireType === 0
    ? readVarint(message, field.valueStart)?.value
    : undefined;
}

// --- app messages (Lean `AppHeader`, `appMessage`, `appHeader`) -------------

/** The committed fields of an app message. */
export type AppHeader = Readonly<{
  audience: Bytes;
  app: Bytes;
  channel: Bytes;
  body: Bytes;
  descriptor?: Bytes;
  pointers?: Bytes;
}>;

/** The limits of §B.3, and an audience ACCEPT takes. */
export function appHeaderWellFormed(h: AppHeader): boolean {
  return (
    parseAudience(h.audience) !== undefined &&
    h.app.length >= 1 &&
    h.app.length <= MAX_TAG_BYTES &&
    h.channel.length >= 1 &&
    h.channel.length <= MAX_TAG_BYTES &&
    h.body.length <= MAX_BODY_BYTES &&
    (h.pointers === undefined || h.pointers.length <= MAX_POINTERS_BYTES)
  );
}

/** The canonical committed bytes of an app message. */
export function appMessageBytes(h: AppHeader): Bytes {
  return concat([
    lenField(FIELD_AUDIENCE, h.audience),
    lenField(FIELD_APP, h.app),
    lenField(FIELD_CHANNEL, h.channel),
    lenField(FIELD_BODY, h.body),
    ...(h.descriptor === undefined
      ? []
      : [lenField(FIELD_DESCRIPTOR, h.descriptor)]),
    ...(h.pointers === undefined ? [] : [lenField(FIELD_POINTERS, h.pointers)]),
  ]);
}

const ORDERS: ReadonlyArray<ReadonlyArray<number>> = [
  [201, 210, 211, 212],
  [201, 210, 211, 212, 215],
  [201, 210, 211, 212, 216],
  [201, 210, 211, 212, 215, 216],
];

/**
 * Committed bytes as an app message: exactly the fields 201, 210, 211, 212,
 * then 215 and 216 at most once each, in that order, all length-delimited,
 * well-formed, and written exactly as `appMessageBytes` writes them.
 * Undefined for anything else (a chat message, a piece, a manifest).
 */
export function parseAppHeader(
  message: Uint8Array<ArrayBuffer>
): AppHeader | undefined {
  const fields = topFields(message);
  if (fields === undefined || fields.some(f => f.wireType !== 2)) {
    return undefined;
  }
  const nums = fields.map(f => f.num);
  if (
    !ORDERS.some(
      order =>
        order.length === nums.length && order.every((n, i) => nums[i] === n)
    )
  ) {
    return undefined;
  }
  const value = (num: number): Bytes | undefined => {
    const f = fields.find(x => x.num === num);
    return f === undefined ? undefined : message.slice(f.valueStart, f.stop);
  };
  const audience = value(FIELD_AUDIENCE);
  const app = value(FIELD_APP);
  const channel = value(FIELD_CHANNEL);
  const body = value(FIELD_BODY);
  if (!audience || !app || !channel || !body) {
    return undefined;
  }
  const descriptor = value(FIELD_DESCRIPTOR);
  const pointers = value(FIELD_POINTERS);
  const h: AppHeader = {
    audience,
    app,
    channel,
    body,
    ...(descriptor === undefined ? {} : { descriptor }),
    ...(pointers === undefined ? {} : { pointers }),
  };
  if (!appHeaderWellFormed(h) || !equalBytes(appMessageBytes(h), message)) {
    return undefined;
  }
  return h;
}

/** The app message an opening commits to (its nonce dropped). */
export function appOfOpening(
  opening: Uint8Array<ArrayBuffer>
): AppHeader | undefined {
  if (opening.length < NONCE_BYTES) {
    return undefined;
  }
  return parseAppHeader(opening.slice(NONCE_BYTES));
}

/**
 * The ZrdtAppMessage bytes (Content field 205's value): field 15 (the group's
 * `GroupContextV2`), field 200 (`ZrdtMeta`), then the committed bytes exactly
 * as BT_BUILD or GIT_PREPARE returned them. COMMIT strips 15 and 200, so it
 * commits to exactly `committed`.
 */
export function zrdtAppMessageBytes({
  groupV2,
  meta,
  committed,
}: Readonly<{
  groupV2: Uint8Array<ArrayBuffer>;
  meta: Uint8Array<ArrayBuffer>;
  committed: Uint8Array<ArrayBuffer>;
}>): Bytes {
  return concat([
    lenField(FIELD_GROUP_V2, groupV2),
    lenField(FIELD_META, meta),
    committed,
  ]);
}

/**
 * The routing facts of a received ZrdtAppMessage, read from the bytes as
 * received (untrusted until zrdtd binds them: PIECES_BIND checks the channel
 * id against the committed app and name). Undefined if the committed part is
 * not a canonical app message.
 */
export function routeOfAppMessage(
  bytes: Uint8Array<ArrayBuffer>
): Readonly<{ app: string; channel: string; header: AppHeader }> | undefined {
  const fields = topFields(bytes);
  if (fields === undefined) {
    return undefined;
  }
  const committed = concat(
    fields
      .filter(f => f.num !== FIELD_GROUP_V2 && f.num !== FIELD_META)
      .map(f => bytes.slice(f.start, f.stop))
  );
  const header = parseAppHeader(committed);
  if (header === undefined) {
    return undefined;
  }
  const app = fromUtf8(header.app);
  const channel = fromUtf8(header.channel);
  if (app === undefined || channel === undefined) {
    return undefined;
  }
  return { app, channel, header };
}

// --- the descriptor (field 215, Lean `Descriptor`) ----------------------------

const DESCRIPTOR_TAG = utf8('zrdtD1');

/** An announcement's piece store. */
export type Descriptor = Readonly<{
  /** The store nonce: 32 bytes. */
  nonce: Bytes;
  /** The stream length L. */
  len: number;
  /** log2 of the piece size. */
  exp: number;
  /** The piece digests in index order. */
  ordered: ReadonlyArray<Digest>;
  /** The app manifest (field 226 of the manifest record). */
  manifest: Bytes;
}>;

/** `"zrdtD1" ‖ nonce ‖ u64 L ‖ u8 k ‖ u32 N ‖ digests ‖ u32 |m| ‖ m`. */
export function writeDescriptor(d: Descriptor): Bytes {
  return concat([
    DESCRIPTOR_TAG,
    d.nonce,
    u64be(d.len),
    Uint8Array.of(d.exp),
    u32be(d.ordered.length),
    ...d.ordered,
    u32be(d.manifest.length),
    d.manifest,
  ]);
}

/** Reads a descriptor; every byte must be used. */
export function parseDescriptor(
  bytes: Uint8Array<ArrayBuffer>
): Descriptor | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const need = (n: number): boolean => offset + n <= bytes.length;
  if (!need(6 + 32 + 8 + 1 + 4)) {
    return undefined;
  }
  if (!equalBytes(bytes.slice(0, 6), DESCRIPTOR_TAG)) {
    return undefined;
  }
  offset = 6;
  const nonce = bytes.slice(offset, offset + 32);
  offset += 32;
  const len = view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);
  offset += 8;
  const exp = bytes[offset] ?? 0;
  offset += 1;
  const count = view.getUint32(offset);
  offset += 4;
  if (!need(count * 32 + 4)) {
    return undefined;
  }
  const ordered = new Array<Digest>();
  for (let i = 0; i < count; i += 1) {
    ordered.push(bytes.slice(offset, offset + 32));
    offset += 32;
  }
  const mlen = view.getUint32(offset);
  offset += 4;
  if (offset + mlen !== bytes.length) {
    return undefined;
  }
  return { nonce, len, exp, ordered, manifest: bytes.slice(offset) };
}

/** ⌈len / 2^exp⌉. */
export function pieceCount(exp: number, len: number): number {
  return Math.ceil(len / 2 ** exp);
}

/** M1's limits: k ∈ {20, 10}, 1 ≤ L ≤ 64·2^k, N = ⌈L/2^k⌉ distinct digests, manifest ≤ 4 KiB. */
export function descriptorWellFormed(d: Descriptor): boolean {
  if (!pieceExpOk(d.exp) || d.len < 1 || d.len > MAX_PIECES * 2 ** d.exp) {
    return false;
  }
  if (d.ordered.length !== pieceCount(d.exp, d.len)) {
    return false;
  }
  const seen = new Set(d.ordered.map(toHex));
  return (
    seen.size === d.ordered.length && d.manifest.length <= MAX_MANIFEST_BYTES
  );
}

// --- ZrdtMeta (field 200: links and nonce, not committed) -------------------

/** `ZrdtMeta { repeated bytes links = 1; bytes nonce = 2; }` as protobuf writes it. */
export function zrdtMetaBytes(
  links: ReadonlyArray<Uint8Array<ArrayBuffer>>,
  nonce: Uint8Array<ArrayBuffer>
): Bytes {
  return concat([...links.map(l => lenField(1, l)), lenField(2, nonce)]);
}

/**
 * The links and nonce of a ZrdtAppMessage's field 200, read from the bytes as
 * received: 32-byte links, a 32-byte nonce. Undefined if field 200 is absent,
 * repeated, or malformed.
 */
export function metaOfAppMessage(
  bytes: Uint8Array<ArrayBuffer>
): { links: Array<Bytes>; nonce: Bytes } | undefined {
  const fields = topFields(bytes);
  const metas = fields?.filter(f => f.num === FIELD_META) ?? [];
  const meta = metas[0];
  if (metas.length !== 1 || meta === undefined || meta.wireType !== 2) {
    return undefined;
  }
  const value = bytes.slice(meta.valueStart, meta.stop);
  const inner = topFields(value);
  if (inner === undefined) {
    return undefined;
  }
  const links = new Array<Bytes>();
  let nonce: Bytes | undefined;
  for (const f of inner) {
    if (f.num === 1 && f.wireType === 2) {
      const link = value.slice(f.valueStart, f.stop);
      if (link.length !== 32) {
        return undefined;
      }
      links.push(link);
    } else if (f.num === 2 && f.wireType === 2) {
      if (nonce !== undefined) {
        return undefined;
      }
      nonce = value.slice(f.valueStart, f.stop);
    }
  }
  return nonce?.length === NONCE_BYTES ? { links, nonce } : undefined;
}
