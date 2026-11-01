// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

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
import type { AciString } from '../types/ServiceId.std.ts';
import type {
  UpsertZrdtProvenanceOptionsType,
  ZrdtPendingRowType,
  ZrdtProvenanceRowType,
  ZrdtRecordRowType,
} from '../types/Zrdt.std.ts';
import { ZrdtBackendError } from './ZrdtBackend.std.ts';
import type {
  AcceptRecordResult,
  OpenResult,
  ProvenanceFact,
  RecordParts,
  SalvageResult,
  Status,
  ZrdtBackend,
} from './ZrdtBackend.std.ts';
import { decodeRecord, encodeRecord } from './backends/stub.node.ts';

const log = createLogger('zrdt/service');

// ---------------------------------------------------------------------------
// The contract types (shared by every lane; do not change their shape)
// ---------------------------------------------------------------------------

// Inputs are `Uint8Array`; outputs are `Uint8Array<ArrayBuffer>` (a subtype),
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
  | { status: 'badOpening' };

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
  groupId: Uint8Array;
  authorAci: Uint8Array;
  nonce: Uint8Array;
  dataMessageBytes: Uint8Array;
  links: Array<Uint8Array>;
};

export type ZrdtAcceptIncomingArgs = ZrdtAcceptOwnArgs & {
  provenance: ZrdtProvenance;
};

export type ZrdtAcceptRecordArgs = {
  record: Uint8Array;
  opening?: Uint8Array;
  provenance: ZrdtProvenance;
};

export type ZrdtGetResult = {
  record: Bytes;
  authorAci: Bytes;
  links: Array<Bytes>;
  commit: Bytes;
};

export type ZrdtSalvageOutcome =
  | { dropped: Array<Bytes>; missing: Array<Bytes> }
  | ZrdtOpenOutcome;

export interface ZrdtServiceType {
  init(): Promise<void>;
  backendInfo(): ZrdtBackendInfo;
  ensureConversation(
    conversationId: string,
    groupId: Uint8Array
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
  has(conversationId: string, digest: Uint8Array): Promise<boolean>;
  get(
    conversationId: string,
    digest: Uint8Array
  ): Promise<ZrdtGetResult | undefined>;
  reachSet(
    conversationId: string,
    from: Array<Uint8Array>
  ): Promise<Array<Bytes>>;
  classify(conversationId: string): Promise<Map<string, ZrdtStatus>>;
  markDisowned(
    conversationId: string,
    digest: Uint8Array,
    byAci: string
  ): Promise<void>;
  exportBlob(conversationId: string): Promise<Bytes>;
  importBlob(
    conversationId: string,
    blob: Uint8Array
  ): Promise<ZrdtOpenOutcome>;
  salvageBlob(
    conversationId: string,
    blob: Uint8Array
  ): Promise<ZrdtSalvageOutcome>;
}

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
}>;

export type ZrdtServiceDeps = Readonly<{
  /** Makes the backend; throws if none may be used (ZRDT_REQUIRE_LEAN=1). */
  createBackend: () => ZrdtBackend;
  /** The kind to report if createBackend throws. */
  intendedKind: () => 'lean' | 'stub';
  storage: ZrdtServiceStorage;
  /** The group's 32-byte id, if the conversation is a known group. */
  groupIdOf: (conversationId: string) => Uint8Array | undefined;
  /** Our ACI (uuid string), if registered. */
  ourAci: () => string | undefined;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type B = Uint8Array<ArrayBuffer>;

function own(bytes: Uint8Array): B {
  return new Uint8Array(bytes);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'hex'
  );
}

/** 16 bytes -> "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx". */
export function aciBytesToString(bytes: Uint8Array): string {
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
function authorOfRecord(record: Uint8Array): Uint8Array {
  return record.subarray(record.length - 16);
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
  digest: Uint8Array,
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

export class ZrdtServiceError extends Error {
  readonly code: 'rejected' | 'unavailable' | 'noGroup' | 'notAccepted';

  constructor(code: ZrdtServiceError['code'], message: string) {
    super(`zrdt ${code}: ${message}`);
    this.name = 'ZrdtServiceError';
    this.code = code;
  }
}

/** Per conversation: is a store open, or was it rejected at OPEN? */
type ConversationState =
  | { kind: 'open'; group: B }
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
    const previous = this.#locks.get(conversationId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined
    );
    this.#locks.set(conversationId, settled);
    void settled.then(() => {
      if (this.#locks.get(conversationId) === settled) {
        this.#locks.delete(conversationId);
      }
    });
    return next;
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
    if (rows.length === 0) {
      await backend.create(conversationId, group);
      this.#state.set(conversationId, { kind: 'open', group });
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
      this.#state.set(conversationId, { kind: 'open', group });
    }
    await this.#drain(conversationId);
  }

  /** NEW unless a store is open; throws for a rejected conversation. */
  async #ensure(conversationId: string, groupId: Uint8Array): Promise<B> {
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
    try {
      await this.#ready().create(conversationId, group);
    } catch (error) {
      if (!(error instanceof ZrdtBackendError) || error.code !== 'chatOpen') {
        throw error;
      }
    }
    this.#state.set(conversationId, { kind: 'open', group });
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
    groupId: Uint8Array
  ): Promise<void> {
    return this.#enter(conversationId, async () => {
      await this.#ensure(conversationId, groupId);
    });
  }

  // --- reads --------------------------------------------------------------------

  heads(conversationId: string): Promise<Array<Bytes>> {
    return this.#enter(conversationId, async backend => {
      await this.#ensureKnown(conversationId);
      return backend.heads(conversationId);
    });
  }

  has(conversationId: string, digest: Uint8Array): Promise<boolean> {
    return this.#enter(conversationId, async backend => {
      if (this.#state.get(conversationId)?.kind !== 'open') {
        return false;
      }
      return backend.has(conversationId, own(digest));
    });
  }

  get(
    conversationId: string,
    digest: Uint8Array
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
        record: encodeRecord(parts),
        authorAci: parts.author,
        links: [...parts.links],
        commit: parts.commit,
      };
    });
  }

  reachSet(
    conversationId: string,
    from: Array<Uint8Array>
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
    digest: Uint8Array,
    record: Uint8Array,
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
    record: Uint8Array,
    provenance: ZrdtProvenance
  ): Promise<B | undefined> {
    const parts = decodeRecord(own(record));
    if (parts === undefined) {
      return undefined;
    }
    const digest = await this.#ready().hash(parts);
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
   * Retries every pending record until no more can be accepted (APP.md
   * section 5 step 2). Records the backend refuses for good are dropped.
   */
  async #drain(conversationId: string): Promise<void> {
    const backend = this.#ready();
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const rows = await this.#deps.storage.getZrdtPending(conversationId);
      if (rows.length === 0) {
        return;
      }
      let progress = false;
      for (const row of rows) {
        // oxlint-disable-next-line no-await-in-loop
        const result = await backend.acceptRecord(
          conversationId,
          own(row.record)
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
        await this.#deps.storage.deleteZrdtPending(conversationId, [
          own(row.digest),
        ]);
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
      const result = await backend.accept(conversationId, {
        group,
        commit: committed.commit,
        links: a.links.map(own),
        author: own(a.authorAci),
      });
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
      const result = await backend.accept(conversationId, parts);
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
        const record = encodeRecord(parts);
        const digest = await this.#pending(
          conversationId,
          record,
          a.provenance
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
          a.provenance
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
    digest: Uint8Array,
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
          record: encodeRecord(parts),
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
   * MERGE a blob into the open store (it is OPENed first by the backend);
   * new records start `imported`, records already held keep their
   * provenance. TODO(zrdt T0): importing into a conversation rejected at
   * start is not supported yet (salvage it first).
   */
  importBlob(
    conversationId: string,
    blob: Uint8Array
  ): Promise<ZrdtOpenOutcome> {
    return this.#enter(conversationId, async backend => {
      await this.#ensureKnown(conversationId);
      const before = await this.#allDigests(backend, conversationId);
      const result = await backend.merge(conversationId, own(blob));
      if (result.kind !== 'ok') {
        return openOutcome(result);
      }
      await this.#storeNew(backend, conversationId, before);
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
    blob: Uint8Array
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
    this.#state.set(conversationId, { kind: 'open', group });
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
export function orderParentsFirst(
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
