// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable max-classes-per-file

// The zrdt TypeScript stub: the same semantics as zrdtd, in plain TypeScript.
//
// It serves two purposes. The host can be built against it before the Lean
// daemon exists, and it is the independent reimplementation for the
// differential test (zrdt PLAN.md section 6, rung 7). It is written from
// PLAN.md sections 3.3 to 3.5 only, not from the Lean code, so that a test
// that compares the two finds mistakes in either. Keep it small and plain.

import { createHash } from 'node:crypto';

import {
  ACI_BYTES,
  COMMIT_BYTES,
  DIGEST_BYTES,
  GROUP_ID_BYTES,
  MAX_LINKS,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  RECORD_COUNT_LIMIT,
  ZrdtBackendError,
} from '../ZrdtBackend.std.ts';
import type {
  AcceptRecordResult,
  AcceptResult,
  BackendKind,
  Bytes,
  ChatKey,
  CommitResult,
  Digest,
  OpenInput,
  OpenResult,
  ProvenanceFact,
  RecordParts,
  RecordStatus,
  Refused,
  SalvageResult,
  Status,
  VersionInfo,
  ZrdtBackend,
} from '../ZrdtBackend.std.ts';

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/** The bytes of an ASCII string. */
function ascii(text: string): Bytes {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

function concat(parts: ReadonlyArray<Bytes>): Bytes {
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

function equal(a: Bytes, b: Bytes): boolean {
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

/** Bytewise order; a proper prefix comes first. */
export function compareBytes(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x - y;
    }
  }
  return a.length - b.length;
}

/** A map key for a digest. */
function key(digest: Bytes): string {
  return Buffer.from(
    digest.buffer,
    digest.byteOffset,
    digest.byteLength
  ).toString('hex');
}

function u32(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function readU32(bytes: Bytes, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(offset, false);
}

export function sha256(...parts: ReadonlyArray<Bytes>): Bytes {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return new Uint8Array(hash.digest());
}

function checkSize(name: string, value: Bytes, size: number): void {
  if (value.length !== size) {
    throw new ZrdtBackendError(
      'badInput',
      `${name} must be ${size} bytes, got ${value.length}`
    );
  }
}

/** Sorted copies of the given digests, each once. */
function sortedUnique(digests: Iterable<Bytes>): Array<Digest> {
  const byKey = new Map<string, Bytes>();
  for (const digest of digests) {
    byKey.set(key(digest), digest);
  }
  return [...byKey.values()]
    .sort(compareBytes)
    .map(digest => new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Records (PLAN.md section 3.4)
// ---------------------------------------------------------------------------

/** A record in canonical form: its links are strictly sorted. */
export type StubRecord = Readonly<{
  group: Bytes;
  commit: Bytes;
  links: ReadonlyArray<Digest>;
  author: Bytes;
}>;

const RECORD_MAGIC = ascii('zrdt2');

/** Bytes of a record with no links: magic, group, commit, count, author. */
const RECORD_FIXED_BYTES =
  RECORD_MAGIC.length + GROUP_ID_BYTES + COMMIT_BYTES + 4 + ACI_BYTES;

/**
 * The one record constructor: checks the field sizes, copies the bytes,
 * sorts the links and drops duplicate links.
 */
export function makeRecord(parts: RecordParts): StubRecord {
  checkSize('group', parts.group, GROUP_ID_BYTES);
  checkSize('commit', parts.commit, COMMIT_BYTES);
  checkSize('author', parts.author, ACI_BYTES);
  for (const link of parts.links) {
    checkSize('link', link, DIGEST_BYTES);
  }
  return {
    group: new Uint8Array(parts.group),
    commit: new Uint8Array(parts.commit),
    links: sortedUnique(parts.links),
    author: new Uint8Array(parts.author),
  };
}

/** `"zrdt2" ‖ group(32) ‖ commit(32) ‖ u32 nlinks ‖ links ‖ author(16)` */
export function encodeRecord(record: StubRecord): Bytes {
  return concat([
    RECORD_MAGIC,
    record.group,
    record.commit,
    u32(record.links.length),
    ...record.links,
    record.author,
  ]);
}

/**
 * Strict decode: right magic, exact length, links strictly sorted. Returns
 * undefined for anything else. It does not check the link limit.
 */
export function decodeRecord(bytes: Bytes): StubRecord | undefined {
  if (bytes.length < RECORD_FIXED_BYTES) {
    return undefined;
  }
  if (!equal(bytes.subarray(0, RECORD_MAGIC.length), RECORD_MAGIC)) {
    return undefined;
  }
  let offset = RECORD_MAGIC.length;
  const group = bytes.slice(offset, offset + GROUP_ID_BYTES);
  offset += GROUP_ID_BYTES;
  const commit = bytes.slice(offset, offset + COMMIT_BYTES);
  offset += COMMIT_BYTES;
  const count = readU32(bytes, offset);
  offset += 4;
  if (bytes.length !== RECORD_FIXED_BYTES + count * DIGEST_BYTES) {
    return undefined;
  }
  const links = new Array<Digest>();
  for (let i = 0; i < count; i += 1) {
    const link = bytes.slice(offset, offset + DIGEST_BYTES);
    const previous = links.at(-1);
    if (previous !== undefined && compareBytes(previous, link) >= 0) {
      return undefined;
    }
    links.push(link);
    offset += DIGEST_BYTES;
  }
  const author = bytes.slice(offset, offset + ACI_BYTES);
  return { group, commit, links, author };
}

/**
 * How record digests are computed from record encodings. Always SHA-256,
 * except in tests that need collisions or cycles on purpose.
 */
export type RecordHash = (encoded: Bytes) => Digest;

/** The digest of a record: SHA-256 of its encoding. */
export function hashRecord(
  record: StubRecord,
  hash: RecordHash = sha256
): Digest {
  return hash(encodeRecord(record));
}

function toParts(record: StubRecord): RecordParts {
  return {
    group: new Uint8Array(record.group),
    commit: new Uint8Array(record.commit),
    links: record.links.map(link => new Uint8Array(link)),
    author: new Uint8Array(record.author),
  };
}

// ---------------------------------------------------------------------------
// Commitment (PLAN.md section 3.4)
// ---------------------------------------------------------------------------

const COMMIT_MAGIC = ascii('zrdtP1');

/** DataMessage.groupV2: holds the group master key. */
const FIELD_GROUP_V2 = 15;
/** DataMessage.zrdt: the links themselves. */
const FIELD_ZRDT = 200;

/** A protobuf varint at `offset`: its value and where the next field starts. */
function readVarint(
  bytes: Bytes,
  offset: number
): { value: number; next: number } | undefined {
  let value = 0;
  let scale = 1;
  // A varint has at most 10 bytes. Values past 2^53 lose precision, which
  // is harmless: they only ever serve as lengths, and such a length is
  // always past the end of the message.
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

/**
 * The protobuf message with every top-level field whose number is in `drop`
 * removed; all other fields are kept byte for byte, in order. Returns
 * undefined if the bytes are not a sequence of well-formed fields (wire
 * types 0, 1, 2 and 5 only; field number at least 1).
 */
export function removeTopLevelFields(
  message: Bytes,
  drop: ReadonlySet<number>
): Bytes | undefined {
  const kept = new Array<Bytes>();
  let offset = 0;
  while (offset < message.length) {
    const start = offset;
    const tag = readVarint(message, offset);
    if (tag === undefined || tag.value > 0xffffffff) {
      return undefined;
    }
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (field === 0) {
      return undefined;
    }
    offset = tag.next;
    if (wireType === 0) {
      const varint = readVarint(message, offset);
      if (varint === undefined) {
        return undefined;
      }
      offset = varint.next;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(message, offset);
      if (length === undefined) {
        return undefined;
      }
      offset = length.next + length.value;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      return undefined;
    }
    if (offset > message.length) {
      return undefined;
    }
    if (!drop.has(field)) {
      kept.push(message.subarray(start, offset));
    }
  }
  return concat(kept);
}

/**
 * `SHA-256("zrdtP1" ‖ group ‖ author ‖ nonce ‖ DataMessage without fields
 * 15 and 200)`. Throws `badInput` on wrong sizes or bytes that are not
 * protobuf.
 */
export function commitment(
  group: Bytes,
  author: Bytes,
  nonce: Bytes,
  dataMessage: Bytes
): Bytes {
  const result = commitWithOpening(group, author, nonce, dataMessage);
  if (result.kind !== 'ok') {
    throw new ZrdtBackendError('badInput', 'DataMessage is not protobuf');
  }
  return result.commit;
}

/**
 * COMMIT: the commitment and the opening (`nonce ‖ DataMessage without fields
 * 15 and 200`), or `malformed` for bytes that are not protobuf. Throws
 * `badInput` on wrong sizes.
 */
export function commitWithOpening(
  group: Bytes,
  author: Bytes,
  nonce: Bytes,
  dataMessage: Bytes
): CommitResult {
  checkSize('group', group, GROUP_ID_BYTES);
  checkSize('author', author, ACI_BYTES);
  checkSize('nonce', nonce, NONCE_BYTES);
  const committed = removeTopLevelFields(
    dataMessage,
    new Set([FIELD_GROUP_V2, FIELD_ZRDT])
  );
  if (committed === undefined) {
    return { kind: 'malformed' };
  }
  const opening = concat([nonce, committed]);
  return {
    kind: 'ok',
    commit: sha256(COMMIT_MAGIC, group, author, opening),
    opening,
  };
}

/**
 * Whether `opening` opens the record's commitment (Lean `openingMatches`):
 * a 32-byte nonce, then well-formed protobuf bytes with no top-level field
 * 15 or 200, whose commitment under the record's group and author is the
 * record's commit.
 */
export function opens(record: StubRecord, opening: Bytes): boolean {
  if (opening.length < NONCE_BYTES) {
    return false;
  }
  const committed = opening.subarray(NONCE_BYTES);
  const stripped = removeTopLevelFields(
    committed,
    new Set([FIELD_GROUP_V2, FIELD_ZRDT])
  );
  if (stripped === undefined || !equal(stripped, committed)) {
    return false;
  }
  return equal(
    sha256(COMMIT_MAGIC, record.group, record.author, opening),
    record.commit
  );
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

type Entry = Readonly<{ record: StubRecord; encoded: Bytes; digest: Digest }>;

/**
 * One chat's records, keyed by digest. Records enter only through
 * `accept`, so every link of a stored record is stored too, and the head
 * set is the stored digests that no stored record links.
 */
export class StubStore {
  readonly group: Bytes;
  readonly hash: RecordHash;
  readonly #entries = new Map<string, Entry>();
  readonly #heads = new Set<string>();

  constructor(group: Bytes, hash: RecordHash = sha256) {
    checkSize('group', group, GROUP_ID_BYTES);
    this.group = new Uint8Array(group);
    this.hash = hash;
  }

  get size(): number {
    return this.#entries.size;
  }

  clone(): StubStore {
    const copy = new StubStore(this.group, this.hash);
    for (const [k, entry] of this.#entries) {
      copy.#entries.set(k, entry);
    }
    for (const k of this.#heads) {
      copy.#heads.add(k);
    }
    return copy;
  }

  has(digest: Bytes): boolean {
    return this.#entries.has(key(digest));
  }

  entry(digest: Bytes): Entry | undefined {
    return this.#entries.get(key(digest));
  }

  /** Every entry, sorted by digest. */
  entries(): Array<Entry> {
    return [...this.#entries.values()].sort((a, b) =>
      compareBytes(a.digest, b.digest)
    );
  }

  heads(): Array<Digest> {
    return sortedUnique(
      [...this.#heads].map(k => {
        const entry = this.#entries.get(k);
        if (entry === undefined) {
          throw new Error('zrdt stub: head is not stored');
        }
        return entry.digest;
      })
    );
  }

  /** Add a record if its group is right and every link is stored. */
  accept(record: StubRecord): AcceptResult {
    if (record.links.length > MAX_LINKS) {
      return { kind: 'tooLarge' };
    }
    if (!equal(record.group, this.group)) {
      return { kind: 'wrongChat' };
    }
    const encoded = encodeRecord(record);
    const digest = this.hash(encoded);
    const k = key(digest);
    const existing = this.#entries.get(k);
    if (existing !== undefined) {
      return equal(existing.encoded, encoded)
        ? { kind: 'accepted', digest, record: new Uint8Array(encoded) }
        : { kind: 'collision', digest };
    }
    const missing = record.links.filter(link => !this.has(link));
    if (missing.length > 0) {
      return { kind: 'missing', digests: sortedUnique(missing) };
    }
    if (this.#entries.size + 1 >= RECORD_COUNT_LIMIT) {
      return { kind: 'tooLarge' };
    }
    this.#entries.set(k, { record, encoded, digest });
    for (const link of record.links) {
      this.#heads.delete(key(link));
    }
    this.#heads.add(k);
    return {
      kind: 'accepted',
      digest: new Uint8Array(digest),
      record: new Uint8Array(encoded),
    };
  }

  /**
   * The keys of the stored records reachable from `from` by following
   * links. A stored digest in `from` reaches itself.
   */
  reach(from: Iterable<Bytes>): Set<string> {
    const seen = new Set<string>();
    const todo = [...from];
    for (let digest = todo.pop(); digest !== undefined; digest = todo.pop()) {
      const k = key(digest);
      const entry = this.#entries.get(k);
      if (entry === undefined || seen.has(k)) {
        continue;
      }
      seen.add(k);
      todo.push(...entry.record.links);
    }
    return seen;
  }

  reachSet(from: Iterable<Bytes>): Array<Digest> {
    return this.digestsOf(this.reach(from));
  }

  digestsOf(keys: Iterable<string>): Array<Digest> {
    const digests = new Array<Digest>();
    for (const k of keys) {
      const entry = this.#entries.get(k);
      if (entry !== undefined) {
        digests.push(entry.digest);
      }
    }
    return sortedUnique(digests);
  }
}

/**
 * Accept every record whose links are present, until no more can be (Kahn's
 * algorithm: each record waits for its absent links; inserting a record
 * wakes the records waiting for it). Records go in only through
 * `store.accept`. Returns the records that were not accepted.
 */
function acceptAll(
  store: StubStore,
  records: ReadonlyArray<StubRecord>
): Array<StubRecord> {
  const waiting = new Map<string, Array<number>>();
  const absentCount = new Array<number>(records.length).fill(0);
  const accepted = new Array<boolean>(records.length).fill(false);
  const ready = new Array<number>();

  records.forEach((record, i) => {
    const absent = record.links.filter(link => !store.has(link));
    absentCount[i] = absent.length;
    for (const link of absent) {
      const k = key(link);
      const list = waiting.get(k) ?? [];
      list.push(i);
      waiting.set(k, list);
    }
    if (absent.length === 0) {
      ready.push(i);
    }
  });

  for (let i = ready.pop(); i !== undefined; i = ready.pop()) {
    const record = records[i];
    if (record === undefined) {
      continue;
    }
    const result = store.accept(record);
    if (result.kind !== 'accepted') {
      continue;
    }
    accepted[i] = true;
    const k = key(result.digest);
    for (const j of waiting.get(k) ?? []) {
      const left = (absentCount[j] ?? 0) - 1;
      absentCount[j] = left;
      if (left === 0) {
        ready.push(j);
      }
    }
    waiting.delete(k);
  }

  return records.filter((_record, i) => !accepted[i]);
}

// ---------------------------------------------------------------------------
// Blobs (PLAN.md section 3.4)
// ---------------------------------------------------------------------------

const BLOB_MAGIC = ascii('zrdtS2');
const BLOB_HEADER_BYTES = BLOB_MAGIC.length + GROUP_ID_BYTES + 4;

/** `"zrdtS2" ‖ group(32) ‖ u32 count ‖ (u32 len ‖ record)*`, sorted by digest. */
function encodeBlob(store: StubStore): Bytes {
  const entries = store.entries();
  const parts: Array<Bytes> = [BLOB_MAGIC, store.group, u32(entries.length)];
  for (const { encoded } of entries) {
    parts.push(u32(encoded.length), encoded);
  }
  return concat(parts);
}

type Decoded =
  | { kind: 'ok'; group: Bytes | undefined; records: Array<StubRecord> }
  | { kind: 'malformed' }
  | { kind: 'tooLarge' };

/**
 * Strict decode of a blob. A count of 2^24 or more is `tooLarge` before
 * anything else is read; nothing is allocated from the count. Records may
 * come in any order.
 */
export function decodeBlob(bytes: Bytes): Decoded {
  if (
    bytes.length < BLOB_HEADER_BYTES ||
    !equal(bytes.subarray(0, BLOB_MAGIC.length), BLOB_MAGIC)
  ) {
    return { kind: 'malformed' };
  }
  const group = bytes.slice(
    BLOB_MAGIC.length,
    BLOB_MAGIC.length + GROUP_ID_BYTES
  );
  const count = readU32(bytes, BLOB_MAGIC.length + GROUP_ID_BYTES);
  if (count >= RECORD_COUNT_LIMIT) {
    return { kind: 'tooLarge' };
  }
  const records = new Array<StubRecord>();
  let offset = BLOB_HEADER_BYTES;
  for (let i = 0; i < count; i += 1) {
    if (offset + 4 > bytes.length) {
      return { kind: 'malformed' };
    }
    const length = readU32(bytes, offset);
    offset += 4;
    if (offset + length > bytes.length) {
      return { kind: 'malformed' };
    }
    const record = decodeRecord(bytes.subarray(offset, offset + length));
    if (record === undefined) {
      return { kind: 'malformed' };
    }
    records.push(record);
    offset += length;
  }
  if (offset !== bytes.length) {
    return { kind: 'malformed' };
  }
  return { kind: 'ok', group, records };
}

function decodeList(list: ReadonlyArray<Bytes>): Decoded {
  if (list.length >= RECORD_COUNT_LIMIT) {
    return { kind: 'tooLarge' };
  }
  const records = new Array<StubRecord>();
  for (const bytes of list) {
    const record = decodeRecord(bytes);
    if (record === undefined) {
      return { kind: 'malformed' };
    }
    records.push(record);
  }
  return { kind: 'ok', group: undefined, records };
}

function isRecordList(input: OpenInput): input is ReadonlyArray<Bytes> {
  return Array.isArray(input);
}

type Opened =
  | { kind: 'ok'; store: StubStore; leftovers: Array<StubRecord> }
  | Refused;

/**
 * Decode `input` and accept what can be accepted into a new store for
 * `group`. The checks run in this order: malformed, tooLarge (count, then
 * links), wrongChat (the blob's group, then each record's), collision.
 */
function openInput(group: Bytes, input: OpenInput, hash: RecordHash): Opened {
  checkSize('group', group, GROUP_ID_BYTES);
  const decoded = isRecordList(input) ? decodeList(input) : decodeBlob(input);
  if (decoded.kind !== 'ok') {
    return decoded;
  }
  const { records } = decoded;
  if (records.some(record => record.links.length > MAX_LINKS)) {
    return { kind: 'tooLarge' };
  }
  if (decoded.group !== undefined && !equal(decoded.group, group)) {
    return { kind: 'wrongChat' };
  }
  if (records.some(record => !equal(record.group, group))) {
    return { kind: 'wrongChat' };
  }
  const collision = firstCollision(
    records.map(record => {
      const encoded = encodeRecord(record);
      return { digest: hash(encoded), encoded };
    })
  );
  if (collision !== undefined) {
    return { kind: 'collision', digest: collision };
  }
  const store = new StubStore(group, hash);
  const leftovers = acceptAll(store, records);
  return { kind: 'ok', store, leftovers };
}

/** The smallest digest shared by two different encodings, if any. */
function firstCollision(
  items: ReadonlyArray<{ digest: Bytes; encoded: Bytes }>
): Digest | undefined {
  const seen = new Map<string, Bytes>();
  const clashes = new Array<Bytes>();
  for (const { digest, encoded } of items) {
    const k = key(digest);
    const other = seen.get(k);
    if (other === undefined) {
      seen.set(k, encoded);
    } else if (!equal(other, encoded)) {
      clashes.push(digest);
    }
  }
  return sortedUnique(clashes)[0];
}

/** The digests of `leftovers`, and their links that no input record has. */
function report(
  store: StubStore,
  leftovers: ReadonlyArray<StubRecord>
): { left: Array<Digest>; missing: Array<Digest> } {
  const left = leftovers.map(record => hashRecord(record, store.hash));
  const known = new Set<string>(
    [...store.entries().map(({ digest }) => digest), ...left].map(key)
  );
  const missing = new Array<Bytes>();
  for (const record of leftovers) {
    for (const link of record.links) {
      if (!known.has(key(link))) {
        missing.push(link);
      }
    }
  }
  return { left: sortedUnique(left), missing: sortedUnique(missing) };
}

// ---------------------------------------------------------------------------
// Provenance (PLAN.md section 3.5)
// ---------------------------------------------------------------------------

/**
 * Whether one of `others` is concurrent with the stored record `digest`:
 * neither reaches the other. Call it only when no record of `others` reaches
 * `digest`; then it is enough that `digest` does not reach one of them.
 */
function hasConcurrent(
  store: StubStore,
  digest: Bytes,
  others: ReadonlyArray<{ k: string }>
): boolean {
  if (others.length === 0) {
    return false;
  }
  const reached = store.reach([digest]);
  return others.some(other => !reached.has(other.k));
}

/**
 * A status for every stored record, sorted by digest. Only live facts
 * count: a record is live if any fact for it says so, and its disown list
 * is the union of the disown lists of its live facts.
 */
function classifyStore(
  store: StubStore,
  facts: ReadonlyArray<ProvenanceFact>
): Array<RecordStatus> {
  const liveByKey = new Map<string, { entry: Entry; disowns: Set<string> }>();
  for (const fact of facts) {
    if (fact.provenance.kind !== 'live') {
      continue;
    }
    const entry = store.entry(fact.digest);
    if (entry === undefined) {
      continue;
    }
    const k = key(entry.digest);
    const item = liveByKey.get(k) ?? { entry, disowns: new Set<string>() };
    for (const digest of fact.disown) {
      item.disowns.add(key(digest));
    }
    liveByKey.set(k, item);
  }

  const live = [...liveByKey.entries()].map(([k, { entry, disowns }]) => ({
    k,
    author: entry.record.author,
    disowns,
    reaches: store.reach([entry.digest]),
  }));

  return store.entries().map(({ record, digest }) => {
    const k = key(digest);
    const own = live.filter(l => equal(l.author, record.author));
    const reachedByAuthor = own.some(l => l.reaches.has(k));
    const disowned = own.some(l => l.disowns.has(k));

    let status: Status;
    if (reachedByAuthor && !disowned) {
      status = { kind: 'confirmedByAuthor' };
    } else if (
      disowned ||
      (!reachedByAuthor && hasConcurrent(store, digest, own))
    ) {
      status = { kind: 'notConfirmedByAuthor' };
    } else {
      const holders = live
        .filter(l => !equal(l.author, record.author) && l.reaches.has(k))
        .map(l => l.author)
        .sort(compareBytes);
      const holder = holders[0];
      status =
        holder === undefined
          ? { kind: 'unconfirmed' }
          : { kind: 'heldBy', aci: new Uint8Array(holder) };
    }
    return { digest: new Uint8Array(digest), status };
  });
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

export type StubBackendOptions = Readonly<{
  /** Where to read ZRDT_REQUIRE_LEAN; defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Tests only: replaces SHA-256 for record digests (not for commit()). */
  recordHashForTesting?: RecordHash;
}>;

/**
 * The stub backend: a table of stores in memory. `ZRDT_REQUIRE_LEAN=1`
 * refuses it.
 */
export class StubBackend implements ZrdtBackend {
  readonly kind: BackendKind = 'stub';
  readonly #stores = new Map<ChatKey, StubStore>();
  readonly #hash: RecordHash;

  constructor({
    env = process.env,
    recordHashForTesting = sha256,
  }: StubBackendOptions = {}) {
    this.#hash = recordHashForTesting;
    if (env.ZRDT_REQUIRE_LEAN === '1') {
      throw new ZrdtBackendError(
        'unavailable',
        'ZRDT_REQUIRE_LEAN=1 refuses the TypeScript stub'
      );
    }
  }

  isAvailable(): boolean {
    return true;
  }

  onUnavailable(): () => void {
    // The stub never fails.
    return () => undefined;
  }

  #store(chat: ChatKey): StubStore {
    const store = this.#stores.get(chat);
    if (store === undefined) {
      throw new ZrdtBackendError('unknownChat', `no store for ${chat}`);
    }
    return store;
  }

  async version(): Promise<VersionInfo> {
    return { protocol: PROTOCOL_VERSION, build: 'stub' };
  }

  #notOpen(chat: ChatKey): void {
    if (this.#stores.has(chat)) {
      throw new ZrdtBackendError('chatOpen', `a store is open for ${chat}`);
    }
  }

  async create(chat: ChatKey, group: Bytes): Promise<void> {
    this.#notOpen(chat);
    this.#stores.set(chat, new StubStore(group, this.#hash));
  }

  async open(
    chat: ChatKey,
    group: Bytes,
    input: OpenInput
  ): Promise<OpenResult> {
    this.#notOpen(chat);
    const opened = openInput(group, input, this.#hash);
    if (opened.kind !== 'ok') {
      return opened;
    }
    if (opened.leftovers.length > 0) {
      const { left, missing } = report(opened.store, opened.leftovers);
      return { kind: 'unverifiable', unverifiable: left, missing };
    }
    this.#stores.set(chat, opened.store);
    return { kind: 'ok' };
  }

  async salvage(
    chat: ChatKey,
    group: Bytes,
    input: OpenInput
  ): Promise<SalvageResult> {
    this.#notOpen(chat);
    const opened = openInput(group, input, this.#hash);
    if (opened.kind !== 'ok') {
      return opened;
    }
    const { left, missing } = report(opened.store, opened.leftovers);
    this.#stores.set(chat, opened.store);
    return { kind: 'ok', dropped: left, missing };
  }

  async commit(
    group: Bytes,
    author: Bytes,
    nonce: Bytes,
    dataMessage: Bytes
  ): Promise<CommitResult> {
    return commitWithOpening(group, author, nonce, dataMessage);
  }

  async hash(record: RecordParts): Promise<Digest> {
    return hashRecord(makeRecord(record), this.#hash);
  }

  async accept(chat: ChatKey, record: RecordParts): Promise<AcceptResult> {
    return this.#store(chat).accept(makeRecord(record));
  }

  /**
   * ACCEPT_RECORD. The checks run in this order: the chat is open, the bytes
   * decode, the opening matches the commitment, then ACCEPT's checks.
   */
  async acceptRecord(
    chat: ChatKey,
    record: Bytes,
    opening?: Bytes
  ): Promise<AcceptRecordResult> {
    const store = this.#store(chat);
    const decoded = decodeRecord(record);
    if (decoded === undefined) {
      return { kind: 'malformed' };
    }
    if (opening !== undefined && !opens(decoded, opening)) {
      return { kind: 'badOpening' };
    }
    return store.accept(decoded);
  }

  async heads(chat: ChatKey): Promise<Array<Digest>> {
    return this.#store(chat).heads();
  }

  async has(chat: ChatKey, digest: Digest): Promise<boolean> {
    return this.#store(chat).has(digest);
  }

  async get(chat: ChatKey, digest: Digest): Promise<RecordParts | undefined> {
    const entry = this.#store(chat).entry(digest);
    return entry === undefined ? undefined : toParts(entry.record);
  }

  async reachSet(
    chat: ChatKey,
    from: ReadonlyArray<Digest>
  ): Promise<Array<Digest>> {
    return this.#store(chat).reachSet(from);
  }

  async merge(chat: ChatKey, blob: Bytes): Promise<OpenResult> {
    const store = this.#store(chat);
    const opened = openInput(store.group, blob, this.#hash);
    if (opened.kind !== 'ok') {
      return opened;
    }
    if (opened.leftovers.length > 0) {
      const { left, missing } = report(opened.store, opened.leftovers);
      return { kind: 'unverifiable', unverifiable: left, missing };
    }
    const incoming = opened.store.entries();
    const collision = firstCollision([...store.entries(), ...incoming]);
    if (collision !== undefined) {
      return { kind: 'collision', digest: collision };
    }
    const next = store.clone();
    const leftovers = acceptAll(
      next,
      incoming.map(({ record }) => record)
    );
    if (leftovers.length > 0) {
      // Both stores are closed and do not collide, so only the record
      // count limit can stop an accept here.
      return { kind: 'tooLarge' };
    }
    this.#stores.set(chat, next);
    return { kind: 'ok' };
  }

  async classify(
    chat: ChatKey,
    facts: ReadonlyArray<ProvenanceFact>
  ): Promise<Array<RecordStatus>> {
    return classifyStore(this.#store(chat), facts);
  }

  async encode(chat: ChatKey): Promise<Bytes> {
    return encodeBlob(this.#store(chat));
  }

  async close(chat: ChatKey): Promise<void> {
    this.#stores.delete(chat);
  }
}
