// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// The zrdt backend: one async interface with one method per zrdtd frame op
// (zrdt docs/PLAN.md section 3.3). Two backends implement it: the Lean
// daemon (backends/daemon.node.ts) and the TypeScript stub
// (backends/stub.node.ts). Swapping one for the other must not change any
// other code.
//
// The host never hashes, never computes heads and never decides whether a
// record is accepted. It passes bytes in and shows what comes back.

/** Raw bytes. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** A SHA-256 digest of an encoded record: 32 bytes. */
export type Digest = Uint8Array<ArrayBuffer>;

/** The host's conversation id. The daemon keeps one store per chat key. */
export type ChatKey = string;

/** Sizes, in bytes, of the fixed-size fields. */
export const DIGEST_BYTES = 32;
export const GROUP_ID_BYTES = 32;
export const COMMIT_BYTES = 32;
export const NONCE_BYTES = 32;
export const ACI_BYTES = 16;

/** A record links at most this many digests (PLAN.md section 3.4). */
export const MAX_LINKS = 4096;

/** A store holds fewer than this many records (PLAN.md section 3.4). */
export const RECORD_COUNT_LIMIT = 2 ** 24;

/**
 * The frame protocol version this host speaks: 2 (zrdt build/t5-core: the
 * ACCEPT reply carries the record bytes, the COMMIT reply the opening, and
 * ACCEPT_RECORD exists). The daemon backend also reads protocol 1 replies
 * (zrdt e2b3160), by body length, and falls back for ACCEPT_RECORD.
 */
export const PROTOCOL_VERSION = 2;

/**
 * The parts of a record. `group` is the group's 32-byte id, `commit` the
 * 32-byte commitment from `commit()`, `links` the sender's heads at send time,
 * and `author` the sender's 16-byte ACI.
 *
 * On input, `links` may be in any order and may repeat: the backend sorts
 * them and drops duplicates, so link order never changes the hash. On output
 * (`get()`), `links` is strictly sorted.
 */
export type RecordParts = Readonly<{
  group: Bytes;
  commit: Bytes;
  links: ReadonlyArray<Digest>;
  author: Bytes;
}>;

/** What `open()` and `salvage()` read: a store blob, or a list of encoded records. */
export type OpenInput = Bytes | ReadonlyArray<Bytes>;

/** Why a whole input was refused. The store is unchanged. */
export type Refused =
  | { kind: 'malformed' }
  | { kind: 'tooLarge' }
  | { kind: 'wrongChat' }
  | { kind: 'collision'; digest: Digest };

/**
 * The reply to `open()` and `merge()`.
 *
 * - `ok`: every record was accepted.
 * - `unverifiable`: nothing changed. `unverifiable` lists every record that
 *   could never be accepted (a link to nothing, or a cycle), and `missing`
 *   the link digests that point to no record of the input. Both are sorted.
 */
export type OpenResult =
  | { kind: 'ok' }
  | Refused
  | {
      kind: 'unverifiable';
      unverifiable: Array<Digest>;
      missing: Array<Digest>;
    };

/**
 * The reply to `salvage()`. On `ok` the store holds every record that some
 * order of accepts could take in; `dropped` lists the rest and `missing` the
 * link digests that point to no record of the input. Both are sorted.
 */
export type SalvageResult =
  | { kind: 'ok'; dropped: Array<Digest>; missing: Array<Digest> }
  | Refused;

/**
 * The reply to `accept()`.
 *
 * - `accepted`: the record is in the store (inserted now, or already there).
 *   `digest` is its hash.
 * - `missing`: store unchanged; exactly the links not in the store, sorted.
 * - `collision`: store unchanged; a different record with this digest is
 *   already stored.
 * - `wrongChat`: store unchanged; the record's group is not the store's.
 * - `tooLarge`: store unchanged; more than MAX_LINKS links, or the store is
 *   full.
 */
export type AcceptResult =
  | { kind: 'accepted'; digest: Digest; record: Bytes }
  | { kind: 'missing'; digests: Array<Digest> }
  | { kind: 'collision'; digest: Digest }
  | { kind: 'wrongChat' }
  | { kind: 'tooLarge' };

/**
 * The reply to `acceptRecord()`: as `accept()`, plus
 *
 * - `malformed`: the bytes are not an encoded record (PLAN.md section 3.4);
 * - `badOpening`: an opening was given and its commitment is not the
 *   record's `commit`. Nothing changed.
 */
export type AcceptRecordResult =
  | AcceptResult
  | { kind: 'malformed' }
  | { kind: 'badOpening' };

/**
 * The reply to `commit()`. `opening` is `nonce ‖ DataMessage bytes with
 * top-level fields 15 and 200 removed`: exactly the committed bytes after the
 * fixed prefix, so `commit = SHA-256("zrdtP1" ‖ group ‖ author ‖ opening)`.
 * `malformed`: the DataMessage is not a well-formed protobuf message.
 */
export type CommitResult =
  | { kind: 'ok'; commit: Bytes; opening: Bytes }
  | { kind: 'malformed' };

/**
 * How a record reached this device (host state, trusted).
 *
 * - `live`: the Signal envelope sender is the record's author, or this
 *   device sent it.
 * - `relayed`: another member, `by` (16-byte ACI), resent it.
 * - `imported`: it came from a dump, or was kept by salvage.
 */
export type Provenance =
  | { kind: 'live' }
  | { kind: 'relayed'; by: Bytes }
  | { kind: 'imported' };

/**
 * What the host knows about one record, for `classify()`. `disown` is the
 * `ZrdtMeta.disown` list the record arrived with. Only the disown lists of
 * live records count.
 */
export type ProvenanceFact = Readonly<{
  digest: Digest;
  provenance: Provenance;
  disown: ReadonlyArray<Digest>;
}>;

/**
 * Who vouches for a record (PLAN.md section 3.5). When several apply, the
 * first in this order wins.
 *
 * - `confirmedByAuthor`: a live record of the author reaches it, and no live
 *   record of the author disowns it.
 * - `notConfirmedByAuthor`: a live record of the author disowns it; or the
 *   author has a live record that neither reaches it nor is reached by it,
 *   and no live record of the author reaches it.
 * - `heldBy`: a live record of another member, `aci`, reaches it.
 * - `unconfirmed`: no live record reaches it.
 */
export type Status =
  | { kind: 'confirmedByAuthor' }
  | { kind: 'notConfirmedByAuthor' }
  | { kind: 'heldBy'; aci: Bytes }
  | { kind: 'unconfirmed' };

/** One line of `classify()`'s reply. */
export type RecordStatus = { digest: Digest; status: Status };

/** The reply to `version()`. */
export type VersionInfo = { protocol: number; build: string };

/** Which implementation a backend is. Shown on screen. */
export type BackendKind = 'lean' | 'stub';

/**
 * Errors that are not a reply of the protocol.
 *
 * - `unavailable`: the backend is gone (the daemon exited). Nothing is
 *   accepted until the host restarts it and re-opens every chat.
 * - `unknownChat`: no store is open under this chat key (NO_CHAT).
 * - `chatOpen`: NEW, OPEN or SALVAGE under a chat key that already has a
 *   store (CHAT_OPEN). CLOSE it first.
 * - `badInput`: an argument has the wrong size (the daemon would reply
 *   BAD_REQUEST).
 * - `protocol`: the daemon sent something the host cannot read.
 */
export type ZrdtErrorCode =
  | 'unavailable'
  | 'unknownChat'
  | 'chatOpen'
  | 'badInput'
  | 'protocol';

export class ZrdtBackendError extends Error {
  readonly code: ZrdtErrorCode;

  constructor(code: ZrdtErrorCode, message: string) {
    super(`zrdt ${code}: ${message}`);
    this.name = 'ZrdtBackendError';
    this.code = code;
  }
}

/** The zrdt backend. Each method is one frame op of PLAN.md section 3.3. */
export type ZrdtBackend = {
  readonly kind: BackendKind;

  /** False once the backend has failed. It never becomes true again. */
  isAvailable(): boolean;

  /**
   * Calls `listener` once, when the backend fails. Returns a function that
   * removes the listener.
   */
  onUnavailable(listener: (error: ZrdtBackendError) => void): () => void;

  /** VERSION: the protocol version and the build of the backend. */
  version(): Promise<VersionInfo>;

  /** NEW: an empty store for `group` under `chat`. Throws `chatOpen` if one is there. */
  create(chat: ChatKey, group: Bytes): Promise<void>;

  /**
   * OPEN: load a store for `group` from a blob or a list of encoded records.
   * On `ok` the store is under `chat`; otherwise nothing changes. Throws
   * `chatOpen` if `chat` already has a store.
   */
  open(chat: ChatKey, group: Bytes, input: OpenInput): Promise<OpenResult>;

  /**
   * SALVAGE: like `open()`, but on `ok` it loads the part that verifies and
   * names the rest.
   */
  salvage(
    chat: ChatKey,
    group: Bytes,
    input: OpenInput
  ): Promise<SalvageResult>;

  /**
   * COMMIT: the 32-byte commitment over the DataMessage wire bytes, with
   * top-level fields 15 (groupV2) and 200 (zrdt) removed, and the opening.
   * Needs no store.
   */
  commit(
    group: Bytes,
    author: Bytes,
    nonce: Bytes,
    dataMessage: Bytes
  ): Promise<CommitResult>;

  /** HASH: the digest of a record. Needs no store. */
  hash(record: RecordParts): Promise<Digest>;

  /** ACCEPT: add a record to the store under `chat`. */
  accept(chat: ChatKey, record: RecordParts): Promise<AcceptResult>;

  /**
   * ACCEPT_RECORD: add an encoded record (a relay or an import) to the store
   * under `chat`. If `opening` is given, its commitment must be the record's.
   */
  acceptRecord(
    chat: ChatKey,
    record: Bytes,
    opening?: Bytes
  ): Promise<AcceptRecordResult>;

  /** HEADS: the digests no stored record links, sorted. */
  heads(chat: ChatKey): Promise<Array<Digest>>;

  /** HAS: whether a record with this digest is stored. */
  has(chat: ChatKey, digest: Digest): Promise<boolean>;

  /** GET: the stored record with this digest, if any. */
  get(chat: ChatKey, digest: Digest): Promise<RecordParts | undefined>;

  /**
   * REACH_SET: the digests of the stored records reachable from `from` by
   * following links, sorted. A stored record in `from` is in the result.
   */
  reachSet(chat: ChatKey, from: ReadonlyArray<Digest>): Promise<Array<Digest>>;

  /**
   * MERGE: open `blob` with the checks of `open()`, for this store's group,
   * then add its records to the store. On any reply but `ok` the store is
   * unchanged.
   */
  merge(chat: ChatKey, blob: Bytes): Promise<OpenResult>;

  /**
   * CLASSIFY: a status for every stored record, sorted by digest. Records
   * with no fact count as not live.
   */
  classify(
    chat: ChatKey,
    facts: ReadonlyArray<ProvenanceFact>
  ): Promise<Array<RecordStatus>>;

  /** ENCODE: the store blob. */
  encode(chat: ChatKey): Promise<Bytes>;

  /** CLOSE: drop the store under `chat`, if any. */
  close(chat: ChatKey): Promise<void>;
};
