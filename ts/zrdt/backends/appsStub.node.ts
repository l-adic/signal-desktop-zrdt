// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The protocol-5 TypeScript stub: the app ops of zrdt docs/apps/BUILD_M1.md
// §B over the protocol-4 stub (./stub.node.ts), so the fork's app plumbing
// runs and is tested before zrdtd speaks protocol 5. Written from BUILD_M1
// §B only (not from Lean), like the protocol-4 stub, so a differential test
// against the Lean vectors finds mistakes in either.
//
// State, as zrdtd's (Lean `Zrdt.AppBase.State`): the chats and channels (a
// protocol-4 stub), the piece stores (a second one, each a closed store) and
// their contexts under the same piece keys. Protocol-4 ops on a piece key
// (Lean `Zrdt.Apps.runV4`): the read-only ones run on the piece store, CLOSE
// drops it and its context, NEW/NEW_RELATIVE/OPEN/SALVAGE are CHAT_OPEN, and
// ACCEPT/ACCEPT_RECORD/ACCEPT_VIEW/MERGE are BAD_REQUEST. So a piece store
// holds only F and pieces whose bytes this stub checked.

import {
  ACI_BYTES,
  APPS_PROTOCOL_VERSION,
  GROUP_ID_BYTES,
  NONCE_BYTES,
  ZrdtBackendError,
} from '../ZrdtBackend.std.ts';
import type {
  AcceptRecordResult,
  AcceptResult,
  AssembleResult,
  AudienceMember,
  AudienceResult,
  BackendKind,
  BtBuildRequest,
  BtBuildResult,
  BtFileResult,
  Bytes,
  ChannelResult,
  ChatKey,
  CommitResult,
  Digest,
  GitObjectsResult,
  GitPrepareRequest,
  GitPrepareResult,
  GitViewResult,
  OpenInput,
  OpenResult,
  PieceAcceptResult,
  PieceOpeningResult,
  PiecesBindRequest,
  PiecesBindResult,
  ProvenanceFact,
  RecordParts,
  RecordStatus,
  SalvageResult,
  ServeEntry,
  ServeHeld,
  ServeMode,
  ServeReply,
  ServeRequest,
  VersionInfo,
  ViewResult,
  ZrdtAppsBackend,
} from '../ZrdtBackend.std.ts';
import { seatsUnderTag } from '../audience.std.ts';
import {
  APP_TORRENT,
  CHANNEL_TORRENT,
  MAX_MANIFEST_BYTES,
  MAX_TAG_BYTES,
  appMessageBytes,
  equalBytes,
  utf8,
  writeDescriptor,
} from '../apps/appMessage.std.ts';
import type { AppHeader } from '../apps/appMessage.std.ts';
import {
  StubBackend,
  decodeRecord,
  encodeRecord,
  hashRecord,
  stubKeyTag,
} from './stub.node.ts';
import type { StubBackendOptions } from './stub.node.ts';
import type { PieceCtx } from './pieceStub.node.ts';
import {
  TORRENT_BODY,
  authorCtx,
  authorLimitsOk,
  badApp,
  bindCtx,
  channelIdOf,
  ctxStoreId,
  firstBadSlice,
  manifestOpening,
  manifestRecord,
  parseTorrentManifest,
  pieceOk,
  pieceOpening,
  pieceRecord,
  safeComponent,
  torrentManifest,
} from './pieceStub.node.ts';
import { gitObjects, gitPrepare, gitView } from './gitStub.node.ts';

function btBuild(q: BtBuildRequest): BtBuildResult {
  if (!safeComponent(q.name)) {
    return { kind: 'badName' };
  }
  if (!authorLimitsOk(q.exp, q.audience, q.pointers, q.stream.length, false)) {
    return badApp('limits');
  }
  const manifest = torrentManifest(q.name, q.stream.length);
  if (manifest.length > MAX_MANIFEST_BYTES) {
    return badApp('limits');
  }
  const header: AppHeader = {
    audience: q.audience,
    app: utf8(APP_TORRENT),
    channel: utf8(CHANNEL_TORRENT),
    body: TORRENT_BODY,
  };
  const ctx = authorCtx({
    channel: q.channel,
    author: q.author,
    nonce: q.nonce,
    exp: q.exp,
    header,
    stream: q.stream,
    manifest,
  });
  const message = appMessageBytes({
    ...header,
    descriptor: writeDescriptor(ctx.desc),
    ...(q.pointers.length > 0 ? { pointers: q.pointers } : {}),
  });
  return { kind: 'ok', message, ordered: [...ctx.desc.ordered] };
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

function checkSize(name: string, value: Bytes, size: number): void {
  if (value.length !== size) {
    throw new ZrdtBackendError(
      'badInput',
      `${name} must be ${size} bytes, got ${value.length}`
    );
  }
}

/**
 * The protocol-5 stub: VERSION says 5. `ZRDT_REQUIRE_LEAN=1` refuses it, as
 * it refuses the protocol-4 stub.
 */
export class AppsStubBackend implements ZrdtAppsBackend {
  readonly kind: BackendKind = 'stub';
  readonly #chats: StubBackend;
  readonly #pieces: StubBackend;
  readonly #ctxs = new Map<ChatKey, PieceCtx>();

  constructor(options: StubBackendOptions = {}) {
    this.#chats = new StubBackend(options);
    this.#pieces = new StubBackend(options);
  }

  isAvailable(): boolean {
    return true;
  }

  onUnavailable(): () => void {
    return () => undefined;
  }

  async version(): Promise<VersionInfo> {
    return { protocol: APPS_PROTOCOL_VERSION, build: 'stub' };
  }

  /** The context bound under a piece key (tests and the git stub). */
  ctx(pieceKey: ChatKey): PieceCtx | undefined {
    return this.#ctxs.get(pieceKey);
  }

  #isPiece(key: ChatKey): boolean {
    return this.#ctxs.has(key);
  }

  /** The store a read-only protocol-4 op runs on. */
  #reader(key: ChatKey): StubBackend {
    return this.#isPiece(key) ? this.#pieces : this.#chats;
  }

  #notPiece(key: ChatKey, ifPiece: 'chatOpen' | 'badInput'): void {
    if (this.#isPiece(key)) {
      throw new ZrdtBackendError(
        ifPiece,
        ifPiece === 'chatOpen'
          ? `${key} is a piece store`
          : `${key}: a piece store takes only PIECE_ACCEPT and PIECES_COMPLETE`
      );
    }
  }

  // --- protocol 4 ----------------------------------------------------------

  async create(chat: ChatKey, group: Bytes): Promise<void> {
    this.#notPiece(chat, 'chatOpen');
    return this.#chats.create(chat, group);
  }

  async createRelative(chat: ChatKey, group: Bytes): Promise<void> {
    this.#notPiece(chat, 'chatOpen');
    return this.#chats.createRelative(chat, group);
  }

  async open(
    chat: ChatKey,
    group: Bytes,
    input: OpenInput
  ): Promise<OpenResult> {
    this.#notPiece(chat, 'chatOpen');
    return this.#chats.open(chat, group, input);
  }

  async salvage(
    chat: ChatKey,
    group: Bytes,
    input: OpenInput
  ): Promise<SalvageResult> {
    this.#notPiece(chat, 'chatOpen');
    return this.#chats.salvage(chat, group, input);
  }

  async commit(
    group: Bytes,
    author: Bytes,
    nonce: Bytes,
    dataMessage: Bytes
  ): Promise<CommitResult> {
    return this.#chats.commit(group, author, nonce, dataMessage);
  }

  async hash(record: RecordParts): Promise<Digest> {
    return this.#chats.hash(record);
  }

  async accept(
    chat: ChatKey,
    record: RecordParts,
    opening: Bytes
  ): Promise<AcceptRecordResult> {
    this.#notPiece(chat, 'badInput');
    return this.#chats.accept(chat, record, opening);
  }

  async acceptRecord(
    chat: ChatKey,
    record: Bytes,
    opening?: Bytes
  ): Promise<AcceptRecordResult> {
    this.#notPiece(chat, 'badInput');
    return this.#chats.acceptRecord(chat, record, opening);
  }

  async acceptView(
    chat: ChatKey,
    voucher: Bytes,
    forImport: boolean,
    mode: ServeMode,
    entries: ReadonlyArray<ServeEntry>,
    pending: ReadonlyArray<ServeEntry>
  ): Promise<Array<ViewResult>> {
    this.#notPiece(chat, 'badInput');
    return this.#chats.acceptView(
      chat,
      voucher,
      forImport,
      mode,
      entries,
      pending
    );
  }

  async linkable(
    chat: ChatKey,
    live: ReadonlyArray<Digest>
  ): Promise<Array<Digest>> {
    return this.#reader(chat).linkable(chat, live);
  }

  async heads(chat: ChatKey): Promise<Array<Digest>> {
    return this.#reader(chat).heads(chat);
  }

  async has(chat: ChatKey, digest: Digest): Promise<boolean> {
    return this.#reader(chat).has(chat, digest);
  }

  async get(chat: ChatKey, digest: Digest): Promise<RecordParts | undefined> {
    return this.#reader(chat).get(chat, digest);
  }

  async reachSet(
    chat: ChatKey,
    from: ReadonlyArray<Digest>
  ): Promise<Array<Digest>> {
    return this.#reader(chat).reachSet(chat, from);
  }

  async merge(chat: ChatKey, blob: Bytes): Promise<OpenResult> {
    this.#notPiece(chat, 'badInput');
    return this.#chats.merge(chat, blob);
  }

  async classify(
    chat: ChatKey,
    facts: ReadonlyArray<ProvenanceFact>
  ): Promise<Array<RecordStatus>> {
    return this.#reader(chat).classify(chat, facts);
  }

  async encode(chat: ChatKey): Promise<Bytes> {
    return this.#reader(chat).encode(chat);
  }

  async close(chat: ChatKey): Promise<void> {
    if (this.#isPiece(chat)) {
      this.#ctxs.delete(chat);
      return this.#pieces.close(chat);
    }
    return this.#chats.close(chat);
  }

  async audience(
    members: ReadonlyArray<AudienceMember>
  ): Promise<AudienceResult> {
    return this.#chats.audience(members);
  }

  async serve(request: ServeRequest): Promise<ServeReply> {
    return this.#reader(request.chat).serve(request);
  }

  async addressed(
    chat: ChatKey,
    aci: Bytes,
    key: Bytes
  ): Promise<Array<Digest>> {
    return this.#reader(chat).addressed(chat, aci, key);
  }

  // --- protocol 5: base ops (BUILD_M1 §B.5) --------------------------------

  async channel(
    signalGroup: Bytes,
    app: string,
    name: string
  ): Promise<ChannelResult> {
    checkSize('signal group', signalGroup, GROUP_ID_BYTES);
    const a = utf8(app);
    const n = utf8(name);
    if (
      a.length < 1 ||
      a.length > MAX_TAG_BYTES ||
      n.length < 1 ||
      n.length > MAX_TAG_BYTES
    ) {
      return badApp('limits');
    }
    return { kind: 'ok', channel: channelIdOf(signalGroup, a, n) };
  }

  #channelOpen(key: ChatKey): void {
    if (this.#isPiece(key) || this.#chats.peek(key) === undefined) {
      throw new ZrdtBackendError('unknownChat', `no channel store ${key}`);
    }
  }

  async piecesBind(q: PiecesBindRequest): Promise<PiecesBindResult> {
    checkSize('signal group', q.signalGroup, GROUP_ID_BYTES);
    checkSize('own aci', q.ownAci, ACI_BYTES);
    this.#channelOpen(q.channelKey);
    if (
      this.#isPiece(q.pieceKey) ||
      this.#chats.peek(q.pieceKey) !== undefined
    ) {
      throw new ZrdtBackendError('chatOpen', `${q.pieceKey} is in use`);
    }
    const a = decodeRecord(q.announcement);
    if (a === undefined) {
      return { kind: 'malformed' };
    }
    if (!(await this.#chats.has(q.channelKey, hashRecord(a)))) {
      return badApp('notStored');
    }
    const ctx = bindCtx(q.signalGroup, utf8(q.app), a, q.opening);
    if ('kind' in ctx) {
      return ctx;
    }
    if (!seatsUnderTag(ctx.seats, q.ownAci, stubKeyTag(q.ownKey))) {
      return badApp('notSeated');
    }
    await this.#pieces.create(q.pieceKey, ctxStoreId(ctx));
    this.#ctxs.set(q.pieceKey, ctx);
    return {
      kind: 'ok',
      len: ctx.desc.len,
      exp: ctx.desc.exp,
      ordered: ctx.desc.ordered.map(d => new Uint8Array(d)),
      body: new Uint8Array(ctx.header.body),
      manifest: new Uint8Array(ctx.desc.manifest),
      pointers: new Uint8Array(ctx.header.pointers ?? new Uint8Array(0)),
    };
  }

  #ctxOf(pieceKey: ChatKey): PieceCtx {
    const ctx = this.#ctxs.get(pieceKey);
    if (ctx === undefined) {
      throw new ZrdtBackendError('unknownChat', `no piece store ${pieceKey}`);
    }
    return ctx;
  }

  async pieceAccept(
    pieceKey: ChatKey,
    index: number,
    piece: Bytes
  ): Promise<PieceAcceptResult> {
    const ctx = this.#ctxOf(pieceKey);
    if (!pieceOk(ctx, index, piece)) {
      return { kind: 'badPiece' };
    }
    const record = pieceRecord(ctx, index, piece);
    const result = await this.#pieces.accept(
      pieceKey,
      record,
      pieceOpening(ctx, index, piece)
    );
    if (result.kind !== 'accepted') {
      throw new Error(
        `apps stub: a checked piece was not accepted: ${result.kind}`
      );
    }
    return { kind: 'ok', digest: result.digest };
  }

  async pieceOpening(
    pieceKey: ChatKey,
    index: number,
    piece: Bytes
  ): Promise<PieceOpeningResult> {
    const ctx = this.#ctxOf(pieceKey);
    return pieceOk(ctx, index, piece)
      ? { kind: 'ok', opening: pieceOpening(ctx, index, piece) }
      : { kind: 'badPiece' };
  }

  async piecesComplete(pieceKey: ChatKey): Promise<AcceptResult> {
    const ctx = this.#ctxOf(pieceKey);
    const result = await this.#pieces.accept(
      pieceKey,
      manifestRecord(ctx),
      manifestOpening(ctx)
    );
    if (
      result.kind === 'malformed' ||
      result.kind === 'badOpening' ||
      result.kind === 'noAudience'
    ) {
      throw new Error(`apps stub: F was refused: ${result.kind}`);
    }
    return result;
  }

  async assemble(pieceKey: ChatKey, stream: Bytes): Promise<AssembleResult> {
    const ctx = this.#ctxOf(pieceKey);
    const bad = firstBadSlice(ctx, stream);
    return bad === undefined
      ? { kind: 'ok' }
      : { kind: 'badPiece', index: bad };
  }

  // --- protocol 5: torrent ops (BUILD_M1 §B.6) -----------------------------

  async btBuild(q: BtBuildRequest): Promise<BtBuildResult> {
    checkSize('channel', q.channel, GROUP_ID_BYTES);
    checkSize('author', q.author, ACI_BYTES);
    checkSize('nonce', q.nonce, NONCE_BYTES);
    return btBuild(q);
  }

  async btFile(pieceKey: ChatKey): Promise<BtFileResult> {
    const ctx = this.#ctxOf(pieceKey);
    if (!equalBytes(ctx.header.app, utf8(APP_TORRENT))) {
      return badApp('wrongApp');
    }
    const m = parseTorrentManifest(ctx.desc.manifest);
    if (m === undefined || m.len !== ctx.desc.len) {
      return badApp('descriptor');
    }
    if (!safeComponent(m.name)) {
      return { kind: 'badName' };
    }
    return { kind: 'ok', name: m.name, len: m.len };
  }

  // --- protocol 5: git ops (BUILD_M1 §B.7, ./gitStub.node.ts) --------------

  async gitPrepare(q: GitPrepareRequest): Promise<GitPrepareResult> {
    checkSize('signal group', q.signalGroup, GROUP_ID_BYTES);
    checkSize('author', q.author, ACI_BYTES);
    checkSize('nonce', q.nonce, NONCE_BYTES);
    this.#channelOpen(q.channelKey);
    const store = this.#chats.peek(q.channelKey);
    if (store === undefined) {
      throw new ZrdtBackendError('unknownChat', `no channel ${q.channelKey}`);
    }
    return gitPrepare(store, q);
  }

  async gitObjects(
    pieceKey: ChatKey,
    stream: Bytes
  ): Promise<GitObjectsResult> {
    return gitObjects(this.#ctxOf(pieceKey), stream);
  }

  async gitView(
    signalGroup: Bytes,
    channelKey: ChatKey,
    repo: string,
    helds: ReadonlyArray<ServeHeld>
  ): Promise<GitViewResult> {
    checkSize('signal group', signalGroup, GROUP_ID_BYTES);
    this.#channelOpen(channelKey);
    const store = this.#chats.peek(channelKey);
    if (store === undefined) {
      throw new ZrdtBackendError('unknownChat', `no channel ${channelKey}`);
    }
    return gitView(store, signalGroup, repo, helds);
  }
}

/** Re-exported for the tests: a record's encoding. */
export { encodeRecord };
