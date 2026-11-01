// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The bytes of every zrdtd request and reply (zrdt core/Zrdt/Proto.lean, the
// module header). Both directions are here: the daemon backend encodes
// requests and decodes replies; the rung-7 differential test decodes the
// vector requests, runs them on a backend, and encodes the replies again.
//
// Lead decision (4), implemented in Lean by lane T5: the ACCEPT reply also
// carries the record bytes, the COMMIT reply also carries the opening, and a
// new op ACCEPT_RECORD (with status BAD_OPENING) takes an encoded record.
// The readers below accept both the old and the new reply layouts (by body
// length), so the host works with either zrdtd.
//
// TODO(zrdt T0): ACCEPT_RECORD's op byte (0x10), BAD_OPENING's status byte
// (0x08) and the optional opening as `u8 flag ‖ bytes` are this lane's guess
// at T5's layout. Check them against core/Zrdt/Proto.lean once build/t5-core
// lands.

import type {
  AcceptRecordResult,
  AcceptResult,
  Bytes,
  ChatKey,
  CommitResult,
  Digest,
  OpenInput,
  OpenResult,
  Provenance,
  ProvenanceFact,
  RecordParts,
  RecordStatus,
  SalvageResult,
  Status,
  VersionInfo,
} from '../ZrdtBackend.std.ts';

export enum Op {
  VERSION = 0x01,
  NEW = 0x02,
  OPEN = 0x03,
  SALVAGE = 0x04,
  COMMIT = 0x05,
  HASH = 0x06,
  ACCEPT = 0x07,
  HEADS = 0x08,
  HAS = 0x09,
  GET = 0x0a,
  REACH_SET = 0x0b,
  MERGE = 0x0c,
  CLASSIFY = 0x0d,
  ENCODE = 0x0e,
  CLOSE = 0x0f,
  ACCEPT_RECORD = 0x10,
}

export enum Code {
  OK = 0x00,
  MISSING = 0x01,
  COLLISION = 0x02,
  WRONG_CHAT = 0x03,
  TOO_LARGE = 0x04,
  MALFORMED = 0x05,
  UNVERIFIABLE = 0x06,
  NOT_FOUND = 0x07,
  BAD_OPENING = 0x08,
  BAD_REQUEST = 0x80,
  UNKNOWN_OP = 0x81,
  NO_CHAT = 0x82,
  CHAT_OPEN = 0x83,
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function concatBytes(parts: ReadonlyArray<Uint8Array>): Bytes {
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

export function u8(value: number): Bytes {
  return Uint8Array.of(value);
}

export function u32(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/** `bytes`: a u32 length, then the bytes. */
export function wBytes(bytes: Uint8Array): Bytes {
  return concatBytes([u32(bytes.length), bytes]);
}

/** `str`: UTF-8 text as `bytes`. */
export function wStr(text: string): Bytes {
  return wBytes(new TextEncoder().encode(text));
}

/** `digests`: a u32 count, then the digests. */
export function wDigests(digests: ReadonlyArray<Uint8Array>): Bytes {
  return concatBytes([u32(digests.length), ...digests]);
}

/** `parts`: group ‖ commit ‖ links (`digests`) ‖ author. */
export function wParts(parts: RecordParts): Bytes {
  return concatBytes([
    parts.group,
    parts.commit,
    wDigests(parts.links),
    parts.author,
  ]);
}

function wInput(input: OpenInput): Bytes {
  if (input instanceof Uint8Array) {
    return concatBytes([u8(0), wBytes(input)]);
  }
  return concatBytes([u8(1), u32(input.length), ...input.map(wBytes)]);
}

function wProvenance(provenance: Provenance): Bytes {
  switch (provenance.kind) {
    case 'live':
      return u8(0);
    case 'relayed':
      return concatBytes([u8(1), provenance.by]);
    case 'imported':
      return u8(2);
    default:
      throw new Error('zrdt codec: unknown provenance');
  }
}

function wFact(fact: ProvenanceFact): Bytes {
  return concatBytes([
    fact.digest,
    wProvenance(fact.provenance),
    wDigests(fact.disown),
  ]);
}

function wStatus(status: Status): Bytes {
  switch (status.kind) {
    case 'confirmedByAuthor':
      return u8(0);
    case 'notConfirmedByAuthor':
      return u8(1);
    case 'heldBy':
      return concatBytes([u8(2), status.aci]);
    case 'unconfirmed':
      return u8(3);
    default:
      throw new Error('zrdt codec: unknown status');
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

class Short extends Error {}

/** Reads fields from a body; throws `Short` when a field is cut short. */
export class Reader {
  #offset = 0;
  readonly #bytes: Bytes;

  constructor(bytes: Uint8Array) {
    this.#bytes = new Uint8Array(bytes);
  }

  get done(): boolean {
    return this.#offset === this.#bytes.length;
  }

  take(n: number): Bytes {
    if (n < 0 || this.#offset + n > this.#bytes.length) {
      throw new Short();
    }
    const out = this.#bytes.slice(this.#offset, this.#offset + n);
    this.#offset += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0] ?? 0;
  }

  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer).getUint32(0, false);
  }

  bytes(): Bytes {
    return this.take(this.u32());
  }

  str(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes());
  }

  digests(): Array<Digest> {
    const count = this.u32();
    // Never size an allocation from an untrusted count.
    if (count * 32 > this.#bytes.length - this.#offset) {
      throw new Short();
    }
    const out = new Array<Digest>();
    for (let i = 0; i < count; i += 1) {
      out.push(this.take(32));
    }
    return out;
  }

  parts(): RecordParts {
    const group = this.take(32);
    const commit = this.take(32);
    const links = this.digests();
    const author = this.take(16);
    return { group, commit, links, author };
  }

  input(): OpenInput {
    const form = this.u8();
    if (form === 0) {
      return this.bytes();
    }
    if (form === 1) {
      const count = this.u32();
      if (count * 4 > this.#bytes.length) {
        throw new Short();
      }
      const list = new Array<Bytes>();
      for (let i = 0; i < count; i += 1) {
        list.push(this.bytes());
      }
      return list;
    }
    throw new Short();
  }

  provenance(): Provenance {
    const p = this.u8();
    if (p === 0) {
      return { kind: 'live' };
    }
    if (p === 1) {
      return { kind: 'relayed', by: this.take(16) };
    }
    if (p === 2) {
      return { kind: 'imported' };
    }
    throw new Short();
  }

  fact(): ProvenanceFact {
    const digest = this.take(32);
    const provenance = this.provenance();
    const disown = this.digests();
    return { digest, provenance, disown };
  }

  status(): Status {
    const s = this.u8();
    switch (s) {
      case 0:
        return { kind: 'confirmedByAuthor' };
      case 1:
        return { kind: 'notConfirmedByAuthor' };
      case 2:
        return { kind: 'heldBy', aci: this.take(16) };
      case 3:
        return { kind: 'unconfirmed' };
      default:
        throw new Short();
    }
  }

  /** Throws unless every byte was read. */
  end(): void {
    if (!this.done) {
      throw new Short();
    }
  }
}

/** Runs `read` on `bytes`; undefined if a field is cut short or bytes are left. */
export function readAll<T>(
  bytes: Uint8Array,
  read: (r: Reader) => T
): T | undefined {
  const r = new Reader(bytes);
  try {
    const value = read(r);
    r.end();
    return value;
  } catch (error) {
    if (error instanceof Short || error instanceof TypeError) {
      return undefined;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type Request =
  | { op: Op.VERSION }
  | { op: Op.NEW; chat: ChatKey; group: Bytes }
  | { op: Op.OPEN | Op.SALVAGE; chat: ChatKey; group: Bytes; input: OpenInput }
  | {
      op: Op.COMMIT;
      group: Bytes;
      author: Bytes;
      nonce: Bytes;
      dataMessage: Bytes;
    }
  | { op: Op.HASH; parts: RecordParts }
  | { op: Op.ACCEPT; chat: ChatKey; parts: RecordParts }
  | { op: Op.HEADS | Op.ENCODE | Op.CLOSE; chat: ChatKey }
  | { op: Op.HAS | Op.GET; chat: ChatKey; digest: Digest }
  | { op: Op.REACH_SET; chat: ChatKey; from: ReadonlyArray<Digest> }
  | { op: Op.MERGE; chat: ChatKey; blob: Bytes }
  | { op: Op.CLASSIFY; chat: ChatKey; facts: ReadonlyArray<ProvenanceFact> }
  | { op: Op.ACCEPT_RECORD; chat: ChatKey; record: Bytes; opening?: Bytes };

/** The body of a request (without the op byte). */
export function encodeRequestBody(req: Request): Bytes {
  switch (req.op) {
    case Op.VERSION:
      return new Uint8Array(0);
    case Op.NEW:
      return concatBytes([wStr(req.chat), req.group]);
    case Op.OPEN:
    case Op.SALVAGE:
      return concatBytes([wStr(req.chat), req.group, wInput(req.input)]);
    case Op.COMMIT:
      return concatBytes([
        req.group,
        req.author,
        req.nonce,
        wBytes(req.dataMessage),
      ]);
    case Op.HASH:
      return wParts(req.parts);
    case Op.ACCEPT:
      return concatBytes([wStr(req.chat), wParts(req.parts)]);
    case Op.HEADS:
    case Op.ENCODE:
    case Op.CLOSE:
      return wStr(req.chat);
    case Op.HAS:
    case Op.GET:
      return concatBytes([wStr(req.chat), req.digest]);
    case Op.REACH_SET:
      return concatBytes([wStr(req.chat), wDigests(req.from)]);
    case Op.MERGE:
      return concatBytes([wStr(req.chat), wBytes(req.blob)]);
    case Op.CLASSIFY:
      return concatBytes([
        wStr(req.chat),
        u32(req.facts.length),
        ...req.facts.map(wFact),
      ]);
    case Op.ACCEPT_RECORD:
      return concatBytes([
        wStr(req.chat),
        wBytes(req.record),
        req.opening === undefined
          ? u8(0)
          : concatBytes([u8(1), wBytes(req.opening)]),
      ]);
    default:
      throw new Error('zrdt codec: unknown op');
  }
}

/**
 * A request payload (`op ‖ body`) as a typed request, or the host error
 * zrdtd replies with: BAD_REQUEST (empty payload, wrong layout) or
 * UNKNOWN_OP. `withAcceptRecord` is false for a protocol without
 * ACCEPT_RECORD.
 */
export function decodeRequest(
  payload: Uint8Array,
  { withAcceptRecord = true }: { withAcceptRecord?: boolean } = {}
): Request | Code.BAD_REQUEST | Code.UNKNOWN_OP {
  if (payload.length === 0) {
    return Code.BAD_REQUEST;
  }
  const op = payload[0] ?? 0;
  const body = payload.subarray(1);
  let req: Request | undefined;
  switch (op) {
    case Op.VERSION:
      req = readAll(body, () => ({ op: Op.VERSION }));
      break;
    case Op.NEW:
      req = readAll(body, r => ({ op, chat: r.str(), group: r.take(32) }));
      break;
    case Op.OPEN:
    case Op.SALVAGE:
      req = readAll(body, r => ({
        op,
        chat: r.str(),
        group: r.take(32),
        input: r.input(),
      }));
      break;
    case Op.COMMIT:
      req = readAll(body, r => ({
        op,
        group: r.take(32),
        author: r.take(16),
        nonce: r.take(32),
        dataMessage: r.bytes(),
      }));
      break;
    case Op.HASH:
      req = readAll(body, r => ({ op, parts: r.parts() }));
      break;
    case Op.ACCEPT:
      req = readAll(body, r => ({ op, chat: r.str(), parts: r.parts() }));
      break;
    case Op.HEADS:
    case Op.ENCODE:
    case Op.CLOSE:
      req = readAll(body, r => ({ op, chat: r.str() }));
      break;
    case Op.HAS:
    case Op.GET:
      req = readAll(body, r => ({ op, chat: r.str(), digest: r.take(32) }));
      break;
    case Op.REACH_SET:
      req = readAll(body, r => ({ op, chat: r.str(), from: r.digests() }));
      break;
    case Op.MERGE:
      req = readAll(body, r => ({ op, chat: r.str(), blob: r.bytes() }));
      break;
    case Op.CLASSIFY:
      req = readAll(body, r => {
        const chat = r.str();
        const count = r.u32();
        const facts = new Array<ProvenanceFact>();
        for (let i = 0; i < count; i += 1) {
          facts.push(r.fact());
        }
        return { op, chat, facts };
      });
      break;
    case Op.ACCEPT_RECORD:
      if (!withAcceptRecord) {
        return Code.UNKNOWN_OP;
      }
      req = readAll(body, r => {
        const chat = r.str();
        const record = r.bytes();
        const flag = r.u8();
        if (flag === 0) {
          return { op, chat, record };
        }
        if (flag === 1) {
          return { op, chat, record, opening: r.bytes() };
        }
        throw new Short();
      });
      break;
    default:
      return Code.UNKNOWN_OP;
  }
  return req ?? Code.BAD_REQUEST;
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** The replies from 0x80 up: the host sent a request zrdtd cannot carry out. */
export type HostError =
  | Code.BAD_REQUEST
  | Code.UNKNOWN_OP
  | Code.NO_CHAT
  | Code.CHAT_OPEN;

export function isHostError(code: number): code is HostError {
  return code >= 0x80;
}

/** What each op returns, typed. */
export type ResultOf = {
  [Op.VERSION]: VersionInfo;
  [Op.NEW]: undefined;
  [Op.OPEN]: OpenResult;
  [Op.SALVAGE]: SalvageResult;
  [Op.COMMIT]: CommitResult;
  [Op.HASH]: Digest;
  [Op.ACCEPT]: AcceptResult;
  [Op.HEADS]: Array<Digest>;
  [Op.HAS]: boolean;
  [Op.GET]: RecordParts | undefined;
  [Op.REACH_SET]: Array<Digest>;
  [Op.MERGE]: OpenResult;
  [Op.CLASSIFY]: Array<RecordStatus>;
  [Op.ENCODE]: Bytes;
  [Op.CLOSE]: undefined;
  [Op.ACCEPT_RECORD]: AcceptRecordResult;
};

export type ReplyOptions = Readonly<{
  /**
   * Lead decision (4): the ACCEPT and ACCEPT_RECORD replies carry the record
   * bytes, and the COMMIT reply carries the opening. False for the protocol
   * 1 layout of zrdt e2b3160.
   */
  extended: boolean;
}>;

/** Replies shared by OPEN, SALVAGE, MERGE, ACCEPT, ACCEPT_RECORD. */
function refusalBytes(result: { kind: string; digest?: Digest }): Bytes {
  switch (result.kind) {
    case 'collision':
      return concatBytes([
        u8(Code.COLLISION),
        result.digest ?? new Uint8Array(32),
      ]);
    case 'wrongChat':
      return u8(Code.WRONG_CHAT);
    case 'tooLarge':
      return u8(Code.TOO_LARGE);
    case 'malformed':
      return u8(Code.MALFORMED);
    case 'badOpening':
      return u8(Code.BAD_OPENING);
    default:
      throw new Error(`zrdt codec: no reply for ${result.kind}`);
  }
}

function acceptBytes(
  result: AcceptRecordResult,
  { extended }: ReplyOptions
): Bytes {
  if (result.kind === 'accepted') {
    return extended
      ? concatBytes([u8(Code.OK), result.digest, wBytes(result.record)])
      : concatBytes([u8(Code.OK), result.digest]);
  }
  if (result.kind === 'missing') {
    return concatBytes([u8(Code.MISSING), wDigests(result.digests)]);
  }
  return refusalBytes(result);
}

function openBytes(result: OpenResult): Bytes {
  if (result.kind === 'ok') {
    return u8(Code.OK);
  }
  if (result.kind === 'unverifiable') {
    return concatBytes([
      u8(Code.UNVERIFIABLE),
      wDigests(result.unverifiable),
      wDigests(result.missing),
    ]);
  }
  return refusalBytes(result);
}

/** The reply payload (`status ‖ body`) for a typed result. */
export function encodeReply<O extends Op>(
  op: O,
  result: ResultOf[O],
  options: ReplyOptions
): Bytes {
  const ok = u8(Code.OK);
  switch (op) {
    case Op.VERSION: {
      const v = result as VersionInfo;
      return concatBytes([ok, u32(v.protocol), wStr(v.build)]);
    }
    case Op.NEW:
    case Op.CLOSE:
      return ok;
    case Op.OPEN:
    case Op.MERGE:
      return openBytes(result as OpenResult);
    case Op.SALVAGE: {
      const s = result as SalvageResult;
      if (s.kind === 'ok') {
        return concatBytes([ok, wDigests(s.dropped), wDigests(s.missing)]);
      }
      return refusalBytes(s);
    }
    case Op.COMMIT: {
      const c = result as CommitResult;
      if (c.kind === 'malformed') {
        return u8(Code.MALFORMED);
      }
      return options.extended
        ? concatBytes([ok, c.commit, wBytes(c.opening)])
        : concatBytes([ok, c.commit]);
    }
    case Op.HASH:
      return concatBytes([ok, result as Digest]);
    case Op.ACCEPT:
    case Op.ACCEPT_RECORD:
      return acceptBytes(result as AcceptRecordResult, options);
    case Op.HEADS:
    case Op.REACH_SET:
      return concatBytes([ok, wDigests(result as Array<Digest>)]);
    case Op.HAS:
      return concatBytes([ok, u8(result ? 1 : 0)]);
    case Op.GET: {
      const parts = result as RecordParts | undefined;
      return parts === undefined
        ? u8(Code.NOT_FOUND)
        : concatBytes([ok, wParts(parts)]);
    }
    case Op.CLASSIFY: {
      const list = result as Array<RecordStatus>;
      return concatBytes([
        ok,
        u32(list.length),
        ...list.flatMap(({ digest, status }) => [digest, wStatus(status)]),
      ]);
    }
    case Op.ENCODE:
      return concatBytes([ok, wBytes(result as Bytes)]);
    default:
      throw new Error('zrdt codec: unknown op');
  }
}

/** Why a reply could not be read. */
export class ReplyError extends Error {
  readonly status: number;

  constructor(op: Op, status: number) {
    super(`zrdt: unexpected reply 0x${status.toString(16)} to ${Op[op]}`);
    this.status = status;
  }
}

function readRefusal(
  op: Op,
  status: number,
  r: Reader
):
  | { kind: 'collision'; digest: Digest }
  | { kind: 'wrongChat' }
  | { kind: 'tooLarge' }
  | { kind: 'malformed' }
  | { kind: 'badOpening' } {
  switch (status) {
    case Code.COLLISION:
      return { kind: 'collision', digest: r.take(32) };
    case Code.WRONG_CHAT:
      return { kind: 'wrongChat' };
    case Code.TOO_LARGE:
      return { kind: 'tooLarge' };
    case Code.MALFORMED:
      return { kind: 'malformed' };
    case Code.BAD_OPENING:
      return { kind: 'badOpening' };
    default:
      throw new ReplyError(op, status);
  }
}

/**
 * Reads a reply of `op`. For ACCEPT and COMMIT replies of the protocol 1
 * layout, `record` and `opening` are empty: the caller fills them in.
 * Throws `ReplyError` for host errors and for statuses the op cannot reply;
 * returns undefined if the body does not have the layout of its status.
 */
export function decodeReply<O extends Op>(
  op: O,
  status: number,
  body: Uint8Array
): ResultOf[O] | undefined {
  if (isHostError(status)) {
    throw new ReplyError(op, status);
  }
  type R = ResultOf[O];
  return readAll(body, (r): R => {
    switch (op) {
      case Op.VERSION:
        if (status !== Code.OK) {
          break;
        }
        return { protocol: r.u32(), build: r.str() } as R;
      case Op.NEW:
      case Op.CLOSE:
        if (status !== Code.OK) {
          break;
        }
        return undefined as R;
      case Op.OPEN:
      case Op.MERGE: {
        if (status === Code.OK) {
          return { kind: 'ok' } as R;
        }
        if (status === Code.UNVERIFIABLE) {
          return {
            kind: 'unverifiable',
            unverifiable: r.digests(),
            missing: r.digests(),
          } as R;
        }
        const refused = readRefusal(op, status, r);
        if (refused.kind === 'badOpening') {
          break;
        }
        return refused as R;
      }
      case Op.SALVAGE: {
        if (status === Code.OK) {
          return {
            kind: 'ok',
            dropped: r.digests(),
            missing: r.digests(),
          } as R;
        }
        const refused = readRefusal(op, status, r);
        if (refused.kind === 'badOpening') {
          break;
        }
        return refused as R;
      }
      case Op.COMMIT: {
        if (status === Code.MALFORMED) {
          return { kind: 'malformed' } as R;
        }
        if (status !== Code.OK) {
          break;
        }
        const commit = r.take(32);
        const opening = r.done ? new Uint8Array(0) : r.bytes();
        return { kind: 'ok', commit, opening } as R;
      }
      case Op.HASH:
        if (status !== Code.OK) {
          break;
        }
        return r.take(32) as R;
      case Op.ACCEPT:
      case Op.ACCEPT_RECORD: {
        if (status === Code.OK) {
          const digest = r.take(32);
          const record = r.done ? new Uint8Array(0) : r.bytes();
          return { kind: 'accepted', digest, record } as R;
        }
        if (status === Code.MISSING) {
          return { kind: 'missing', digests: r.digests() } as R;
        }
        const refused = readRefusal(op, status, r);
        if (
          op === Op.ACCEPT &&
          (refused.kind === 'malformed' || refused.kind === 'badOpening')
        ) {
          break;
        }
        return refused as R;
      }
      case Op.HEADS:
      case Op.REACH_SET:
        if (status !== Code.OK) {
          break;
        }
        return r.digests() as R;
      case Op.HAS: {
        if (status !== Code.OK) {
          break;
        }
        const flag = r.u8();
        if (flag > 1) {
          throw new Short();
        }
        return (flag === 1) as R;
      }
      case Op.GET:
        if (status === Code.NOT_FOUND) {
          return undefined as R;
        }
        if (status !== Code.OK) {
          break;
        }
        return r.parts() as R;
      case Op.CLASSIFY: {
        if (status !== Code.OK) {
          break;
        }
        const count = r.u32();
        const list = new Array<RecordStatus>();
        for (let i = 0; i < count; i += 1) {
          list.push({ digest: r.take(32), status: r.status() });
        }
        return list as R;
      }
      case Op.ENCODE:
        if (status !== Code.OK) {
          break;
        }
        return r.bytes() as R;
      default:
        break;
    }
    throw new ReplyError(op, status);
  });
}
