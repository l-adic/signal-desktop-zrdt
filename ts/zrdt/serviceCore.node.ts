// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable max-classes-per-file

// The zrdt service: the contract of ./service.preload.ts on top of one
// backend (Lean daemon or stub) and the zrdt SQL tables. Everything it needs
// from Signal is injected (storage, group ids, our ACI), so tests run it with
// the stub and an in-memory storage.
//
// Rules (zrdt docs/APP.md sections 4 to 6, PLAN.md section 3.5):
// - the host never decides acceptance: every record goes through the backend;
// - a record row is written only after the backend replied ACCEPTED;
// - fail closed: once the backend is unavailable, every call rejects and
//   backendInfo().available is false (APP.md section 3.3 "zrdt unavailable");
// - at start, every conversation with zrdt rows is re-OPENed from its rows;
//   a conversation whose rows do not OPEN is "rejected": nothing is accepted
//   or merged into it until the user salvages or imports (APP.md section 6).

import { EventEmitter } from 'node:events';

import { createLogger } from '../logging/log.std.ts';
import { drop } from '../util/drop.std.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import type {
  UpsertZrdtProvenanceOptionsType,
  ZrdtBoundaryRowType,
  ZrdtPendingRowType,
  ZrdtProvenanceRowType,
  ZrdtRecordRowType,
  ZrdtStoreModeType,
} from '../types/Zrdt.std.ts';
import { PROTOCOL_VERSION, ZrdtBackendError } from './ZrdtBackend.std.ts';
import type {
  AcceptRecordResult,
  AudienceMember,
  OpenResult,
  ProvenanceFact,
  RecordParts,
  SalvageResult,
  ServeEntry,
  ServeMode,
  ServeReply,
  ServeRequest,
  Status,
  ViewResult,
  ZrdtBackend,
} from './ZrdtBackend.std.ts';
import {
  decodeRecord,
  encodeRecord,
  makeRecord,
} from './backends/stub.node.ts';
import { readBlob3Header } from './blob.std.ts';

const log = createLogger('zrdt/service');

// ---------------------------------------------------------------------------
// The contract types (shared by every lane; do not change their shape)
// ---------------------------------------------------------------------------

// Inputs are `Uint8Array<ArrayBuffer>`; outputs are `Uint8Array<ArrayBuffer>` (a subtype),
// so callers typed either way compile.
type Bytes = Uint8Array<ArrayBuffer>;

export type ZrdtStatus =
  | { kind: 'confirmedByAuthor' }
  | { kind: 'heldBy'; aci: string }
  | { kind: 'unconfirmed' }
  | { kind: 'notConfirmedByAuthor' };

export type ZrdtProvenance =
  | { kind: 'live' }
  | { kind: 'relayed'; byAci: string }
  | { kind: 'imported' };

export type ZrdtAcceptOutcome =
  | {
      status: 'accepted';
      digest: Bytes;
      record: Bytes;
      opening?: Bytes;
    }
  | {
      status: 'missing';
      digests: Array<Bytes>;
      // Extras (not in the shared contract; optional): the record that is
      // now in zrdt_pending, its digest, and the opening if one was computed.
      digest?: Bytes;
      record?: Bytes;
      opening?: Bytes;
    }
  | { status: 'collision'; digest: Bytes }
  | { status: 'wrongChat' }
  | { status: 'tooLarge' }
  | { status: 'malformed' }
  | { status: 'badOpening' }
  // The opening holds no audience (DataMessage field 201): refused.
  | { status: 'noAudience' };

export type ZrdtOpenOutcome =
  | { status: 'ok' }
  | {
      status: 'unverifiable';
      unverifiable: Array<Bytes>;
      missing: Array<Bytes>;
    }
  | { status: 'malformed' | 'tooLarge' | 'wrongChat' }
  | { status: 'collision'; digest: Bytes };

export type ZrdtBackendInfo = {
  kind: 'lean' | 'stub';
  version: string;
  available: boolean;
};

export type ZrdtAcceptOwnArgs = {
  groupId: Uint8Array<ArrayBuffer>;
  authorAci: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  dataMessageBytes: Uint8Array<ArrayBuffer>;
  links: Array<Uint8Array<ArrayBuffer>>;
};

export type ZrdtAcceptIncomingArgs = ZrdtAcceptOwnArgs & {
  provenance: ZrdtProvenance;
};

export type ZrdtAcceptRecordArgs = {
  record: Uint8Array<ArrayBuffer>;
  opening?: Uint8Array<ArrayBuffer>;
  provenance: ZrdtProvenance;
};

export type ZrdtGetResult = {
  record: Bytes;
  authorAci: Bytes;
  links: Array<Bytes>;
  commit: Bytes;
};

/**
 * One SERVE entry to take with ACCEPT_VIEW, and the provenance its record
 * gets if it is stored (host state, A8: `live` only for an author copy from
 * the record's own author).
 */
export type ZrdtViewItem = Readonly<{
  entry: ServeEntry;
  provenance: ZrdtProvenance;
}>;

/** What ACCEPT_VIEW did with one item, in item order. */
export type ZrdtViewOutcome = Readonly<{
  result: ViewResult;
  // The record entry's record was stored by this call (not held before).
  isNew: boolean;
}>;

export type ZrdtSalvageOutcome =
  | { dropped: Array<Bytes>; missing: Array<Bytes> }
  | ZrdtOpenOutcome;

export type ZrdtServiceType = {
  init(): Promise<void>;
  backendInfo(): ZrdtBackendInfo;
  ensureConversation(
    conversationId: string,
    groupId: Uint8Array<ArrayBuffer>
  ): Promise<void>;
  heads(conversationId: string): Promise<Array<Bytes>>;
  disownSet(conversationId: string): Promise<Array<Bytes>>;
  acceptOwn(
    conversationId: string,
    a: ZrdtAcceptOwnArgs
  ): Promise<{ digest: Bytes; record: Bytes; opening: Bytes }>;
  acceptIncoming(
    conversationId: string,
    a: ZrdtAcceptIncomingArgs
  ): Promise<ZrdtAcceptOutcome>;
  acceptRecord(
    conversationId: string,
    a: ZrdtAcceptRecordArgs
  ): Promise<ZrdtAcceptOutcome>;
  has(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>
  ): Promise<boolean>;
  get(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtGetResult | undefined>;
  reachSet(
    conversationId: string,
    from: Array<Uint8Array<ArrayBuffer>>
  ): Promise<Array<Bytes>>;
  classify(conversationId: string): Promise<Map<string, ZrdtStatus>>;
  markDisowned(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>,
    byAci: string
  ): Promise<void>;
  exportBlob(conversationId: string): Promise<Bytes>;
  importBlob(
    conversationId: string,
    blob: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtOpenOutcome>;
  salvageBlob(
    conversationId: string,
    blob: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtSalvageOutcome>;
  audience(members: ReadonlyArray<AudienceMember>): Promise<Bytes | 'tooLarge'>;
  serve(
    conversationId: string,
    request: Omit<ServeRequest, 'chat'>
  ): Promise<ServeReply>;
  addressed(
    conversationId: string,
    aci: Uint8Array<ArrayBuffer>,
    key: Uint8Array<ArrayBuffer>
  ): Promise<Array<Bytes>>;
  hasStore(conversationId: string): Promise<boolean>;
  isRelative(conversationId: string): Promise<boolean>;
  startRelative(
    conversationId: string,
    groupId: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtStoreModeType>;
  closeRelative(conversationId: string): Promise<ZrdtStoreModeType>;
  acceptView(
    conversationId: string,
    a: Readonly<{
      voucherAci: string;
      forImport: boolean;
      mode: ServeMode;
      items: ReadonlyArray<ZrdtViewItem>;
    }>
  ): Promise<Array<ZrdtViewOutcome>>;
  linkable(conversationId: string): Promise<Array<Bytes>>;
  boundary(conversationId: string): Promise<Array<ZrdtBoundaryRowType>>;
  archive(conversationId: string): Promise<string>;
};

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The zrdt SQL functions the service uses (DataReader and DataWriter). */
export type ZrdtServiceStorage = Readonly<{
  getZrdtConversationIds(): Promise<Array<string>>;
  getZrdtRecords(conversationId: string): Promise<Array<ZrdtRecordRowType>>;
  insertZrdtRecords(rows: ReadonlyArray<ZrdtRecordRowType>): Promise<number>;
  deleteZrdtRecords(
    conversationId: string,
    digests: ReadonlyArray<Uint8Array<ArrayBuffer>>
  ): Promise<number>;
  getZrdtPending(conversationId: string): Promise<Array<ZrdtPendingRowType>>;
  insertZrdtPending(row: ZrdtPendingRowType): Promise<void>;
  deleteZrdtPending(
    conversationId: string,
    digests: ReadonlyArray<Uint8Array<ArrayBuffer>>
  ): Promise<number>;
  getZrdtProvenance(
    conversationId: string
  ): Promise<Array<ZrdtProvenanceRowType>>;
  upsertZrdtProvenance(
    rows: ReadonlyArray<ZrdtProvenanceRowType>,
    options?: UpsertZrdtProvenanceOptionsType
  ): Promise<void>;
  markZrdtDisowned(
    conversationId: string,
    digests: ReadonlyArray<Uint8Array<ArrayBuffer>>,
    disownedBy: string
  ): Promise<number>;
  getZrdtStoreMode(conversationId: string): Promise<ZrdtStoreModeType>;
  setZrdtStoreMode(
    conversationId: string,
    mode: ZrdtStoreModeType
  ): Promise<void>;
  getZrdtBoundary(conversationId: string): Promise<Array<ZrdtBoundaryRowType>>;
  insertZrdtBoundary(rows: ReadonlyArray<ZrdtBoundaryRowType>): Promise<number>;
  archiveZrdtConversation(
    conversationId: string,
    archiveId: string
  ): Promise<void>;
}>;

export type ZrdtServiceDeps = Readonly<{
  /** Makes the backend; throws if none may be used (ZRDT_REQUIRE_LEAN=1). */
  createBackend: () => ZrdtBackend;
  /** The kind to report if createBackend throws. */
  intendedKind: () => 'lean' | 'stub';
  storage: ZrdtServiceStorage;
  /** The group's 32-byte id, if the conversation is a known group. */
  groupIdOf: (conversationId: string) => Uint8Array<ArrayBuffer> | undefined;
  /** Our ACI (uuid string), if registered. */
  ourAci: () => string | undefined;
  /**
   * The openings the host holds for a conversation's records (all stored
   * ones, or the given digests: pending records too). zrdtd keeps the
   * audiences it recorded only while a store is open (Proto.lean, "The
   * table of open stores"), so after OPEN they are re-sent with
   * ACCEPT_RECORD (JOIN_PLAN §4.2); a pending record is accepted with its
   * opening, so its audience is recorded too.
   */
  heldOpenings?: (
    conversationId: string,
    digests?: ReadonlyArray<Uint8Array<ArrayBuffer>>
  ) => Promise<
    Array<{ digest: Uint8Array<ArrayBuffer>; opening: Uint8Array<ArrayBuffer> }>
  >;
  /**
   * Whether the conversation's catch-up waits for its first reply (JOIN_PLAN
   * §6.1; the host keeps this on the conversation). A store opened
   * meanwhile is relative (#ensure): only a relative store can take that
   * reply's boundary, and the reply may still close it (closeRelative).
   */
  awaitingCatchUp?: (conversationId: string) => boolean;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type B = Uint8Array<ArrayBuffer>;

function own(bytes: Uint8Array<ArrayBuffer>): B {
  return new Uint8Array(bytes);
}

export function toHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'hex'
  );
}

/** 16 bytes -> "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx". */
function aciBytesToString(bytes: Uint8Array<ArrayBuffer>): string {
  const h = toHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** "xxxxxxxx-xxxx-..." -> 16 bytes. */
export function aciStringToBytes(aci: string): B {
  const h = aci.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) {
    throw new Error(`zrdt: not an ACI: ${aci}`);
  }
  return new Uint8Array(Buffer.from(h, 'hex'));
}

/** The author of an encoded record: its last 16 bytes. */
function authorOfRecord(
  record: Uint8Array<ArrayBuffer>
): Uint8Array<ArrayBuffer> {
  return record.subarray(-16);
}

function openOutcome(result: OpenResult | SalvageResult): ZrdtOpenOutcome {
  switch (result.kind) {
    case 'ok':
      return { status: 'ok' };
    case 'unverifiable':
      return {
        status: 'unverifiable',
        unverifiable: result.unverifiable,
        missing: result.missing,
      };
    case 'collision':
      return { status: 'collision', digest: result.digest };
    case 'malformed':
    case 'tooLarge':
    case 'wrongChat':
      return { status: result.kind };
    default:
      throw new Error('zrdt: unknown open result');
  }
}

function statusOf(status: Status): ZrdtStatus {
  if (status.kind === 'heldBy') {
    return { kind: 'heldBy', aci: aciBytesToString(status.aci) };
  }
  return { kind: status.kind };
}

function provenanceRow(
  conversationId: string,
  digest: Uint8Array<ArrayBuffer>,
  provenance: ZrdtProvenance
): ZrdtProvenanceRowType {
  return {
    conversationId,
    digest: own(digest),
    kind: provenance.kind,
    byAci:
      provenance.kind === 'relayed' ? (provenance.byAci as AciString) : null,
    disownedBy: null,
  };
}

class ZrdtServiceError extends Error {
  readonly code: 'rejected' | 'unavailable' | 'noGroup' | 'notAccepted';

  constructor(code: ZrdtServiceError['code'], message: string) {
    super(`zrdt ${code}: ${message}`);
    this.name = 'ZrdtServiceError';
    this.code = code;
  }
}

/** Per conversation: is a store open (closed or relative), or was it rejected at OPEN? */
type ConversationState =
  | { kind: 'open'; group: B; relative: boolean }
  | { kind: 'rejected'; group: B; outcome: ZrdtOpenOutcome };

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class ZrdtServiceCore implements ZrdtServiceType {
  readonly events = new EventEmitter();

  readonly #deps: ZrdtServiceDeps;
  #backend: ZrdtBackend | undefined;
  #info: ZrdtBackendInfo;
  #initPromise: Promise<void> | undefined;
  readonly #state = new Map<string, ConversationState>();
  readonly #locks = new Map<string, Promise<unknown>>();
  #scratchCounter = 0;
  // The openings of records waiting in zrdt_pending (`<chat>:<hex digest>`),
  // so the record goes in with its opening and its audience is recorded
  // (protocol 4: every live record has its audience). After a restart the
  // host's held openings fill in (heldOpenings).
  readonly #pendingOpenings = new Map<string, B>();

  constructor(deps: ZrdtServiceDeps) {
    this.#deps = deps;
    this.#info = { kind: deps.intendedKind(), version: '', available: false };
    // Listeners of 'error' are not expected; never let an emit throw.
    this.events.setMaxListeners(100);
  }

  // --- start and backend ------------------------------------------------------

  /** Idempotent: every public method awaits it. */
  init(): Promise<void> {
    this.#initPromise ??= this.#init();
    return this.#initPromise;
  }

  async #init(): Promise<void> {
    let backend: ZrdtBackend;
    try {
      backend = this.#deps.createBackend();
    } catch (error) {
      log.error('zrdt: no backend', error);
      this.#setInfo({ ...this.#info, available: false });
      return;
    }
    this.#backend = backend;
    backend.onUnavailable(error => {
      log.error('zrdt: backend unavailable', error.message);
      this.#state.clear();
      this.#setInfo({ ...this.#info, available: false });
    });
    try {
      const { protocol, build } = await backend.version();
      if (protocol !== PROTOCOL_VERSION) {
        // Fail closed: the frames of another protocol do not match.
        log.error(
          `zrdt: backend speaks protocol ${protocol}, not ${PROTOCOL_VERSION}`
        );
        this.#setInfo({
          kind: backend.kind,
          version: `${build} (protocol ${protocol})`,
          available: false,
        });
        return;
      }
      this.#setInfo({
        kind: backend.kind,
        version: `${build} (protocol ${protocol})`,
        available: backend.isAvailable(),
      });
    } catch (error) {
      log.error('zrdt: VERSION failed', error);
      this.#setInfo({ kind: backend.kind, version: '', available: false });
      return;
    }

    const ids = await this.#deps.storage.getZrdtConversationIds();
    log.info(`zrdt: re-opening ${ids.length} conversation(s)`);
    for (const id of ids) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        await this.#serial(id, () => this.#reopen(id));
      } catch (error) {
        log.error(`zrdt: re-open of ${id} failed`, error);
      }
    }
  }

  /**
   * Extra: after the backend failed (zrdtd exited), start a new one and
   * re-OPEN every conversation from its rows. No-op while it is available.
   */
  async restart(): Promise<void> {
    if (this.#backend?.isAvailable() && this.#info.available) {
      return;
    }
    this.#backend = undefined;
    this.#state.clear();
    this.#initPromise = undefined;
    await this.init();
  }

  backendInfo(): ZrdtBackendInfo {
    return { ...this.#info };
  }

  /** The OPEN outcome of a conversation rejected at start, if it was. */
  rejection(conversationId: string): ZrdtOpenOutcome | undefined {
    const state = this.#state.get(conversationId);
    return state?.kind === 'rejected' ? state.outcome : undefined;
  }

  #setInfo(info: ZrdtBackendInfo): void {
    this.#info = info;
    this.#emit('backend', { ...info });
  }

  #emit(event: string, ...args: Array<unknown>): void {
    try {
      this.events.emit(event, ...args);
    } catch (error) {
      log.error(`zrdt: '${event}' listener threw`, error);
    }
  }

  #ready(): ZrdtBackend {
    const backend = this.#backend;
    if (
      backend === undefined ||
      !backend.isAvailable() ||
      !this.#info.available
    ) {
      throw new ZrdtServiceError('unavailable', 'zrdt backend unavailable');
    }
    return backend;
  }

  /** Runs `fn` after every earlier call for the same conversation. */
  #serial<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(conversationId);
    const run = async (): Promise<T> => {
      try {
        await previous;
      } catch {
        // An earlier call failed; this one runs anyway.
      }
      return fn();
    };
    const next = run();
    const settle = async (): Promise<void> => {
      try {
        await next;
      } catch {
        // Reported to the caller of `next`.
      }
    };
    const settled = settle();
    this.#locks.set(conversationId, settled);
    drop(this.#unlock(conversationId, settled));
    return next;
  }

  async #unlock(conversationId: string, settled: Promise<void>): Promise<void> {
    await settled;
    if (this.#locks.get(conversationId) === settled) {
      this.#locks.delete(conversationId);
    }
  }

  async #enter<T>(
    conversationId: string,
    fn: (backend: ZrdtBackend) => Promise<T>
  ): Promise<T> {
    await this.init();
    return this.#serial(conversationId, () => fn(this.#ready()));
  }

  // --- opening stores -----------------------------------------------------------

  #groupFor(conversationId: string, rows: ReadonlyArray<ZrdtRecordRowType>): B {
    const fromConversation = this.#deps.groupIdOf(conversationId);
    if (fromConversation !== undefined && fromConversation.length === 32) {
      return own(fromConversation);
    }
    const first = rows[0];
    if (first !== undefined && first.record.length >= 37) {
      return own(first.record.subarray(5, 37));
    }
    throw new ZrdtServiceError('noGroup', `no group id for ${conversationId}`);
  }

  async #reopen(conversationId: string): Promise<void> {
    const backend = this.#ready();
    const rows = await this.#deps.storage.getZrdtRecords(conversationId);
    let group: B;
    try {
      group = this.#groupFor(conversationId, rows);
    } catch (error) {
      log.warn(`zrdt: skipping ${conversationId}: no group id`);
      return;
    }
    await backend.close(conversationId);
    const mode = await this.#deps.storage.getZrdtStoreMode(conversationId);
    if (mode === 'relative') {
      if (!(await this.#reopenRelative(conversationId, group, rows))) {
        return;
      }
      await this.#reRecordAudiences(conversationId, rows);
    } else if (rows.length === 0) {
      await backend.create(conversationId, group);
      this.#state.set(conversationId, {
        kind: 'open',
        group,
        relative: false,
      });
    } else {
      const result = await backend.open(
        conversationId,
        group,
        rows.map(row => own(row.record))
      );
      if (result.kind !== 'ok') {
        const outcome = openOutcome(result);
        log.warn(`zrdt: ${conversationId} does not verify: ${outcome.status}`);
        this.#state.set(conversationId, { kind: 'rejected', group, outcome });
        this.#emit('rejected', conversationId, outcome);
        return;
      }
      this.#state.set(conversationId, {
        kind: 'open',
        group,
        relative: false,
      });
      await this.#reRecordAudiences(conversationId, rows);
    }
    await this.#drain(conversationId);
  }

  /**
   * Re-opens a relative store from its rows: NEW_RELATIVE, the boundary
   * digests (one ACCEPT_VIEW per voucher), then every record as one batch.
   * False (and the conversation rejected) if a record does not come back.
   */
  async #reopenRelative(
    conversationId: string,
    group: B,
    rows: ReadonlyArray<ZrdtRecordRowType>
  ): Promise<boolean> {
    const backend = this.#ready();
    await backend.createRelative(conversationId, group);
    const boundary = await this.#deps.storage.getZrdtBoundary(conversationId);
    const byVoucher = new Map<string, Array<B>>();
    for (const row of boundary) {
      const list = byVoucher.get(row.voucherAci) ?? [];
      list.push(own(row.digest));
      byVoucher.set(row.voucherAci, list);
    }
    for (const [voucher, digests] of byVoucher) {
      let voucherBytes: B;
      try {
        voucherBytes = aciStringToBytes(voucher);
      } catch {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await backend.acceptView(
        conversationId,
        voucherBytes,
        false,
        // A stored boundary came from catch-up replies (or was linked):
        // catch-up mode keeps every digest.
        'catchup',
        digests.map(digest => ({ kind: 'boundary', digest })),
        []
      );
    }
    if (rows.length > 0) {
      const results = await backend.acceptView(
        conversationId,
        new Uint8Array(16),
        false,
        'catchup',
        rows.map(row => ({ kind: 'after', record: own(row.record) })),
        []
      );
      const bad = rows.filter((_row, i) => results[i]?.kind !== 'ok');
      if (bad.length > 0) {
        const outcome: ZrdtOpenOutcome = {
          status: 'unverifiable',
          unverifiable: bad.map(row => own(row.digest)),
          missing: [],
        };
        log.warn(
          `zrdt: relative ${conversationId} does not reopen: ${bad.length} record(s)`
        );
        await backend.close(conversationId);
        this.#state.set(conversationId, { kind: 'rejected', group, outcome });
        this.#emit('rejected', conversationId, outcome);
        return false;
      }
    }
    this.#state.set(conversationId, { kind: 'open', group, relative: true });
    log.info(
      `zrdt: ${conversationId}: relative store, ${rows.length} record(s), ` +
        `${boundary.length} boundary digest(s)`
    );
    return true;
  }

  /** Re-sends the openings we hold, so zrdtd records their audiences again. */
  async #reRecordAudiences(
    conversationId: string,
    rows: ReadonlyArray<ZrdtRecordRowType>
  ): Promise<void> {
    const held = (await this.#deps.heldOpenings?.(conversationId)) ?? [];
    if (held.length === 0) {
      return;
    }
    const backend = this.#ready();
    const records = new Map(rows.map(row => [toHex(row.digest), row.record]));
    let recorded = 0;
    for (const { digest, opening } of held) {
      const record = records.get(toHex(digest));
      if (record === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const result = await backend.acceptRecord(
        conversationId,
        own(record),
        own(opening)
      );
      if (result.kind === 'accepted') {
        recorded += 1;
      } else {
        log.warn(`zrdt: re-recording an audience: ${result.kind}`);
      }
    }
    log.info(`zrdt: ${conversationId}: ${recorded} audience(s) recorded`);
  }

  /**
   * NEW unless a store is open; throws for a rejected conversation. While
   * the conversation's catch-up waits for its first reply, NEW_RELATIVE
   * instead (a send or a live record came first; the reply decides).
   */
  async #ensure(
    conversationId: string,
    groupId: Uint8Array<ArrayBuffer>
  ): Promise<B> {
    const state = this.#state.get(conversationId);
    if (state?.kind === 'open') {
      return state.group;
    }
    if (state?.kind === 'rejected') {
      throw new ZrdtServiceError(
        'rejected',
        `${conversationId} does not verify (${state.outcome.status}); salvage or import first`
      );
    }
    const group = own(groupId);
    if (this.#deps.awaitingCatchUp?.(conversationId) === true) {
      await this.#newRelative(
        conversationId,
        group,
        'its catch-up waits for a first reply'
      );
      return group;
    }
    try {
      await this.#ready().create(conversationId, group);
    } catch (error) {
      if (!(error instanceof ZrdtBackendError) || error.code !== 'chatOpen') {
        throw error;
      }
    }
    this.#state.set(conversationId, { kind: 'open', group, relative: false });
    return group;
  }

  /** The store must be open; NEW it from the conversation's group otherwise. */
  async #ensureKnown(conversationId: string): Promise<B> {
    const state = this.#state.get(conversationId);
    if (state?.kind === 'open') {
      return state.group;
    }
    const groupId = this.#deps.groupIdOf(conversationId);
    if (groupId === undefined) {
      throw new ZrdtServiceError(
        'noGroup',
        `no group id for ${conversationId}`
      );
    }
    return this.#ensure(conversationId, groupId);
  }

  ensureConversation(
    conversationId: string,
    groupId: Uint8Array<ArrayBuffer>
  ): Promise<void> {
    return this.#enter(conversationId, async () => {
      await this.#ensure(conversationId, groupId);
    });
  }

  // --- reads --------------------------------------------------------------------

  /** HEADS; none (and no store is made) while the conversation has no store. */
  heads(conversationId: string): Promise<Array<Bytes>> {
    return this.#enter(conversationId, async backend => {
      if (this.#state.get(conversationId)?.kind !== 'open') {
        return [];
      }
      return backend.heads(conversationId);
    });
  }

  has(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>
  ): Promise<boolean> {
    return this.#enter(conversationId, async backend => {
      if (this.#state.get(conversationId)?.kind !== 'open') {
        return false;
      }
      return backend.has(conversationId, own(digest));
    });
  }

  get(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtGetResult | undefined> {
    return this.#enter(conversationId, async backend => {
      if (this.#state.get(conversationId)?.kind !== 'open') {
        return undefined;
      }
      const parts = await backend.get(conversationId, own(digest));
      if (parts === undefined) {
        return undefined;
      }
      return {
        record: encodeRecord(makeRecord(parts)),
        authorAci: parts.author,
        links: [...parts.links],
        commit: parts.commit,
      };
    });
  }

  reachSet(
    conversationId: string,
    from: Array<Uint8Array<ArrayBuffer>>
  ): Promise<Array<Bytes>> {
    return this.#enter(conversationId, async backend => {
      if (this.#state.get(conversationId)?.kind !== 'open') {
        return [];
      }
      return backend.reachSet(conversationId, from.map(own));
    });
  }

  exportBlob(conversationId: string): Promise<Bytes> {
    return this.#enter(conversationId, async backend => {
      await this.#ensureKnown(conversationId);
      return backend.encode(conversationId);
    });
  }

  /**
   * Records in our name that we did not create: author is our ACI and the
   * record did not arrive live (only our own sends and sync transcripts are
   * live from our ACI). APP.md section 5 step 12.
   */
  disownSet(conversationId: string): Promise<Array<Bytes>> {
    return this.#enter(conversationId, async () => {
      const me = this.#deps.ourAci();
      if (
        me === undefined ||
        this.#state.get(conversationId)?.kind !== 'open'
      ) {
        return [];
      }
      const meHex = toHex(aciStringToBytes(me));
      const [rows, provenance] = await Promise.all([
        this.#deps.storage.getZrdtRecords(conversationId),
        this.#deps.storage.getZrdtProvenance(conversationId),
      ]);
      const live = new Set(
        provenance.filter(p => p.kind === 'live').map(p => toHex(p.digest))
      );
      return rows
        .filter(
          row =>
            toHex(authorOfRecord(row.record)) === meHex &&
            !live.has(toHex(row.digest))
        )
        .map(row => own(row.digest))
        .sort((a, b) => Buffer.compare(a, b));
    });
  }

  // --- accepting ----------------------------------------------------------------

  async #stored(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>,
    record: Uint8Array<ArrayBuffer>,
    provenance: ZrdtProvenance
  ): Promise<void> {
    await this.#deps.storage.insertZrdtRecords([
      { conversationId, digest: own(digest), record: own(record) },
    ]);
    await this.#deps.storage.upsertZrdtProvenance([
      provenanceRow(conversationId, digest, provenance),
    ]);
    this.#emit('accepted', conversationId, toHex(digest));
  }

  async #pending(
    conversationId: string,
    record: Uint8Array<ArrayBuffer>,
    provenance: ZrdtProvenance,
    opening?: Uint8Array<ArrayBuffer>
  ): Promise<B | undefined> {
    const parts = decodeRecord(own(record));
    if (parts === undefined) {
      return undefined;
    }
    const digest = await this.#ready().hash(parts);
    if (opening !== undefined) {
      this.#pendingOpenings.set(
        `${conversationId}:${toHex(digest)}`,
        own(opening)
      );
    }
    await this.#deps.storage.insertZrdtPending({
      conversationId,
      digest,
      record: own(record),
      messageId: null,
    });
    // CLASSIFY ignores facts about records that are not stored, so the
    // provenance can be written now; the drain only moves the record.
    await this.#deps.storage.upsertZrdtProvenance([
      provenanceRow(conversationId, digest, provenance),
    ]);
    return digest;
  }

  /**
   * The openings of these pending records, where the host holds one: kept
   * since the record went pending, else from the message rows.
   */
  async #pendingOpeningsOf(
    conversationId: string,
    rows: ReadonlyArray<ZrdtPendingRowType>
  ): Promise<Map<string, B>> {
    const out = new Map<string, B>();
    const unknown = new Array<B>();
    for (const row of rows) {
      const hex = toHex(row.digest);
      const known = this.#pendingOpenings.get(`${conversationId}:${hex}`);
      if (known !== undefined) {
        out.set(hex, known);
      } else {
        unknown.push(own(row.digest));
      }
    }
    if (unknown.length > 0 && this.#deps.heldOpenings) {
      for (const { digest, opening } of await this.#deps.heldOpenings(
        conversationId,
        unknown
      )) {
        out.set(toHex(digest), own(opening));
      }
    }
    return out;
  }

  /** A pending record left zrdt_pending (stored, or refused for good). */
  async #unpend(conversationId: string, digest: B): Promise<void> {
    this.#pendingOpenings.delete(`${conversationId}:${toHex(digest)}`);
    await this.#deps.storage.deleteZrdtPending(conversationId, [digest]);
  }

  /**
   * Retries every pending record until no more can be accepted (APP.md
   * section 5 step 2), with its opening when the host holds one (its
   * audience is then recorded). Records the backend refuses for good are
   * dropped.
   */
  async #drain(conversationId: string): Promise<void> {
    const backend = this.#ready();
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const rows = await this.#deps.storage.getZrdtPending(conversationId);
      if (rows.length === 0) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop
      const openings = await this.#pendingOpeningsOf(conversationId, rows);
      let progress = false;
      for (const row of rows) {
        // oxlint-disable-next-line no-await-in-loop
        const result = await backend.acceptRecord(
          conversationId,
          own(row.record),
          openings.get(toHex(row.digest))
        );
        if (result.kind === 'missing') {
          continue;
        }
        progress = true;
        if (result.kind === 'accepted') {
          // oxlint-disable-next-line no-await-in-loop
          await this.#deps.storage.insertZrdtRecords([
            { conversationId, digest: result.digest, record: result.record },
          ]);
          this.#emit('accepted', conversationId, toHex(result.digest));
        } else {
          log.warn(`zrdt: pending record dropped: ${result.kind}`);
        }
        // oxlint-disable-next-line no-await-in-loop
        await this.#unpend(conversationId, own(row.digest));
      }
      if (!progress) {
        return;
      }
    }
  }

  async #afterAccept(conversationId: string): Promise<void> {
    await this.#drain(conversationId);
    this.#emit('classify', conversationId);
  }

  acceptOwn(
    conversationId: string,
    a: ZrdtAcceptOwnArgs
  ): Promise<{ digest: Bytes; record: Bytes; opening: Bytes }> {
    return this.#enter(conversationId, async backend => {
      const group = await this.#ensure(conversationId, a.groupId);
      const committed = await backend.commit(
        group,
        own(a.authorAci),
        own(a.nonce),
        own(a.dataMessageBytes)
      );
      if (committed.kind !== 'ok') {
        throw new ZrdtServiceError(
          'notAccepted',
          'own DataMessage is malformed'
        );
      }
      const result = await backend.accept(
        conversationId,
        {
          group,
          commit: committed.commit,
          links: a.links.map(own),
          author: own(a.authorAci),
        },
        committed.opening
      );
      if (result.kind !== 'accepted') {
        throw new ZrdtServiceError(
          'notAccepted',
          `own record not accepted: ${result.kind}`
        );
      }
      await this.#stored(conversationId, result.digest, result.record, {
        kind: 'live',
      });
      await this.#afterAccept(conversationId);
      return {
        digest: result.digest,
        record: result.record,
        opening: committed.opening,
      };
    });
  }

  acceptIncoming(
    conversationId: string,
    a: ZrdtAcceptIncomingArgs
  ): Promise<ZrdtAcceptOutcome> {
    return this.#enter(conversationId, async backend => {
      const group = await this.#ensure(conversationId, a.groupId);
      const committed = await backend.commit(
        group,
        own(a.authorAci),
        own(a.nonce),
        own(a.dataMessageBytes)
      );
      if (committed.kind !== 'ok') {
        return { status: 'malformed' };
      }
      const parts: RecordParts = {
        group,
        commit: committed.commit,
        links: a.links.map(own),
        author: own(a.authorAci),
      };
      const result = await backend.accept(
        conversationId,
        parts,
        committed.opening
      );
      if (result.kind === 'accepted') {
        await this.#stored(
          conversationId,
          result.digest,
          result.record,
          a.provenance
        );
        await this.#afterAccept(conversationId);
        return {
          status: 'accepted',
          digest: result.digest,
          record: result.record,
          opening: committed.opening,
        };
      }
      if (result.kind === 'missing') {
        const record = encodeRecord(makeRecord(parts));
        const digest = await this.#pending(
          conversationId,
          record,
          a.provenance,
          committed.opening
        );
        return {
          status: 'missing',
          digests: result.digests,
          digest,
          record,
          opening: committed.opening,
        };
      }
      return this.#outcome(result);
    });
  }

  acceptRecord(
    conversationId: string,
    a: ZrdtAcceptRecordArgs
  ): Promise<ZrdtAcceptOutcome> {
    return this.#enter(conversationId, async backend => {
      await this.#ensureKnown(conversationId);
      const result = await backend.acceptRecord(
        conversationId,
        own(a.record),
        a.opening === undefined ? undefined : own(a.opening)
      );
      if (result.kind === 'accepted') {
        await this.#stored(
          conversationId,
          result.digest,
          result.record,
          a.provenance
        );
        await this.#afterAccept(conversationId);
        return {
          status: 'accepted',
          digest: result.digest,
          record: result.record,
          opening: a.opening === undefined ? undefined : own(a.opening),
        };
      }
      if (result.kind === 'missing') {
        const digest = await this.#pending(
          conversationId,
          a.record,
          a.provenance,
          a.opening
        );
        return {
          status: 'missing',
          digests: result.digests,
          digest,
          record: own(a.record),
          opening: a.opening === undefined ? undefined : own(a.opening),
        };
      }
      return this.#outcome(result);
    });
  }

  #outcome(
    result: Exclude<
      AcceptRecordResult,
      { kind: 'accepted' } | { kind: 'missing' }
    >
  ): ZrdtAcceptOutcome {
    if (result.kind === 'collision') {
      return { status: 'collision', digest: result.digest };
    }
    return { status: result.kind };
  }

  // --- audiences and SERVE (JOIN_PLAN sections 3.2, 5) --------------------------

  /** AUDIENCE: the field-201 bytes, or 'tooLarge' over 256 members. */
  async audience(
    members: ReadonlyArray<AudienceMember>
  ): Promise<Bytes | 'tooLarge'> {
    await this.init();
    const result = await this.#ready().audience(
      members.map(m =>
        m.key === undefined
          ? { aci: own(m.aci) }
          : { aci: own(m.aci), key: own(m.key) }
      )
    );
    if (result.kind === 'malformed') {
      throw new ZrdtServiceError(
        'notAccepted',
        'AUDIENCE: no members, or an ACI twice'
      );
    }
    return result.kind === 'ok' ? result.audience : 'tooLarge';
  }

  /** SERVE on the conversation's store (it must be open). */
  serve(
    conversationId: string,
    request: Omit<ServeRequest, 'chat'>
  ): Promise<ServeReply> {
    return this.#enter(conversationId, async backend => {
      if (this.#state.get(conversationId)?.kind !== 'open') {
        throw new ZrdtServiceError('rejected', `${conversationId} is not open`);
      }
      return backend.serve({ ...request, chat: conversationId });
    });
  }

  /** ADDRESSED: stored digests whose recorded audience seats `aci` under `key`. */
  addressed(
    conversationId: string,
    aci: Uint8Array<ArrayBuffer>,
    key: Uint8Array<ArrayBuffer>
  ): Promise<Array<Bytes>> {
    return this.#enter(conversationId, async backend => {
      if (this.#state.get(conversationId)?.kind !== 'open') {
        return [];
      }
      return backend.addressed(conversationId, own(aci), own(key));
    });
  }

  // --- the relative store (JOIN_PLAN sections 4.4, 6) ---------------------------

  /** Whether this device has a store for the conversation (open or rejected). */
  hasStore(conversationId: string): Promise<boolean> {
    return this.#enter(conversationId, async () =>
      this.#state.has(conversationId)
    );
  }

  /** Whether the conversation's open store is relative. */
  isRelative(conversationId: string): Promise<boolean> {
    return this.#enter(conversationId, async () => {
      const state = this.#state.get(conversationId);
      return state?.kind === 'open' && state.relative;
    });
  }

  /**
   * A catch-up starts (JOIN_PLAN §6.1): if the conversation has no store,
   * NEW_RELATIVE one. Returns the mode of the store it has now (an existing
   * store keeps its mode: a closed store never becomes relative).
   */
  startRelative(
    conversationId: string,
    groupId: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtStoreModeType> {
    return this.#enter(conversationId, async () => {
      const state = this.#state.get(conversationId);
      if (state?.kind === 'open') {
        return state.relative ? 'relative' : 'closed';
      }
      if (state?.kind === 'rejected') {
        throw new ZrdtServiceError(
          'rejected',
          `${conversationId} does not verify; salvage or import first`
        );
      }
      await this.#newRelative(conversationId, own(groupId), 'catch-up');
      return 'relative';
    });
  }

  /** NEW_RELATIVE for a conversation that has no store. */
  async #newRelative(
    conversationId: string,
    group: B,
    why: string
  ): Promise<void> {
    const backend = this.#ready();
    await backend.close(conversationId);
    await backend.createRelative(conversationId, group);
    await this.#deps.storage.setZrdtStoreMode(conversationId, 'relative');
    this.#state.set(conversationId, { kind: 'open', group, relative: true });
    log.info(`zrdt: ${conversationId}: new relative store (${why})`);
  }

  /**
   * The first catch-up reply has no boundary digest (a member from the
   * start, JOIN_PLAN §6.1), but the store was opened relative while the
   * catch-up waited for it (#ensure). If the store took no boundary digest,
   * its records are OPENed again as a closed store: over an empty boundary a
   * relative store accepts exactly what a closed one does
   * (`rawAcceptRel_empty`), so every row comes back. They are tried under a
   * scratch key first, and a store that would not reopen closed stays
   * relative. Returns the mode the store has now.
   */
  closeRelative(conversationId: string): Promise<ZrdtStoreModeType> {
    return this.#enter(conversationId, async backend => {
      const state = this.#state.get(conversationId);
      if (state?.kind !== 'open') {
        throw new ZrdtServiceError('rejected', `${conversationId} is not open`);
      }
      if (!state.relative) {
        return 'closed';
      }
      const boundary = await this.#deps.storage.getZrdtBoundary(conversationId);
      if (boundary.length > 0) {
        return 'relative';
      }
      const { group } = state;
      const rows = await this.#deps.storage.getZrdtRecords(conversationId);
      const records = rows.map(row => own(row.record));
      if (records.length > 0) {
        this.#scratchCounter += 1;
        const scratch = `zrdt-scratch-${this.#scratchCounter}-${conversationId}`;
        await backend.close(scratch);
        try {
          const tried = await backend.open(scratch, group, records);
          if (tried.kind !== 'ok') {
            log.warn(
              `zrdt: ${conversationId} does not reopen closed ` +
                `(${openOutcome(tried).status}); it stays relative`
            );
            return 'relative';
          }
        } finally {
          await backend.close(scratch);
        }
      }
      await backend.close(conversationId);
      if (records.length === 0) {
        await backend.create(conversationId, group);
      } else {
        const result = await backend.open(conversationId, group, records);
        if (result.kind !== 'ok') {
          // Not expected: the same records opened under the scratch key.
          log.error(
            `zrdt: ${conversationId}: closed OPEN failed; relative again`
          );
          await this.#reopenRelative(conversationId, group, rows);
          return 'relative';
        }
      }
      await this.#deps.storage.setZrdtStoreMode(conversationId, 'closed');
      this.#state.set(conversationId, { kind: 'open', group, relative: false });
      log.info(
        `zrdt: ${conversationId}: closed store (the first catch-up reply ` +
          `had no boundary digest), ${rows.length} record(s)`
      );
      await this.#reRecordAudiences(conversationId, rows);
      await this.#drain(conversationId);
      this.#emit('classify', conversationId);
      return 'closed';
    });
  }

  /**
   * ACCEPT_VIEW: take the entries of a sealed SERVE reply that passed the
   * §4.4 checks (the caller's duty), vouched by `voucherAci`. Stores a row for
   * every record that is stored now, with the item's provenance, and a
   * boundary row for every boundary digest a relative store took; then
   * drains the pending records.
   */
  acceptView(
    conversationId: string,
    a: Readonly<{
      voucherAci: string;
      forImport: boolean;
      mode: ServeMode;
      items: ReadonlyArray<ZrdtViewItem>;
    }>
  ): Promise<Array<ZrdtViewOutcome>> {
    return this.#enter(conversationId, async backend => {
      await this.#ensureKnown(conversationId);
      // Protocol 4: our pending records go in the same request (with their
      // openings where we hold them), so a boundary digest they link is
      // kept and they are accepted with it.
      const pendingRows =
        await this.#deps.storage.getZrdtPending(conversationId);
      const pendingOpenings = await this.#pendingOpeningsOf(
        conversationId,
        pendingRows
      );
      const pending = pendingRows.map((row): ServeEntry => {
        const opening = pendingOpenings.get(toHex(row.digest));
        return opening !== undefined
          ? {
              kind: 'addressed',
              record: own(row.record),
              authorCopy: false,
              opening,
            }
          : { kind: 'after', record: own(row.record) };
      });
      const results = await backend.acceptView(
        conversationId,
        aciStringToBytes(a.voucherAci),
        a.forImport,
        a.mode,
        a.items.map(item => item.entry),
        pending
      );
      if (results.length !== a.items.length + pending.length) {
        throw new ZrdtServiceError(
          'notAccepted',
          `ACCEPT_VIEW gave ${results.length} results for ` +
            `${a.items.length} entries and ${pending.length} pending`
        );
      }
      const out = new Array<ZrdtViewOutcome>();
      const boundaryRows = new Array<ZrdtBoundaryRowType>();
      const newRecords = new Array<{ digest: B; record: B }>();
      const provenanceRows = new Array<ZrdtProvenanceRowType>();
      for (const [i, item] of a.items.entries()) {
        const result = results[i] ?? { kind: 'malformed' };
        const { entry } = item;
        if (result.kind !== 'ok' || entry.kind === 'boundary') {
          if (result.kind === 'ok' && entry.kind === 'boundary') {
            boundaryRows.push({
              conversationId,
              digest: own(result.digest),
              voucherAci: a.voucherAci as AciString,
            });
          }
          out.push({ result, isNew: false });
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        const inserted = await this.#deps.storage.insertZrdtRecords([
          {
            conversationId,
            digest: own(result.digest),
            record: own(entry.record),
          },
        ]);
        provenanceRows.push(
          provenanceRow(conversationId, result.digest, item.provenance)
        );
        if (inserted > 0) {
          newRecords.push({ digest: own(result.digest), record: entry.record });
        }
        out.push({ result, isNew: inserted > 0 });
      }
      // Pending records the view accepted: stored now (their provenance was
      // written when they went pending).
      for (const [j, row] of pendingRows.entries()) {
        const result = results[a.items.length + j];
        if (result?.kind !== 'ok') {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        const inserted = await this.#deps.storage.insertZrdtRecords([
          {
            conversationId,
            digest: own(result.digest),
            record: own(row.record),
          },
        ]);
        if (inserted > 0) {
          newRecords.push({ digest: own(result.digest), record: row.record });
        }
        // oxlint-disable-next-line no-await-in-loop
        await this.#unpend(conversationId, own(row.digest));
      }
      await this.#deps.storage.upsertZrdtProvenance(provenanceRows);
      const newBoundary =
        boundaryRows.length > 0
          ? await this.#newBoundaryRows(boundaryRows)
          : [];
      for (const { digest } of newRecords) {
        this.#emit('accepted', conversationId, toHex(digest));
      }
      if (newBoundary.length > 0) {
        this.#emit(
          'boundary',
          conversationId,
          newBoundary.map(row => toHex(row.digest))
        );
      }
      await this.#afterAccept(conversationId);
      return out;
    });
  }

  /** Inserts the rows; returns those that were new. */
  async #newBoundaryRows(
    rows: ReadonlyArray<ZrdtBoundaryRowType>
  ): Promise<Array<ZrdtBoundaryRowType>> {
    const out = new Array<ZrdtBoundaryRowType>();
    for (const row of rows) {
      // oxlint-disable-next-line no-await-in-loop
      if ((await this.#deps.storage.insertZrdtBoundary([row])) > 0) {
        out.push(row);
      }
    }
    return out;
  }

  /**
   * LINKABLE: the links of this device's next record (JOIN_PLAN §6.2). A
   * closed store: its heads. A relative store: the heads that are records
   * this device holds live (its own, or an author copy).
   */
  linkable(conversationId: string): Promise<Array<Bytes>> {
    return this.#enter(conversationId, async backend => {
      await this.#ensureKnown(conversationId);
      const provenance =
        await this.#deps.storage.getZrdtProvenance(conversationId);
      const live = provenance
        .filter(p => p.kind === 'live')
        .map(p => own(p.digest));
      return backend.linkable(conversationId, live);
    });
  }

  /**
   * A re-add (JOIN_PLAN §6.5): the store is closed and its rows move to an
   * archive key (they stay readable: the store re-opens under that key at
   * the next start). The conversation then has no store. Returns the key.
   */
  archive(conversationId: string): Promise<string> {
    return this.#enter(conversationId, async backend => {
      const archiveId = `${conversationId}:archived:${Date.now()}`;
      await backend.close(conversationId);
      this.#state.delete(conversationId);
      for (const k of [...this.#pendingOpenings.keys()]) {
        if (k.startsWith(`${conversationId}:`)) {
          this.#pendingOpenings.delete(k);
        }
      }
      await this.#deps.storage.archiveZrdtConversation(
        conversationId,
        archiveId
      );
      log.info(`zrdt: ${conversationId} archived as ${archiveId}`);
      return archiveId;
    });
  }

  /** The boundary digests of the conversation's relative store, with vouchers. */
  boundary(conversationId: string): Promise<Array<ZrdtBoundaryRowType>> {
    return this.#enter(conversationId, async () =>
      this.#deps.storage.getZrdtBoundary(conversationId)
    );
  }

  // --- provenance ---------------------------------------------------------------

  /**
   * CLASSIFY from the zrdt_provenance rows. A row's `disownedBy` (set only
   * from a live message of the record's author) becomes a disown entry on
   * one live record of that author: CLASSIFY joins the disown lists of all
   * live records of an author, so which one carries it does not matter.
   */
  classify(conversationId: string): Promise<Map<string, ZrdtStatus>> {
    return this.#enter(conversationId, async backend => {
      const out = new Map<string, ZrdtStatus>();
      if (this.#state.get(conversationId)?.kind !== 'open') {
        return out;
      }
      const [rows, provenance] = await Promise.all([
        this.#deps.storage.getZrdtRecords(conversationId),
        this.#deps.storage.getZrdtProvenance(conversationId),
      ]);
      const authorByDigest = new Map<string, string>();
      for (const row of rows) {
        authorByDigest.set(
          toHex(row.digest),
          toHex(authorOfRecord(row.record))
        );
      }
      const liveByAuthor = new Map<string, string>();
      for (const p of provenance) {
        const author = authorByDigest.get(toHex(p.digest));
        if (
          p.kind === 'live' &&
          author !== undefined &&
          !liveByAuthor.has(author)
        ) {
          liveByAuthor.set(author, toHex(p.digest));
        }
      }
      const disowns = new Map<string, Array<B>>();
      for (const p of provenance) {
        if (p.disownedBy == null) {
          continue;
        }
        let byHex: string;
        try {
          byHex = toHex(aciStringToBytes(p.disownedBy));
        } catch {
          continue;
        }
        const carrier = liveByAuthor.get(byHex);
        if (carrier === undefined) {
          continue;
        }
        const list = disowns.get(carrier) ?? [];
        list.push(own(p.digest));
        disowns.set(carrier, list);
      }
      const facts: Array<ProvenanceFact> = provenance.map(p => {
        const digest = own(p.digest);
        if (p.kind === 'relayed' && p.byAci != null) {
          let by: B;
          try {
            by = aciStringToBytes(p.byAci);
          } catch {
            return { digest, provenance: { kind: 'imported' }, disown: [] };
          }
          return { digest, provenance: { kind: 'relayed', by }, disown: [] };
        }
        if (p.kind === 'live') {
          return {
            digest,
            provenance: { kind: 'live' },
            disown: disowns.get(toHex(digest)) ?? [],
          };
        }
        return { digest, provenance: { kind: 'imported' }, disown: [] };
      });
      const statuses = await backend.classify(conversationId, facts);
      for (const { digest, status } of statuses) {
        out.set(toHex(digest), statusOf(status));
      }
      return out;
    });
  }

  markDisowned(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>,
    byAci: string
  ): Promise<void> {
    return this.#enter(conversationId, async () => {
      await this.#deps.storage.markZrdtDisowned(
        conversationId,
        [own(digest)],
        byAci
      );
      this.#emit('classify', conversationId);
    });
  }

  // --- import, salvage ------------------------------------------------------------

  /** Every stored digest (each stored record is reachable from a head). */
  async #allDigests(backend: ZrdtBackend, chat: string): Promise<Set<string>> {
    const heads = await backend.heads(chat);
    const all = await backend.reachSet(chat, heads);
    return new Set(all.map(toHex));
  }

  /** Rows (and provenance `imported`) for every record of `chat` not in `before`. */
  async #storeNew(
    backend: ZrdtBackend,
    conversationId: string,
    before: Set<string>
  ): Promise<void> {
    const heads = await backend.heads(conversationId);
    const after = await backend.reachSet(conversationId, heads);
    const added = after.filter(d => !before.has(toHex(d)));
    const rows = new Array<ZrdtRecordRowType>();
    for (const digest of added) {
      // oxlint-disable-next-line no-await-in-loop
      const parts = await backend.get(conversationId, digest);
      if (parts !== undefined) {
        rows.push({
          conversationId,
          digest: own(digest),
          record: encodeRecord(makeRecord(parts)),
        });
      }
    }
    // A valid OPEN order: parents first. reachSet is sorted by digest, so
    // order the rows by depth before writing them.
    const ordered = orderParentsFirst(rows);
    await this.#deps.storage.insertZrdtRecords(ordered);
    await this.#deps.storage.upsertZrdtProvenance(
      ordered.map(row =>
        provenanceRow(conversationId, row.digest, { kind: 'imported' })
      )
    );
    for (const row of ordered) {
      this.#emit('accepted', conversationId, toHex(row.digest));
    }
  }

  /**
   * A relative store's boundary after a MERGE (which adds the blob's
   * boundary): read it from ENCODE and keep the digests not yet stored.
   */
  async #storeBoundary(
    backend: ZrdtBackend,
    conversationId: string
  ): Promise<void> {
    const state = this.#state.get(conversationId);
    if (state?.kind !== 'open' || !state.relative) {
      return;
    }
    const boundary =
      readBlob3Header(await backend.encode(conversationId))?.boundary ?? [];
    const rows = boundary.map(({ digest, voucher }) => ({
      conversationId,
      digest,
      voucherAci: aciBytesToString(voucher) as AciString,
    }));
    const added = await this.#newBoundaryRows(rows);
    if (added.length > 0) {
      this.#emit(
        'boundary',
        conversationId,
        added.map(row => toHex(row.digest))
      );
    }
  }

  /**
   * MERGE a blob into the open store (it is OPENed first by the backend);
   * new records start `imported`, records already held keep their
   * provenance. TODO(zrdt T0): importing into a conversation rejected at
   * start is not supported yet (salvage it first).
   */
  importBlob(
    conversationId: string,
    blob: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtOpenOutcome> {
    return this.#enter(conversationId, async backend => {
      await this.#ensureKnown(conversationId);
      const before = await this.#allDigests(backend, conversationId);
      const result = await backend.merge(conversationId, own(blob));
      if (result.kind !== 'ok') {
        return openOutcome(result);
      }
      await this.#storeNew(backend, conversationId, before);
      await this.#storeBoundary(backend, conversationId);
      await this.#afterAccept(conversationId);
      return { status: 'ok' };
    });
  }

  /**
   * "Keep what verifies" (APP.md sections 6 and 7). With an open store:
   * SALVAGE under a scratch chat key, ENCODE it, MERGE that into the open
   * store, CLOSE the scratch key; the open store only grows, and only new
   * records start `imported`. For a conversation rejected at start: SALVAGE
   * the blob under the chat key itself and rewrite its rows to the kept
   * records.
   */
  salvageBlob(
    conversationId: string,
    blob: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtSalvageOutcome> {
    return this.#enter(conversationId, async backend => {
      const state = this.#state.get(conversationId);
      if (state?.kind === 'rejected') {
        return this.#salvageRejected(
          backend,
          conversationId,
          state.group,
          own(blob)
        );
      }
      const group = await this.#ensureKnown(conversationId);
      this.#scratchCounter += 1;
      const scratch = `zrdt-scratch-${this.#scratchCounter}-${conversationId}`;
      await backend.close(scratch);
      try {
        const salvaged = await backend.salvage(scratch, group, own(blob));
        if (salvaged.kind !== 'ok') {
          return openOutcome(salvaged);
        }
        const kept = await backend.encode(scratch);
        const before = await this.#allDigests(backend, conversationId);
        const merged = await backend.merge(conversationId, kept);
        if (merged.kind !== 'ok') {
          return openOutcome(merged);
        }
        await this.#storeNew(backend, conversationId, before);
        await this.#afterAccept(conversationId);
        return { dropped: salvaged.dropped, missing: salvaged.missing };
      } finally {
        await backend.close(scratch);
      }
    });
  }

  /** "Keep what verifies" from the conversation's own rows, rejected at start. */
  salvageStored(conversationId: string): Promise<ZrdtSalvageOutcome> {
    return this.#enter(conversationId, async backend => {
      const state = this.#state.get(conversationId);
      if (state?.kind !== 'rejected') {
        return { dropped: [], missing: [] };
      }
      const rows = await this.#deps.storage.getZrdtRecords(conversationId);
      return this.#salvageRejected(
        backend,
        conversationId,
        state.group,
        rows.map(row => own(row.record))
      );
    });
  }

  async #salvageRejected(
    backend: ZrdtBackend,
    conversationId: string,
    group: B,
    input: B | Array<B>
  ): Promise<ZrdtSalvageOutcome> {
    const salvaged = await backend.salvage(conversationId, group, input);
    if (salvaged.kind !== 'ok') {
      return openOutcome(salvaged);
    }
    this.#state.set(conversationId, { kind: 'open', group, relative: false });
    // Rewrite the rows: drop the dropped digests, add kept records that are
    // new (when the input was a blob), all kept records become imported.
    // Exception (T0 decision): records in our own name that were live stay
    // live, so we never disown our own messages after a salvage.
    await this.#deps.storage.deleteZrdtRecords(
      conversationId,
      salvaged.dropped.map(own)
    );
    const rows = await this.#deps.storage.getZrdtRecords(conversationId);
    await this.#storeNew(
      backend,
      conversationId,
      new Set(rows.map(row => toHex(row.digest)))
    );
    const me = this.#deps.ourAci();
    const meHex = me === undefined ? undefined : toHex(aciStringToBytes(me));
    const provenance =
      await this.#deps.storage.getZrdtProvenance(conversationId);
    const liveOwn = new Set(
      provenance.filter(p => p.kind === 'live').map(p => toHex(p.digest))
    );
    const keptRows = (
      await this.#deps.storage.getZrdtRecords(conversationId)
    ).filter(
      row =>
        !(
          meHex !== undefined &&
          toHex(authorOfRecord(row.record)) === meHex &&
          liveOwn.has(toHex(row.digest))
        )
    );
    await this.#deps.storage.upsertZrdtProvenance(
      keptRows.map(row =>
        provenanceRow(conversationId, row.digest, { kind: 'imported' })
      ),
      { mode: 'replace' }
    );
    await this.#afterAccept(conversationId);
    return { dropped: salvaged.dropped, missing: salvaged.missing };
  }
}

/** Orders rows so that each record comes after the records it links. */
function orderParentsFirst(
  rows: ReadonlyArray<ZrdtRecordRowType>
): Array<ZrdtRecordRowType> {
  const byHex = new Map(rows.map(row => [toHex(row.digest), row]));
  const done = new Set<string>();
  const out = new Array<ZrdtRecordRowType>();
  const visit = (hex: string, depth: number): void => {
    const row = byHex.get(hex);
    if (row === undefined || done.has(hex) || depth > rows.length) {
      return;
    }
    done.add(hex);
    const parts = decodeRecord(own(row.record));
    for (const link of parts?.links ?? []) {
      visit(toHex(link), depth + 1);
    }
    out.push(row);
  };
  for (const hex of byHex.keys()) {
    visit(hex, 0);
  }
  return out;
}
