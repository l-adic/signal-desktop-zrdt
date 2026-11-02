// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The bytes of the protocol-5 requests and replies: the app ops 0x17-0x2F
// (zrdt docs/apps/BUILD_M1.md §B.1, §B.4-§B.7). Protocol 5 changes no
// protocol-4 layout, so protocol-4 ops stay in ./codec.std.ts; this module
// reuses its field readers and writers.
//
// Both directions are here, as in codec.std.ts: the daemon backend encodes
// requests and decodes replies; the apps stub's tests decode requests, run
// them, and encode the replies again. Once the Lean lanes land, the section
// of each lane in zrdt core/Zrdt/Proto.lean is authoritative for its
// layouts, and the vectors pin them.
//
// Field types beyond protocol 4 (§B.1), all big-endian:
//   u16, u64         2 and 8 bytes
//   ordered          u32 count, then digests in index order (not sorted)
//   oid              32 bytes
//   optoid           u8 0, or u8 1 ‖ oid
//   seat             aci(16) ‖ tag(16); seats: u32 count, then seats,
//                    strictly increasing by (aci, tag)
//   refname          u8 length (1-250), then the bytes
//   update           refname ‖ old optoid ‖ new optoid ‖ forced flag
//   updates          u8 count (at most 16), then updates
//   helds            u32 count, then protocol-4 `held`s

import type {
  AcceptResult,
  AppSeat,
  AssembleResult,
  BadApp,
  BadObjects,
  BtBuildRequest,
  BtBuildResult,
  BtFileResult,
  Bytes,
  ChannelResult,
  ChatKey,
  Digest,
  GitLogEntry,
  GitObjectEntry,
  GitObjectKind,
  GitObjectsResult,
  GitPrepareRequest,
  GitPrepareResult,
  GitRefEntry,
  GitUpdate,
  GitViewResult,
  Oid,
  PieceAcceptResult,
  PieceOpeningResult,
  PiecesBindRequest,
  PiecesBindResult,
  PushRefused,
  ServeHeld,
} from '../ZrdtBackend.std.ts';
import {
  ACI_BYTES,
  BAD_APP_REASONS,
  BAD_OBJECTS_REASONS,
  DIGEST_BYTES,
  IDENTITY_KEY_BYTES,
  KEY_TAG_BYTES,
  PUSH_REFUSED_REASONS,
  SEAT_MARKS,
} from '../ZrdtBackend.std.ts';
import {
  Code,
  ReplyError,
  Short,
  acceptBytes,
  concatBytes,
  decodeRequest,
  readAll,
  u32,
  u8,
  wBytes,
  wDigests,
  wHeld,
  wStr,
} from './codec.std.ts';
import type { Reader, Request } from './codec.std.ts';

/** The protocol-5 op bytes (BUILD_M1 §B.5-§B.7). */
export enum AppOp {
  CHANNEL = 0x17,
  PIECES_BIND = 0x18,
  PIECE_ACCEPT = 0x19,
  PIECE_OPENING = 0x1a,
  PIECES_COMPLETE = 0x1b,
  ASSEMBLE = 0x1c,
  BT_BUILD = 0x20,
  BT_FILE = 0x21,
  GIT_PREPARE = 0x28,
  GIT_OBJECTS = 0x29,
  GIT_VIEW = 0x2a,
}

/** The op bytes of the three lanes' ranges: base, torrent, git. */
export function isAppOpByte(op: number): boolean {
  return op >= 0x17 && op <= 0x2f;
}

/** At most this many ref updates per push (BUILD_M1 §B.3). */
export const MAX_UPDATES = 16;
/** A ref name is 1 to 250 bytes. */
export const MAX_REFNAME_BYTES = 250;

const OID_BYTES = 32;
const SEAT_BYTES = ACI_BYTES + KEY_TAG_BYTES;

// ---------------------------------------------------------------------------
// Writing the new field types
// ---------------------------------------------------------------------------

/** A u64 from a safe integer (stream lengths and offsets stay below 2^53). */
export function u64(value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`zrdt codec5: not a u64: ${value}`);
  }
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 2 ** 32), false);
  view.setUint32(4, value % 2 ** 32, false);
  return out;
}

function wRefname(name: string): Bytes {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length < 1 || bytes.length > MAX_REFNAME_BYTES) {
    throw new Error('zrdt codec5: a ref name is 1 to 250 bytes');
  }
  return concatBytes([u8(bytes.length), bytes]);
}

function wOptOid(oid: Oid | undefined): Bytes {
  return oid === undefined ? u8(0) : concatBytes([u8(1), oid]);
}

function wSeat(seat: AppSeat): Bytes {
  return concatBytes([seat.aci, seat.tag]);
}

function wSeats(seats: ReadonlyArray<AppSeat>): Bytes {
  return concatBytes([u32(seats.length), ...seats.map(wSeat)]);
}

function wUpdate(update: GitUpdate): Bytes {
  return concatBytes([
    wRefname(update.name),
    wOptOid(update.old),
    wOptOid(update.new),
    u8(update.forced ? 1 : 0),
  ]);
}

function wUpdates(updates: ReadonlyArray<GitUpdate>): Bytes {
  if (updates.length > MAX_UPDATES) {
    throw new Error('zrdt codec5: at most 16 updates');
  }
  return concatBytes([u8(updates.length), ...updates.map(wUpdate)]);
}

function wHelds(helds: ReadonlyArray<ServeHeld>): Bytes {
  return concatBytes([u32(helds.length), ...helds.map(wHeld)]);
}

// ---------------------------------------------------------------------------
// Reading the new field types
// ---------------------------------------------------------------------------

function rU64(r: Reader): number {
  const hi = r.u32();
  const lo = r.u32();
  const value = hi * 2 ** 32 + lo;
  if (!Number.isSafeInteger(value)) {
    throw new Short();
  }
  return value;
}

function rRefname(r: Reader): string {
  const n = r.u8();
  if (n < 1 || n > MAX_REFNAME_BYTES) {
    throw new Short();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(r.take(n));
}

function rOptOid(r: Reader): Oid | undefined {
  return r.flag() ? r.take(OID_BYTES) : undefined;
}

function rSeat(r: Reader): AppSeat {
  return { aci: r.take(ACI_BYTES), tag: r.take(KEY_TAG_BYTES) };
}

function rCount(r: Reader, minBytesEach: number, remaining: number): number {
  const count = r.u32();
  // Never size an allocation from an untrusted count.
  if (count * minBytesEach > remaining) {
    throw new Short();
  }
  return count;
}

function rSeats(r: Reader, remaining: number): Array<AppSeat> {
  const count = rCount(r, SEAT_BYTES, remaining);
  const out = new Array<AppSeat>();
  for (let i = 0; i < count; i += 1) {
    out.push(rSeat(r));
  }
  return out;
}

function rUpdate(r: Reader): GitUpdate {
  const name = rRefname(r);
  const old = rOptOid(r);
  const next = rOptOid(r);
  const forced = r.flag();
  return {
    name,
    ...(old === undefined ? {} : { old }),
    ...(next === undefined ? {} : { new: next }),
    forced,
  };
}

function rUpdates(r: Reader): Array<GitUpdate> {
  const count = r.u8();
  if (count > MAX_UPDATES) {
    throw new Short();
  }
  const out = new Array<GitUpdate>();
  for (let i = 0; i < count; i += 1) {
    out.push(rUpdate(r));
  }
  return out;
}

function rHelds(r: Reader, remaining: number): Array<ServeHeld> {
  const count = rCount(r, DIGEST_BYTES + 4, remaining);
  const out = new Array<ServeHeld>();
  for (let i = 0; i < count; i += 1) {
    out.push(r.held());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type AppRequest =
  | { op: AppOp.CHANNEL; signalGroup: Bytes; app: string; name: string }
  | ({ op: AppOp.PIECES_BIND } & PiecesBindRequest)
  | {
      op: AppOp.PIECE_ACCEPT | AppOp.PIECE_OPENING;
      pieceKey: ChatKey;
      index: number;
      piece: Bytes;
    }
  | { op: AppOp.PIECES_COMPLETE | AppOp.BT_FILE; pieceKey: ChatKey }
  | { op: AppOp.ASSEMBLE | AppOp.GIT_OBJECTS; pieceKey: ChatKey; stream: Bytes }
  | ({ op: AppOp.BT_BUILD } & BtBuildRequest)
  | ({ op: AppOp.GIT_PREPARE } & GitPrepareRequest)
  | {
      op: AppOp.GIT_VIEW;
      signalGroup: Bytes;
      channelKey: ChatKey;
      repo: string;
      helds: ReadonlyArray<ServeHeld>;
    };

/** The body of a protocol-5 request (without the op byte). */
export function encodeAppRequestBody(req: AppRequest): Bytes {
  switch (req.op) {
    case AppOp.CHANNEL:
      return concatBytes([req.signalGroup, wStr(req.app), wStr(req.name)]);
    case AppOp.PIECES_BIND:
      return concatBytes([
        wStr(req.pieceKey),
        wStr(req.channelKey),
        req.signalGroup,
        wStr(req.app),
        req.ownAci,
        req.ownKey,
        wBytes(req.announcement),
        wBytes(req.opening),
      ]);
    case AppOp.PIECE_ACCEPT:
    case AppOp.PIECE_OPENING:
      return concatBytes([
        wStr(req.pieceKey),
        u32(req.index),
        wBytes(req.piece),
      ]);
    case AppOp.PIECES_COMPLETE:
    case AppOp.BT_FILE:
      return wStr(req.pieceKey);
    case AppOp.ASSEMBLE:
    case AppOp.GIT_OBJECTS:
      return concatBytes([wStr(req.pieceKey), wBytes(req.stream)]);
    case AppOp.BT_BUILD:
      return concatBytes([
        req.channel,
        req.author,
        req.nonce,
        u8(req.exp),
        wBytes(req.audience),
        wStr(req.name),
        wBytes(req.pointers),
        wBytes(req.stream),
      ]);
    case AppOp.GIT_PREPARE:
      return concatBytes([
        req.signalGroup,
        wStr(req.channelKey),
        req.author,
        req.nonce,
        u8(req.exp),
        wBytes(req.audience),
        u8(req.share ? 1 : 0),
        wSeats(req.expect),
        wStr(req.repo),
        wUpdates(req.updates),
        wHelds(req.helds),
        wBytes(req.pointers),
        wBytes(req.stream),
      ]);
    case AppOp.GIT_VIEW:
      return concatBytes([
        req.signalGroup,
        wStr(req.channelKey),
        wStr(req.repo),
        wHelds(req.helds),
      ]);
    default:
      throw new Error('zrdt codec5: unknown op');
  }
}

/** The request payload: op byte, then the body. */
export function encodeAppRequest(req: AppRequest): Bytes {
  return concatBytes([u8(req.op), encodeAppRequestBody(req)]);
}

function readAppRequest(op: AppOp, r: Reader, size: number): AppRequest {
  switch (op) {
    case AppOp.CHANNEL:
      return { op, signalGroup: r.take(32), app: r.str(), name: r.str() };
    case AppOp.PIECES_BIND:
      return {
        op,
        pieceKey: r.str(),
        channelKey: r.str(),
        signalGroup: r.take(32),
        app: r.str(),
        ownAci: r.take(ACI_BYTES),
        ownKey: r.take(IDENTITY_KEY_BYTES),
        announcement: r.bytes(),
        opening: r.bytes(),
      };
    case AppOp.PIECE_ACCEPT:
    case AppOp.PIECE_OPENING:
      return { op, pieceKey: r.str(), index: r.u32(), piece: r.bytes() };
    case AppOp.PIECES_COMPLETE:
    case AppOp.BT_FILE:
      return { op, pieceKey: r.str() };
    case AppOp.ASSEMBLE:
    case AppOp.GIT_OBJECTS:
      return { op, pieceKey: r.str(), stream: r.bytes() };
    case AppOp.BT_BUILD:
      return {
        op,
        channel: r.take(32),
        author: r.take(ACI_BYTES),
        nonce: r.take(32),
        exp: r.u8(),
        audience: r.bytes(),
        name: r.str(),
        pointers: r.bytes(),
        stream: r.bytes(),
      };
    case AppOp.GIT_PREPARE:
      return {
        op,
        signalGroup: r.take(32),
        channelKey: r.str(),
        author: r.take(ACI_BYTES),
        nonce: r.take(32),
        exp: r.u8(),
        audience: r.bytes(),
        share: r.flag(),
        expect: rSeats(r, size),
        repo: r.str(),
        updates: rUpdates(r),
        helds: rHelds(r, size),
        pointers: r.bytes(),
        stream: r.bytes(),
      };
    case AppOp.GIT_VIEW:
      return {
        op,
        signalGroup: r.take(32),
        channelKey: r.str(),
        repo: r.str(),
        helds: rHelds(r, size),
      };
    default:
      throw new Short();
  }
}

/**
 * A request payload of either protocol, as zrdtd reads it under protocol 5:
 * an op byte of the app ranges that no lane defines is UNKNOWN_OP; every
 * other byte is protocol 4 (`decodeRequest`).
 * @testexport
 */
export function decodeRequest5(
  payload: Uint8Array<ArrayBuffer>
): Request | AppRequest | Code.BAD_REQUEST | Code.UNKNOWN_OP {
  if (payload.length === 0) {
    return Code.BAD_REQUEST;
  }
  const op = payload[0] ?? 0;
  if (!isAppOpByte(op)) {
    return decodeRequest(payload);
  }
  if (AppOp[op] === undefined) {
    return Code.UNKNOWN_OP;
  }
  const body = payload.subarray(1);
  return (
    readAll(body, r => readAppRequest(op, r, body.length)) ?? Code.BAD_REQUEST
  );
}

/** Whether a decoded request is a protocol-5 one. */
export function isAppRequest(req: Request | AppRequest): req is AppRequest {
  return isAppOpByte(req.op);
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** What each app op returns, typed. */
export type AppResultOf = {
  [AppOp.CHANNEL]: ChannelResult;
  [AppOp.PIECES_BIND]: PiecesBindResult;
  [AppOp.PIECE_ACCEPT]: PieceAcceptResult;
  [AppOp.PIECE_OPENING]: PieceOpeningResult;
  [AppOp.PIECES_COMPLETE]: AcceptResult;
  [AppOp.ASSEMBLE]: AssembleResult;
  [AppOp.BT_BUILD]: BtBuildResult;
  [AppOp.BT_FILE]: BtFileResult;
  [AppOp.GIT_PREPARE]: GitPrepareResult;
  [AppOp.GIT_OBJECTS]: GitObjectsResult;
  [AppOp.GIT_VIEW]: GitViewResult;
};

const OBJECT_KINDS: ReadonlyArray<GitObjectKind> = ['commit', 'tree', 'blob'];

function badAppBytes(result: BadApp): Bytes {
  return concatBytes([
    u8(Code.BAD_APP),
    u8(BAD_APP_REASONS.indexOf(result.reason) + 1),
  ]);
}

function badObjectsBytes(result: BadObjects): Bytes {
  return concatBytes([
    u8(Code.BAD_OBJECTS),
    u8(BAD_OBJECTS_REASONS.indexOf(result.reason) + 1),
    result.oid ?? new Uint8Array(OID_BYTES),
  ]);
}

function pushRefusedBytes(result: PushRefused): Bytes {
  return concatBytes([
    u8(Code.PUSH_REFUSED),
    u8(PUSH_REFUSED_REASONS.indexOf(result.reason) + 1),
    u32(result.seats.length),
    ...result.seats.map(({ seat, mark }) =>
      concatBytes([wSeat(seat), u8(SEAT_MARKS.indexOf(mark))])
    ),
    u32(result.refs.length),
    ...result.refs.map(wRefname),
    u32(result.oids.length),
    ...result.oids,
  ]);
}

function objectEntryBytes(entry: GitObjectEntry): Bytes {
  return concatBytes([
    u8(OBJECT_KINDS.indexOf(entry.kind) + 1),
    entry.oid,
    u64(entry.offset),
    u64(entry.length),
  ]);
}

function logEntryBytes(entry: GitLogEntry): Bytes {
  return concatBytes([
    entry.digest,
    entry.author,
    u8(entry.share ? 1 : 0),
    wUpdate(entry.update),
  ]);
}

function refEntryBytes(entry: GitRefEntry): Bytes {
  return concatBytes([
    wRefname(entry.name),
    entry.digest,
    wOptOid(entry.value),
  ]);
}

/**
 * The reply payload (`status ‖ body`) of an app op, as zrdtd writes it.
 * @testexport
 */
export function encodeAppReply<O extends AppOp>(
  op: O,
  result: AppResultOf[O]
): Bytes {
  const ok = u8(Code.OK);
  const r = result as { kind: string };
  if (r.kind === 'badApp') {
    return badAppBytes(result as BadApp);
  }
  if (r.kind === 'badObjects') {
    return badObjectsBytes(result as BadObjects);
  }
  if (r.kind === 'badName') {
    return u8(Code.BAD_NAME);
  }
  if (r.kind === 'badOpening') {
    return u8(Code.BAD_OPENING);
  }
  if (r.kind === 'malformed') {
    return u8(Code.MALFORMED);
  }
  if (r.kind === 'pushRefused') {
    return pushRefusedBytes(result as PushRefused);
  }
  if (r.kind === 'openingsMissing') {
    const m = result as { digests: ReadonlyArray<Digest> };
    return concatBytes([u8(Code.OPENINGS_MISSING), wDigests(m.digests)]);
  }
  switch (op) {
    case AppOp.CHANNEL: {
      const c = result as Extract<ChannelResult, { kind: 'ok' }>;
      return concatBytes([ok, c.channel]);
    }
    case AppOp.PIECES_BIND: {
      const b = result as Extract<PiecesBindResult, { kind: 'ok' }>;
      return concatBytes([
        ok,
        u64(b.len),
        u8(b.exp),
        wDigests(b.ordered),
        wBytes(b.body),
        wBytes(b.manifest),
        wBytes(b.pointers),
      ]);
    }
    case AppOp.PIECE_ACCEPT: {
      const a = result as PieceAcceptResult;
      return a.kind === 'ok' ? concatBytes([ok, a.digest]) : u8(Code.BAD_PIECE);
    }
    case AppOp.PIECE_OPENING: {
      const o = result as PieceOpeningResult;
      return o.kind === 'ok'
        ? concatBytes([ok, wBytes(o.opening)])
        : u8(Code.BAD_PIECE);
    }
    case AppOp.PIECES_COMPLETE:
      return acceptBytes(result as AcceptResult);
    case AppOp.ASSEMBLE: {
      const a = result as AssembleResult;
      return a.kind === 'ok'
        ? ok
        : concatBytes([u8(Code.BAD_PIECE), u32(a.index)]);
    }
    case AppOp.BT_BUILD: {
      const b = result as Extract<BtBuildResult, { kind: 'ok' }>;
      return concatBytes([ok, wBytes(b.message), wDigests(b.ordered)]);
    }
    case AppOp.BT_FILE: {
      const f = result as Extract<BtFileResult, { kind: 'ok' }>;
      return concatBytes([ok, wStr(f.name), u64(f.len)]);
    }
    case AppOp.GIT_PREPARE: {
      const p = result as Extract<GitPrepareResult, { kind: 'ok' }>;
      return concatBytes([
        ok,
        wBytes(p.message),
        wDigests(p.ordered),
        wSeats(p.covers),
      ]);
    }
    case AppOp.GIT_OBJECTS: {
      const g = result as GitObjectsResult;
      if (g.kind === 'badPiece') {
        return concatBytes([u8(Code.BAD_PIECE), u32(g.index)]);
      }
      const objects = (g as Extract<GitObjectsResult, { kind: 'ok' }>).objects;
      return concatBytes([
        ok,
        u32(objects.length),
        ...objects.map(objectEntryBytes),
      ]);
    }
    case AppOp.GIT_VIEW: {
      const v = result as Extract<GitViewResult, { kind: 'ok' }>;
      return concatBytes([
        ok,
        u32(v.log.length),
        ...v.log.map(logEntryBytes),
        u32(v.refs.length),
        ...v.refs.map(refEntryBytes),
      ]);
    }
    default:
      throw new Error('zrdt codec5: unknown op');
  }
}

function readBadApp(r: Reader): BadApp {
  const reason = BAD_APP_REASONS[r.u8() - 1];
  if (reason === undefined) {
    throw new Short();
  }
  return { kind: 'badApp', reason };
}

function readBadObjects(r: Reader): BadObjects {
  const reason = BAD_OBJECTS_REASONS[r.u8() - 1];
  if (reason === undefined) {
    throw new Short();
  }
  const oid = r.take(OID_BYTES);
  return oid.every(byte => byte === 0)
    ? { kind: 'badObjects', reason }
    : { kind: 'badObjects', reason, oid };
}

function readPushRefused(r: Reader, size: number): PushRefused {
  const reason = PUSH_REFUSED_REASONS[r.u8() - 1];
  if (reason === undefined) {
    throw new Short();
  }
  const seatCount = rCount(r, SEAT_BYTES + 1, size);
  const seats = new Array<{
    seat: AppSeat;
    mark: (typeof SEAT_MARKS)[number];
  }>();
  for (let i = 0; i < seatCount; i += 1) {
    const seat = rSeat(r);
    const mark = SEAT_MARKS[r.u8()];
    if (mark === undefined) {
      throw new Short();
    }
    seats.push({ seat, mark });
  }
  const refCount = rCount(r, 2, size);
  const refs = new Array<string>();
  for (let i = 0; i < refCount; i += 1) {
    refs.push(rRefname(r));
  }
  const oidCount = rCount(r, OID_BYTES, size);
  const oids = new Array<Oid>();
  for (let i = 0; i < oidCount; i += 1) {
    oids.push(r.take(OID_BYTES));
  }
  return { kind: 'pushRefused', reason, seats, refs, oids };
}

function readObjectEntry(r: Reader): GitObjectEntry {
  const kind = OBJECT_KINDS[r.u8() - 1];
  if (kind === undefined) {
    throw new Short();
  }
  return { kind, oid: r.take(OID_BYTES), offset: rU64(r), length: rU64(r) };
}

/** The statuses each app op may reply, besides OK and the host errors. */
const STATUSES: Readonly<Record<AppOp, ReadonlyArray<Code>>> = {
  [AppOp.CHANNEL]: [Code.BAD_APP],
  [AppOp.PIECES_BIND]: [Code.MALFORMED, Code.BAD_APP],
  [AppOp.PIECE_ACCEPT]: [Code.BAD_PIECE],
  [AppOp.PIECE_OPENING]: [Code.BAD_PIECE],
  [AppOp.PIECES_COMPLETE]: [
    Code.MISSING,
    Code.COLLISION,
    Code.WRONG_CHAT,
    Code.TOO_LARGE,
  ],
  [AppOp.ASSEMBLE]: [Code.BAD_PIECE],
  [AppOp.BT_BUILD]: [Code.BAD_NAME, Code.BAD_APP],
  [AppOp.BT_FILE]: [Code.BAD_NAME, Code.BAD_APP],
  [AppOp.GIT_PREPARE]: [
    Code.PUSH_REFUSED,
    Code.BAD_OBJECTS,
    Code.OPENINGS_MISSING,
    Code.BAD_OPENING,
    Code.BAD_APP,
  ],
  [AppOp.GIT_OBJECTS]: [Code.BAD_PIECE, Code.BAD_OBJECTS, Code.BAD_APP],
  [AppOp.GIT_VIEW]: [Code.BAD_OPENING, Code.OPENINGS_MISSING, Code.BAD_APP],
};

function readOk(op: AppOp, r: Reader, size: number): unknown {
  switch (op) {
    case AppOp.CHANNEL:
      return { kind: 'ok', channel: r.take(32) };
    case AppOp.PIECES_BIND:
      return {
        kind: 'ok',
        len: rU64(r),
        exp: r.u8(),
        ordered: r.digests(),
        body: r.bytes(),
        manifest: r.bytes(),
        pointers: r.bytes(),
      };
    case AppOp.PIECE_ACCEPT:
      return { kind: 'ok', digest: r.take(32) };
    case AppOp.PIECE_OPENING:
      return { kind: 'ok', opening: r.bytes() };
    case AppOp.PIECES_COMPLETE:
      return { kind: 'accepted', digest: r.take(32), record: r.bytes() };
    case AppOp.ASSEMBLE:
      return { kind: 'ok' };
    case AppOp.BT_BUILD:
      return { kind: 'ok', message: r.bytes(), ordered: r.digests() };
    case AppOp.BT_FILE:
      return { kind: 'ok', name: r.str(), len: rU64(r) };
    case AppOp.GIT_PREPARE:
      return {
        kind: 'ok',
        message: r.bytes(),
        ordered: r.digests(),
        covers: rSeats(r, size),
      };
    case AppOp.GIT_OBJECTS: {
      const count = rCount(r, 1 + OID_BYTES + 16, size);
      const objects = new Array<GitObjectEntry>();
      for (let i = 0; i < count; i += 1) {
        objects.push(readObjectEntry(r));
      }
      return { kind: 'ok', objects };
    }
    case AppOp.GIT_VIEW: {
      const logCount = rCount(r, 32 + 16 + 1 + 5, size);
      const log = new Array<GitLogEntry>();
      for (let i = 0; i < logCount; i += 1) {
        log.push({
          digest: r.take(32),
          author: r.take(ACI_BYTES),
          share: r.flag(),
          update: rUpdate(r),
        });
      }
      const refCount = rCount(r, 2 + 32 + 1, size);
      const refs = new Array<GitRefEntry>();
      for (let i = 0; i < refCount; i += 1) {
        const name = rRefname(r);
        const digest = r.take(32);
        const value = rOptOid(r);
        refs.push(
          value === undefined ? { name, digest } : { name, digest, value }
        );
      }
      return { kind: 'ok', log, refs };
    }
    default:
      throw new Short();
  }
}

function readStatus(
  op: AppOp,
  status: number,
  r: Reader,
  size: number
): unknown {
  switch (status) {
    case Code.BAD_APP:
      return readBadApp(r);
    case Code.BAD_OBJECTS:
      return readBadObjects(r);
    case Code.BAD_NAME:
      return { kind: 'badName' };
    case Code.BAD_OPENING:
      return { kind: 'badOpening' };
    case Code.MALFORMED:
      return { kind: 'malformed' };
    case Code.PUSH_REFUSED:
      return readPushRefused(r, size);
    case Code.OPENINGS_MISSING:
      return { kind: 'openingsMissing', digests: r.digests() };
    case Code.MISSING:
      return { kind: 'missing', digests: r.digests() };
    case Code.COLLISION:
      return { kind: 'collision', digest: r.take(32) };
    case Code.WRONG_CHAT:
      return { kind: 'wrongChat' };
    case Code.TOO_LARGE:
      return { kind: 'tooLarge' };
    case Code.BAD_PIECE:
      return op === AppOp.ASSEMBLE || op === AppOp.GIT_OBJECTS
        ? { kind: 'badPiece', index: r.u32() }
        : { kind: 'badPiece' };
    default:
      throw new Short();
  }
}

/**
 * Reads a reply of an app op. Throws `ReplyError` for host errors and for
 * statuses the op cannot reply; undefined if the body does not have the
 * layout of its status.
 */
export function decodeAppReply<O extends AppOp>(
  op: O,
  status: number,
  body: Uint8Array<ArrayBuffer>
): AppResultOf[O] | undefined {
  const name = AppOp[op];
  if (status >= 0x80) {
    throw new ReplyError(op, status, name);
  }
  if (status !== Code.OK && !STATUSES[op].includes(status)) {
    throw new ReplyError(op, status, name);
  }
  return readAll(body, r =>
    status === Code.OK
      ? (readOk(op, r, body.length) as AppResultOf[O])
      : (readStatus(op, status, r, body.length) as AppResultOf[O])
  );
}

/** Seats sorted by (aci, tag) without repeats, as `seats` fields need them. */
export function sortSeats(seats: ReadonlyArray<AppSeat>): Array<AppSeat> {
  const byKey = new Map<string, AppSeat>();
  for (const seat of seats) {
    let key = '';
    for (const byte of concatBytes([seat.aci, seat.tag])) {
      key += byte.toString(16).padStart(2, '0');
    }
    byKey.set(key, seat);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => {
      if (a < b) {
        return -1;
      }
      return a > b ? 1 : 0;
    })
    .map(([, seat]) => seat);
}
