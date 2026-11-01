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
/** A serialized identity public key (libsignal `PublicKey.serialize()`). */
export const IDENTITY_KEY_BYTES = 33;
/** A key tag: 16 bytes of SHA-256("zrdtK1" ‖ identity key) (JOIN_PLAN §3.2). */
export const KEY_TAG_BYTES = 16;
/** A SERVE request id: 16 random bytes (JOIN_PLAN §10.1). */
export const REQUEST_ID_BYTES = 16;
/** An audience entry: aci(16) ‖ key tag(16). */
export const AUDIENCE_ENTRY_BYTES = ACI_BYTES + KEY_TAG_BYTES;
/** The audience cap (JOIN_PLAN §3.2, kejace's decision): 256 members. */
export const MAX_AUDIENCE = 256;
/** A SERVE reply header: requester aci ‖ key tag ‖ request id. */
export const SERVE_HEADER_BYTES = ACI_BYTES + KEY_TAG_BYTES + REQUEST_ID_BYTES;

/** A record links at most this many digests (PLAN.md section 3.4). */
export const MAX_LINKS = 4096;

/** A store holds fewer than this many records (PLAN.md section 3.4). */
export const RECORD_COUNT_LIMIT = 2 ** 24;

/**
 * The frame protocol version this host speaks: 3 (zrdt docs/JOIN_PLAN.md
 * section 10.2: ACCEPT takes an optional opening and records its audience,
 * and AUDIENCE, SERVE and ADDRESSED exist). Every record message carries its
 * author's audience (DataMessage field 201); an opening without one is
 * refused (NO_AUDIENCE).
 */
export const PROTOCOL_VERSION = 3;

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
 * The reply to `accept()` with an opening, and to `acceptRecord()`: as
 * `AcceptResult`, plus
 *
 * - `malformed` (`acceptRecord()` only): the bytes are not an encoded record
 *   (PLAN.md section 3.4);
 * - `badOpening`: an opening was given and its commitment is not the
 *   record's `commit`. Nothing changed.
 * - `noAudience`: an opening was given, it matches, but its committed bytes
 *   do not hold exactly one well-formed field 201 (JOIN_PLAN §3.2). Nothing
 *   changed.
 */
export type AcceptRecordResult =
  | AcceptResult
  | { kind: 'malformed' }
  | { kind: 'badOpening' }
  | { kind: 'noAudience' };

/**
 * One member for AUDIENCE: its 16-byte ACI and the identity key the author
 * holds for it (33 bytes), or none: the zero tag (a member Signal does not
 * send this message to, or one the author has no key for).
 */
export type AudienceMember = Readonly<{ aci: Bytes; key?: Bytes }>;

/**
 * The reply to `audience()`: the field-201 bytes; `tooLarge`, more than 256
 * members; `malformed`, no members or an ACI given twice.
 */
export type AudienceResult =
  | { kind: 'ok'; audience: Bytes }
  | { kind: 'tooLarge' }
  | { kind: 'malformed' };

/** SERVE's mode: the whole view, or a repair of the wanted digests. */
export type ServeMode = 'catchup' | 'perDigest';

/** An opening the host holds for a stored record, for SERVE. */
export type ServeHeld = Readonly<{ digest: Digest; opening: Bytes }>;

/**
 * A SERVE request (JOIN_PLAN §5, §10.2). `requesterAci` is the
 * Signal-authenticated sender of the request and `key` the identity key this
 * device holds for it now; the reply is sealed to exactly that key.
 * `live` and `disown` are this device's host state (A8); `held` the openings
 * it holds.
 */
export type ServeRequest = Readonly<{
  chat: ChatKey;
  ownAci: Bytes;
  requesterAci: Bytes;
  key: Bytes;
  requestId: Bytes;
  since: ReadonlyArray<Digest>;
  /** This device's own `since` for the requester's account (JOIN_PLAN §6.5). */
  ownSince: ReadonlyArray<Digest>;
  mode: ServeMode;
  wanted: ReadonlyArray<Digest>;
  forExport: boolean;
  strict: boolean;
  live: ReadonlyArray<Digest>;
  disown: ReadonlyArray<Digest>;
  held: ReadonlyArray<ServeHeld>;
}>;

/**
 * One entry of a SERVE reply.
 *
 * - `addressed`: a record the requester is seated in, with its opening only
 *   if the opening's own committed audience seats the requester under the
 *   checked key; `authorCopy` only for the responder's own live, undisowned
 *   record.
 * - `after`: structure only (author and links).
 * - `boundary`: the digest only.
 */
export type ServeEntry =
  | { kind: 'addressed'; record: Bytes; opening?: Bytes; authorCopy: boolean }
  | { kind: 'after'; record: Bytes }
  | { kind: 'boundary'; digest: Digest };

/**
 * What ACCEPT_VIEW did with one entry (JOIN_PLAN §4.4, §6.2), in entry
 * order.
 *
 * - `ok`: a record entry whose record is now stored (its digest), or a
 *   boundary entry whose digest is now a boundary digest or a stored record;
 * - `missing`, `collision`, `wrongChat`, `tooLarge`: what ACCEPT would reply
 *   for the record now (`tooLarge` for a boundary entry: the boundary is
 *   full);
 * - `malformed`, `badOpening`, `noAudience`, `ephemeral`: the entry was
 *   refused before the store was touched (`ephemeral`: an import of a
 *   disappearing or view-once opening);
 * - `ignored`: a boundary entry on a closed store, which never takes one.
 */
export type ViewResult =
  | { kind: 'ok'; digest: Digest }
  | { kind: 'missing'; digests: Array<Digest> }
  | { kind: 'collision'; digest: Digest }
  | { kind: 'wrongChat' }
  | { kind: 'tooLarge' }
  | { kind: 'malformed' }
  | { kind: 'badOpening' }
  | { kind: 'noAudience' }
  | { kind: 'ephemeral' }
  | { kind: 'ignored' };

/** SERVE's reply header: who it is for, under which key, for which request. */
export type ServeHeader = Readonly<{
  requesterAci: Bytes;
  keyTag: Bytes;
  requestId: Bytes;
}>;

/**
 * The reply to `serve()`. `headerBytes` and `entriesBytes` are the exact
 * bytes zrdtd sent (`entriesBytes` = u32 count ‖ entries): the host seals
 * `entriesBytes` and binds `headerBytes` as associated data.
 */
export type ServeReply = Readonly<{
  header: ServeHeader;
  headerBytes: Bytes;
  entries: ReadonlyArray<ServeEntry>;
  entriesBytes: Bytes;
}>;

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
   * NEW_RELATIVE: an empty relative store for `group` under `chat`, for a
   * catch-up or a re-add (JOIN_PLAN §6.1, §6.5). A relative store takes
   * boundary digests; a closed one never does. Throws `chatOpen` if a store
   * is there.
   */
  createRelative(chat: ChatKey, group: Bytes): Promise<void>;

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

  /**
   * ACCEPT: add a record to the store under `chat`. With an opening, the
   * opening must match the record (`badOpening`) and hold an audience
   * (`noAudience`); the backend then records that audience.
   */
  accept(
    chat: ChatKey,
    record: RecordParts,
    opening?: Bytes
  ): Promise<AcceptRecordResult>;

  /**
   * ACCEPT_RECORD: add an encoded record (a relay or an import) to the store
   * under `chat`. If `opening` is given, its commitment must be the record's
   * and it must hold an audience, which the backend records.
   */
  acceptRecord(
    chat: ChatKey,
    record: Bytes,
    opening?: Bytes
  ): Promise<AcceptRecordResult>;

  /**
   * ACCEPT_VIEW: take a SERVE reply's entries (JOIN_PLAN §4.4), from
   * `voucher` (the responder). Only replies that passed the §4.4 checks may
   * be passed. A relative store takes the boundary entries; a closed one
   * ignores them. The records are accepted as one batch, and each checked
   * opening's audience is recorded. One result per entry, in order.
   */
  acceptView(
    chat: ChatKey,
    voucher: Bytes,
    forImport: boolean,
    entries: ReadonlyArray<ServeEntry>
  ): Promise<Array<ViewResult>>;

  /**
   * LINKABLE: the digests a new record of this device may link (COMMIT's
   * links, JOIN_PLAN §6.2). A closed store: its heads. A relative store: the
   * heads that are stored records in `live` (the digests this device holds
   * live, its own included, or as an author copy).
   */
  linkable(chat: ChatKey, live: ReadonlyArray<Digest>): Promise<Array<Digest>>;

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

  /**
   * AUDIENCE: the field-201 bytes for these members (sorted by ACI; the
   * zero tag for a member without a key). Needs no store. The host never
   * hashes a key itself (A4).
   */
  audience(members: ReadonlyArray<AudienceMember>): Promise<AudienceResult>;

  /** SERVE: the reply to one request (JOIN_PLAN §5). */
  serve(request: ServeRequest): Promise<ServeReply>;

  /**
   * ADDRESSED: the stored digests whose recorded audience seats `aci` under
   * `key`, sorted. Tells the host which openings to load for SERVE.
   */
  addressed(chat: ChatKey, aci: Bytes, key: Bytes): Promise<Array<Digest>>;
};
