// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The app transport's core (zrdt docs/apps/BUILD_M1.md §B.9; docs/zrdt/
// FORK_MAP.md §2-§5): channels, publishing, receiving Content 205, fetching
// pieces, repair (both sides), and the git desk behind the endpoint's routes.
// It holds no Signal code: ./transport.preload.ts injects Signal (groups,
// sends, the CDN) and the zrdt service, and tests inject fakes, so the whole
// flow runs in node against the protocol-5 stub.
//
// The host's duties (BUILD_M1 §H), and where they are kept:
// - upload exactly the stream's slices, with fresh keys (`#upload`);
// - pass field 205 as received to COMMIT (`receive`);
// - keep app openings for good (`OpeningStore`, before `receive` returns);
// - send to recipients ⊆ seats (`#freezeAndSend`);
// - never let the sendLog retry Content 205 (the Signal side's send type);
// - re-check members and keys at freeze (`#freezeAndSend`);
// - share only from the fork's dialog (`#confirm`);
// - write only checked bytes (`stream()` returns what PIECE_ACCEPT took);
// - extract (i, bytes) from repair openings (`pieceOfOpening`; a mistake
//   there only refuses).

import { randomBytes } from 'node:crypto';

import type {
  AppSeat,
  Bytes,
  Digest,
  GitPrepareRequest,
  GitPrepareResult,
  ServeEntry,
  ServeHeld,
  ServeReply,
  ServeRequest,
  ZrdtAppsOps,
} from '../ZrdtBackend.std.ts';
import type {
  ZrdtAcceptOutcome,
  ZrdtServiceType,
} from '../serviceCore.node.ts';
import { aciHex, aciStringHex, parseAudience } from '../audience.std.ts';
import { encodeServeEntries } from '../backends/codec.std.ts';
import { drop } from '../../util/drop.std.ts';
import type { Seat } from '../audience.std.ts';
import { ServeRequestBook } from '../serveRequests.std.ts';
import type {
  Announcement,
  AnnouncementState,
  AppEvent,
  AppGroup,
  AppMember,
  AppTag,
  AppsApi,
  ChannelHandle,
  ConfirmHandler,
  ConfirmRequest,
  PublishResult,
  RepairStatus,
  Route,
  TorrentPublishRequest,
} from './api.std.ts';
import {
  APP_GIT,
  APP_TORRENT,
  CHANNEL_OF,
  MAX_CONTENT_BYTES,
  PIECE_EXP,
  appOfOpening,
  compareStrings,
  fromHex,
  fromUtf8,
  isAppTag,
  metaOfAppMessage,
  parseAppHeader,
  routeOfAppMessage,
  toHex,
  zrdtAppMessageBytes,
  zrdtMetaBytes,
} from './appMessage.std.ts';
import { channelKeyOf } from './channels.std.ts';
import { parseBody } from './gitBody.std.ts';
import type { GitBody } from './gitBody.std.ts';
import { GitObjectStore, repoState } from './gitFetch.std.ts';
import type { HeldGitRecord, RepoStateJson } from './gitFetch.std.ts';
import type { GitDesk, GitPushOutcome, GitPushPlan } from './gitRoutes.std.ts';
import { refusalOf } from './gitRoutes.std.ts';
import type { PointerShape } from './pieces.std.ts';
import {
  PieceProgress,
  checkPointers,
  pieceOfOpening,
  slicePieces,
} from './pieces.std.ts';
import {
  RepairPlan,
  checkRepairRequest,
  readRepairTimeoutMs,
} from './repair.std.ts';

/** A torrent fetches on its own only up to this size (T-M4). */
export const AUTO_FETCH_MAX_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// What the host needs from Signal, the CDN and storage
// ---------------------------------------------------------------------------

/** A member of a group, with the identity key this device holds for it. */
export type HostMember = Readonly<{
  aci: string;
  name: string;
  /** The 33-byte identity key, if this device has one (else not seated). */
  key?: Bytes;
}>;

/** A Signal group, as the host needs it. */
export type HostGroup = Readonly<{
  conversationId: string;
  title: string;
  /** The group's 32-byte id: the Signal group of CHANNEL. */
  groupId: Bytes;
  /** The GroupContextV2 bytes (Content 205's field 15). */
  groupV2: Bytes;
  /** The current members, this account included. */
  members: ReadonlyArray<HostMember>;
}>;

/** A downloaded piece, or why not. */
export type Downloaded =
  | Readonly<{ kind: 'ok'; bytes: Bytes }>
  /** The CDN has no object (404). */
  | Readonly<{ kind: 'missing' }>
  /** Signal's attachment check failed (bad MAC or digest). */
  | Readonly<{ kind: 'bad'; message: string }>
  | Readonly<{ kind: 'error'; message: string }>;

/** The CDN: fresh-key uploads, pointers, downloads (FORK_MAP §4). */
export type HostCdn<P> = Readonly<{
  upload(piece: Bytes): Promise<P>;
  /** `ZrdtPointers { repeated AttachmentPointer pieces = 1; }`. */
  encodePointers(pointers: ReadonlyArray<P>): Bytes;
  decodePointers(
    bytes: Bytes
  ): Array<Readonly<{ shape: PointerShape; pointer: P }>> | undefined;
  /** Downloads and decrypts one piece; never more than `size` plaintext bytes. */
  download(pointer: P, size: number): Promise<Downloaded>;
}>;

/**
 * A ZrdtServeRequest of the apps: a piece repair (`announcement`, A's
 * digest, and the wanted piece digests, per-digest), or a channel catch-up
 * (`channel`, the channel id, with `since`: JOIN §6 on an app channel).
 */
export type RepairRequestMessage = Readonly<{
  groupId: Bytes;
  requestId: Bytes;
  announcement?: Bytes;
  channel?: Bytes;
  wanted: ReadonlyArray<Digest>;
  since?: ReadonlyArray<Digest>;
}>;

export type HostSignal = Readonly<{
  ourAci(): string | undefined;
  ourKey(): Bytes | undefined;
  groups(): Promise<ReadonlyArray<HostGroup>>;
  group(conversationId: string): Promise<HostGroup | undefined>;
  /** A display name for an ACI (sync: for status lines and events). */
  memberName(aci: string): string;
  /** Sends Content 205 to the recipients (a group send the sendLog does not keep). */
  sendApp(
    conversationId: string,
    appMessage: Bytes,
    recipients: ReadonlyArray<string>
  ): Promise<void>;
  sendRepairRequest(
    toAci: string,
    request: RepairRequestMessage
  ): Promise<void>;
  /** Seals SERVE's reply to `key` and sends it 1:1 (inline, or on the CDN when large). */
  sendRepairReply(
    toAci: string,
    groupId: Bytes,
    reply: ServeReply,
    key: Bytes
  ): Promise<void>;
}>;

/** App openings, kept for good (BUILD_M1 §H). */
export type OpeningStore = Readonly<{
  put(key: string, digest: Digest, opening: Bytes): Promise<void>;
  all(key: string): Promise<Array<ServeHeld>>;
}>;

/** The zrdt service calls the host makes on channel stores. */
export type HostStores = Pick<
  ZrdtServiceType,
  | 'ensureConversation'
  | 'acceptOwn'
  | 'acceptIncoming'
  | 'heads'
  | 'has'
  | 'get'
  | 'linkable'
  | 'classify'
  | 'audience'
  | 'boundary'
  | 'startRelative'
  | 'closeRelative'
  | 'acceptView'
  | 'serve'
>;

/** The protocol-5 ops, and the protocol-4 ops the host runs on piece keys. */
export type HostApps = ZrdtAppsOps &
  Readonly<{
    serve(request: ServeRequest): Promise<ServeReply>;
    close(chat: string): Promise<void>;
  }>;

export type HostDeps<P> = Readonly<{
  stores: HostStores;
  /** The app ops, or undefined while zrdtd speaks protocol 4. */
  apps: () => HostApps | undefined;
  signal: HostSignal;
  cdn: HostCdn<P>;
  openings: OpeningStore;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  log?: Readonly<{
    info: (message: string) => void;
    warn: (message: string) => void;
  }>;
  /** The piece size exponent (20 on hosts; tests use 10). */
  pieceExp?: number;
  /** Demo only: flip a byte of every piece this device serves (Dave). */
  tamperServed?: () => boolean;
  /** Registers routes on the endpoint (the transport passes its endpoint's). */
  registerRoutes?: (app: AppTag, routes: ReadonlyArray<Route>) => void;
}>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type AnnouncementRec = {
  digest: string;
  digestBytes: Digest;
  record: Bytes;
  opening: Bytes;
  conversationId: string;
  channelKey: string;
  app: AppTag;
  authorAci: string;
  provenance: Announcement['provenance'];
  receivedAt: number;
  seq: number;
  state: AnnouncementState;
  reason?: string;
  seats: ReadonlyArray<Seat>;
  bound?: {
    len: number;
    exp: number;
    ordered: ReadonlyArray<Digest>;
    body: Bytes;
    manifest: Bytes;
    pointers: Bytes;
  };
  progress?: PieceProgress;
  /** The bytes PIECE_ACCEPT took, by index (what a responder serves). */
  pieces: Map<number, Bytes>;
  repair?: RepairPlan;
  /** Repair request ids (hex) → the plan's ask id. */
  asks: Map<string, number>;
  waiters: Array<() => void>;
  fetching?: Promise<void>;
};

/** One of this device's app SERVE requests, for the §4.4 checks. */
type RepairBookEntry =
  | Readonly<{ kind: 'pieces'; digest: string; askId: number }>
  | Readonly<{ kind: 'channel'; channelKey: string }>;

/** A record that arrived before its links (waits in zrdt_pending). */
type Waiting = Readonly<{
  digest: Digest;
  conversationId: string;
  channelKey: string;
  app: AppTag;
  authorAci: string;
  opening: Bytes;
  hasDescriptor: boolean;
}>;

function hexToAciString(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function aciBytes(aci: string): Bytes {
  const out = fromHex(aciStringHex(aci));
  if (out === undefined || out.length !== 16) {
    throw new Error(`zrdt apps: not an ACI: ${aci}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export class AppsHost<P> implements AppsApi {
  readonly #deps: HostDeps<P>;
  readonly #announcements = new Map<string, AnnouncementRec>();
  readonly #channels = new Map<string, ChannelHandle>();
  readonly #gitObjects = new Map<string, GitObjectStore>();
  readonly #listeners = new Set<(event: AppEvent) => void>();
  readonly #repairBook = new ServeRequestBook();
  readonly #repairAsks = new Map<string, RepairBookEntry>();
  readonly #waiting = new Map<string, Waiting>();
  #confirm: ConfirmHandler | undefined;
  #seq = 0;

  constructor(deps: HostDeps<P>) {
    this.#deps = deps;
  }

  // --- helpers -------------------------------------------------------------

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #exp(): number {
    return this.#deps.pieceExp ?? PIECE_EXP;
  }

  #log(message: string): void {
    this.#deps.log?.info(`zrdt apps: ${message}`);
  }

  #warn(message: string): void {
    this.#deps.log?.warn(`zrdt apps: ${message}`);
  }

  #apps(): HostApps {
    const apps = this.#deps.apps();
    if (apps === undefined) {
      throw new Error('zrdtd does not speak protocol 5');
    }
    return apps;
  }

  /** Runs `fn` in the background; a failure is logged, never thrown. */
  #background(what: string, fn: () => Promise<void>): void {
    drop(
      (async () => {
        try {
          await fn();
        } catch (error) {
          this.#warn(`${what} failed: ${String(error)}`);
        }
      })()
    );
  }

  #emit(event: AppEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#warn(`listener threw: ${String(error)}`);
      }
    }
  }

  #self(): { aci: string; aciBytes: Bytes; key: Bytes } {
    const aci = this.#deps.signal.ourAci();
    const key = this.#deps.signal.ourKey();
    if (aci === undefined || key === undefined) {
      throw new Error('not linked');
    }
    return { aci, aciBytes: aciBytes(aci), key };
  }

  async #group(conversationId: string): Promise<HostGroup> {
    const g = await this.#deps.signal.group(conversationId);
    if (g === undefined) {
      throw new Error(`no group ${conversationId}`);
    }
    return g;
  }

  #member(g: HostGroup | undefined, aci: string): AppMember {
    const hex = aciStringHex(aci);
    const m = g?.members.find(x => aciStringHex(x.aci) === hex);
    const ours = this.#deps.signal.ourAci();
    return {
      aci,
      name: m?.name ?? this.#deps.signal.memberName(aci),
      self: ours !== undefined && aciStringHex(ours) === hex,
    };
  }

  #appGroup(g: HostGroup): AppGroup {
    return {
      conversationId: g.conversationId,
      title: g.title,
      members: g.members.map(m => this.#member(g, m.aci)),
    };
  }

  #toAnnouncement(a: AnnouncementRec): Announcement {
    const author = this.#member(undefined, a.authorAci);
    return {
      digest: a.digest,
      conversationId: a.conversationId,
      app: a.app,
      author,
      provenance: a.provenance,
      status: 'confirmedByAuthor',
      receivedAt: a.receivedAt,
      state: a.state,
      ...(a.reason === undefined ? {} : { reason: a.reason }),
      ...(a.bound === undefined
        ? {}
        : {
            len: a.bound.len,
            exp: a.bound.exp,
            pieces: a.bound.ordered.length,
            checked: a.progress?.summary().ok ?? 0,
            body: a.bound.body,
            manifest: a.bound.manifest,
          }),
    };
  }

  #setState(
    a: AnnouncementRec,
    state: AnnouncementState,
    reason?: string
  ): void {
    // oxlint-disable-next-line no-param-reassign
    a.state = state;
    if (reason !== undefined) {
      // oxlint-disable-next-line no-param-reassign
      a.reason = reason;
    }
    this.#emit({ type: 'announcement', announcement: this.#toAnnouncement(a) });
    if (state === 'complete' || state === 'failed' || state === 'notSeated') {
      for (const w of a.waiters.splice(0)) {
        w();
      }
    }
  }

  // --- AppsApi -------------------------------------------------------------

  available(): boolean {
    return this.#deps.apps() !== undefined;
  }

  async groups(): Promise<ReadonlyArray<AppGroup>> {
    return (await this.#deps.signal.groups()).map(g => this.#appGroup(g));
  }

  async findGroup(alias: string): Promise<AppGroup | undefined> {
    const ours = this.#deps.signal.ourAci();
    const g = (await this.#deps.signal.groups()).find(
      x => x.title === alias || x.conversationId === alias
    );
    if (
      g === undefined ||
      ours === undefined ||
      !g.members.some(m => aciStringHex(m.aci) === aciStringHex(ours))
    ) {
      return undefined;
    }
    return this.#appGroup(g);
  }

  async openChannel(
    conversationId: string,
    app: AppTag
  ): Promise<ChannelHandle> {
    const cached = this.#channels.get(`${app}\u0000${conversationId}`);
    if (cached !== undefined) {
      return cached;
    }
    const g = await this.#group(conversationId);
    const r = await this.#apps().channel(g.groupId, app, CHANNEL_OF[app]);
    if (r.kind !== 'ok') {
      throw new Error(`CHANNEL refused: ${r.reason}`);
    }
    const channelKey = channelKeyOf(conversationId, r.channel);
    const handle: ChannelHandle = {
      conversationId,
      app,
      channelKey,
      channelId: toHex(r.channel),
    };
    this.#channels.set(`${app}\u0000${conversationId}`, handle);
    // A channel this device has no store for starts relative and catches
    // up from a member (JOIN §6.1 on the channel): a newcomer gets the
    // history before him as boundary digests; a founder's empty reply
    // closes the store again.
    const hadStore = (await this.#deps.stores.heads(channelKey)).length > 0;
    const mode = await this.#deps.stores.startRelative(channelKey, r.channel);
    if (mode === 'relative' && !hadStore) {
      this.#background('channel catch-up', () => this.#catchUp(handle, g));
    }
    return handle;
  }

  /** Asks one other current member for the channel's view (catch-up mode). */
  async #catchUp(
    channel: ChannelHandle,
    g: HostGroup,
    preferAci?: string
  ): Promise<void> {
    const self = this.#deps.signal.ourAci();
    const others = g.members.filter(
      m => self === undefined || aciStringHex(m.aci) !== aciStringHex(self)
    );
    const to =
      others.find(
        m =>
          preferAci !== undefined &&
          aciStringHex(m.aci) === aciStringHex(preferAci)
      ) ?? others[0];
    if (to === undefined) {
      return;
    }
    const requestId = new Uint8Array(randomBytes(16));
    const rid = toHex(requestId);
    this.#repairAsks.set(rid, {
      kind: 'channel',
      channelKey: channel.channelKey,
    });
    this.#repairBook.add({
      requestId: rid,
      conversationId: channel.conversationId,
      responderAci: to.aci,
      responderKey: to.key === undefined ? undefined : toHex(to.key),
      mode: 'catchup',
      digests: [],
      sentAt: this.#now(),
    });
    const since = await this.#deps.stores.heads(channel.channelKey);
    await this.#deps.signal.sendRepairRequest(to.aci, {
      groupId: g.groupId,
      requestId,
      channel: fromHex(channel.channelId) ?? new Uint8Array(32),
      wanted: [],
      since,
    });
    this.#log(`asked ${to.name} to catch up channel ${channel.app}`);
  }

  async announcements(
    conversationId: string,
    app: AppTag
  ): Promise<ReadonlyArray<Announcement>> {
    return [...this.#announcements.values()]
      .filter(a => a.conversationId === conversationId && a.app === app)
      .sort((a, b) => a.seq - b.seq)
      .map(a => this.#toAnnouncement(a));
  }

  async fetchPieces(
    digest: string,
    options: Readonly<{ click?: boolean }> = {}
  ): Promise<Announcement> {
    const a = this.#announcements.get(digest);
    if (a === undefined) {
      throw new Error(`no announcement ${digest}`);
    }
    if (a.state === 'needsClick' && options.click === true) {
      this.#startFetch(a, true);
    }
    if (
      a.state !== 'complete' &&
      a.state !== 'failed' &&
      a.state !== 'notSeated' &&
      a.state !== 'needsClick'
    ) {
      await new Promise<void>(resolve => {
        a.waiters.push(resolve);
      });
    }
    return this.#toAnnouncement(a);
  }

  async stream(digest: string): Promise<Bytes | undefined> {
    const a = this.#announcements.get(digest);
    if (a?.state !== 'complete' || a.bound === undefined) {
      return undefined;
    }
    return this.#checkedStream(a);
  }

  /** The stream from the bytes PIECE_ACCEPT took. */
  #checkedStream(a: AnnouncementRec): Bytes {
    const out = new Uint8Array(a.bound?.len ?? 0);
    const size = 2 ** (a.bound?.exp ?? 0);
    for (const [i, bytes] of a.pieces) {
      out.set(bytes, i * size);
    }
    return out;
  }

  async assemble(digest: string, stream: Bytes): Promise<boolean> {
    const r = await this.#apps().assemble(digest, stream);
    return r.kind === 'ok';
  }

  repairStatus(digest: string): RepairStatus | undefined {
    const a = this.#announcements.get(digest);
    const plan = a?.repair;
    if (a === undefined || plan === undefined) {
      return undefined;
    }
    const name = (aci: string) => this.#deps.signal.memberName(aci);
    return {
      digest,
      pieces: plan
        .pieces()
        .map(p =>
          p.member === undefined || p.member === ''
            ? { index: p.index, state: p.state }
            : { index: p.index, state: p.state, member: name(p.member) }
        ),
      failedChecks: plan
        .failedChecks()
        .map(f => ({ index: f.index, member: name(f.member) })),
      dropped: plan.dropped().map(name),
    };
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  registerConfirm(handler: ConfirmHandler): void {
    this.#confirm = handler;
  }

  registerRoutes(app: AppTag, routes: ReadonlyArray<Route>): void {
    if (this.#deps.registerRoutes === undefined) {
      throw new Error('no endpoint');
    }
    this.#deps.registerRoutes(app, routes);
  }

  async #ask(request: ConfirmRequest): Promise<boolean> {
    if (this.#confirm === undefined) {
      this.#warn('no share dialog is registered: declined');
      return false;
    }
    return this.#confirm(request);
  }

  // --- the author (BUILD_M1 §B.9 "Author") ---------------------------------

  async #audience(g: HostGroup): Promise<Bytes> {
    const self = this.#self();
    const members = g.members.map(m => {
      if (aciStringHex(m.aci) === aciHex(self.aciBytes)) {
        return { aci: self.aciBytes, key: self.key };
      }
      return m.key === undefined
        ? { aci: aciBytes(m.aci) }
        : { aci: aciBytes(m.aci), key: m.key };
    });
    if (!members.some(m => aciHex(m.aci) === aciHex(self.aciBytes))) {
      throw new Error('this account is not a member');
    }
    const audience = await this.#deps.stores.audience(members);
    if (audience === 'tooLarge') {
      throw new Error('the group has more than 256 members');
    }
    return audience;
  }

  async #upload(stream: Bytes): Promise<Bytes> {
    const pointers = new Array<P>();
    for (const piece of slicePieces(stream, this.#exp())) {
      // Fresh keys for every piece, never Desktop's reuse cache.
      // oxlint-disable-next-line no-await-in-loop
      pointers.push(await this.#deps.cdn.upload(piece));
    }
    return this.#deps.cdn.encodePointers(pointers);
  }

  /**
   * The freeze (BUILD_M1 §B.9 "Author" 3): AUDIENCE, build, COMMIT and
   * ACCEPT into the channel, a re-check of members and keys (restart if they
   * changed), then the send to recipients ⊆ seats. `build` returns A's
   * committed bytes for an audience, or a refusal to report.
   */
  async #freezeAndSend<R>(
    channel: ChannelHandle,
    build: (audience: Bytes) => Promise<{ message: Bytes } | { refused: R }>
  ): Promise<
    | {
        kind: 'sent';
        digest: Digest;
        record: Bytes;
        opening: Bytes;
        audience: Bytes;
      }
    | { kind: 'refused'; refused: R }
  > {
    const self = this.#self();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const g = await this.#group(channel.conversationId);
      // oxlint-disable-next-line no-await-in-loop
      const audience = await this.#audience(g);
      // oxlint-disable-next-line no-await-in-loop
      const built = await build(audience);
      if ('refused' in built) {
        return { kind: 'refused', refused: built.refused };
      }
      const channelId = fromHex(channel.channelId) ?? new Uint8Array(32);
      // oxlint-disable-next-line no-await-in-loop
      const links = await this.#deps.stores.linkable(channel.channelKey);
      const nonce = new Uint8Array(randomBytes(32));
      const bytes205 = zrdtAppMessageBytes({
        groupV2: g.groupV2,
        meta: zrdtMetaBytes(links, nonce),
        committed: built.message,
      });
      if (bytes205.length > MAX_CONTENT_BYTES) {
        throw new Error('Content 205 would be over 64 KiB');
      }
      // Members and keys again: a change restarts the job (T-M1, G-M1).
      // oxlint-disable-next-line no-await-in-loop
      const again = await this.#audience(
        // oxlint-disable-next-line no-await-in-loop
        await this.#group(channel.conversationId)
      );
      if (toHex(again) !== toHex(audience)) {
        this.#log('members or keys changed during the freeze: again');
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const own = await this.#deps.stores.acceptOwn(channel.channelKey, {
        groupId: channelId,
        authorAci: self.aciBytes,
        nonce,
        dataMessageBytes: bytes205,
        links: links.map(l => new Uint8Array(l)),
      });
      // oxlint-disable-next-line no-await-in-loop
      await this.#deps.openings.put(
        channel.channelKey,
        own.digest,
        own.opening
      );
      const seats = parseAudience(audience) ?? [];
      const recipients = g.members
        .filter(
          m =>
            aciStringHex(m.aci) !== aciHex(self.aciBytes) &&
            seats.some(s => s.seated && aciHex(s.aci) === aciStringHex(m.aci))
        )
        .map(m => m.aci);
      // oxlint-disable-next-line no-await-in-loop
      await this.#deps.signal.sendApp(
        channel.conversationId,
        bytes205,
        recipients
      );
      this.#log(
        `sent ${channel.app} record ${toHex(own.digest).slice(0, 8)} to ${recipients.length}`
      );
      return {
        kind: 'sent',
        digest: own.digest,
        record: own.record,
        opening: own.opening,
        audience,
      };
    }
    throw new Error('members kept changing during the freeze');
  }

  /** Binds the author's own A like a receiver, from the local bytes (§B.9 Author 4). */
  async #bindOwn(
    channel: ChannelHandle,
    sent: { digest: Digest; record: Bytes; opening: Bytes },
    stream: Bytes
  ): Promise<AnnouncementRec> {
    const self = this.#self();
    const a = this.#remember({
      digestBytes: sent.digest,
      record: sent.record,
      opening: sent.opening,
      conversationId: channel.conversationId,
      channelKey: channel.channelKey,
      app: channel.app,
      authorAci: self.aci,
      provenance: 'self',
    });
    if (stream.length === 0) {
      this.#gitStore(channel.channelKey).addEmptyRecord(a.digest);
      this.#setState(a, 'complete');
      return a;
    }
    if (!(await this.#bind(a))) {
      return a;
    }
    const pieces = slicePieces(stream, a.bound?.exp ?? this.#exp());
    for (const [i, piece] of pieces.entries()) {
      // oxlint-disable-next-line no-await-in-loop
      await this.#acceptPiece(a, i, piece, 'local');
    }
    await this.#complete(a);
    return a;
  }

  async publish(request: TorrentPublishRequest): Promise<PublishResult> {
    const g = await this.#group(request.conversationId);
    const members = g.members.map(m => this.#member(g, m.aci));
    const yes = await this.#ask({
      kind: 'torrentShare',
      group: g.title,
      name: request.name,
      size: request.stream.length,
      members,
    });
    if (!yes) {
      return { kind: 'declined' };
    }
    const channel = await this.openChannel(request.conversationId, APP_TORRENT);
    const self = this.#self();
    const apps = this.#apps();
    const storeNonce = new Uint8Array(randomBytes(32));
    const pointers = await this.#upload(request.stream);
    const sent = await this.#freezeAndSend(channel, async audience => {
      const r = await apps.btBuild({
        channel: fromHex(channel.channelId) ?? new Uint8Array(32),
        author: self.aciBytes,
        nonce: storeNonce,
        exp: this.#exp(),
        audience,
        name: request.name,
        pointers,
        stream: request.stream,
      });
      return r.kind === 'ok'
        ? { message: r.message }
        : { refused: r.kind === 'badName' ? 'badName' : r.reason };
    });
    if (sent.kind === 'refused') {
      return {
        kind: 'refused',
        reason: String(sent.refused),
        message: `BT_BUILD refused: ${String(sent.refused)}`,
      };
    }
    await this.#bindOwn(channel, sent, request.stream);
    const seats = parseAudience(sent.audience) ?? [];
    return {
      kind: 'ok',
      digest: toHex(sent.digest),
      audience: members.filter(m =>
        seats.some(s => s.seated && aciHex(s.aci) === aciStringHex(m.aci))
      ),
    };
  }

  // --- the receiver (BUILD_M1 §B.9 "Receiver") -----------------------------

  #remember(
    x: Pick<
      AnnouncementRec,
      | 'record'
      | 'opening'
      | 'conversationId'
      | 'channelKey'
      | 'app'
      | 'authorAci'
      | 'provenance'
    > & { digestBytes: Digest }
  ): AnnouncementRec {
    const digest = toHex(x.digestBytes);
    const existing = this.#announcements.get(digest);
    if (existing !== undefined) {
      return existing;
    }
    const header = appOfOpening(x.opening);
    this.#seq += 1;
    const a: AnnouncementRec = {
      ...x,
      digest,
      receivedAt: this.#now(),
      seq: this.#seq,
      state: 'received',
      seats: header ? (parseAudience(header.audience) ?? []) : [],
      pieces: new Map(),
      asks: new Map(),
      waiters: [],
    };
    this.#announcements.set(digest, a);
    this.#emit({ type: 'announcement', announcement: this.#toAnnouncement(a) });
    return a;
  }

  /**
   * A decrypted Content 205 (FORK_MAP §3.2). `bytes` is field 205 exactly as
   * received. Everything that must survive a crash (the record, its opening)
   * is stored before this returns; the fetch runs after.
   */
  async receive({
    conversationId,
    senderAci,
    bytes,
  }: Readonly<{
    conversationId: string;
    senderAci: string;
    bytes: Bytes;
  }>): Promise<void> {
    const g = await this.#deps.signal.group(conversationId);
    const self = this.#deps.signal.ourAci();
    if (g === undefined || self === undefined) {
      this.#warn('an app message for a group we are not in: ignored');
      return;
    }
    const isMember = (aci: string) =>
      g.members.some(m => aciStringHex(m.aci) === aciStringHex(aci));
    if (!isMember(self) || !isMember(senderAci)) {
      this.#warn(`an app message from ${senderAci}, not a member: ignored`);
      return;
    }
    const route = routeOfAppMessage(bytes);
    if (
      route === undefined ||
      !isAppTag(route.app) ||
      route.channel !== CHANNEL_OF[route.app]
    ) {
      this.#warn(
        'an app message for an app or channel this client does not run: ignored'
      );
      return;
    }
    const meta = metaOfAppMessage(bytes);
    if (meta === undefined) {
      this.#warn('an app message without links and nonce: ignored');
      return;
    }
    const channel = await this.openChannel(conversationId, route.app);
    const outcome: ZrdtAcceptOutcome = await this.#deps.stores.acceptIncoming(
      channel.channelKey,
      {
        groupId: fromHex(channel.channelId) ?? new Uint8Array(32),
        authorAci: aciBytes(senderAci),
        nonce: meta.nonce,
        dataMessageBytes: bytes,
        links: meta.links,
        provenance: { kind: 'live' },
      }
    );
    if (outcome.status !== 'accepted' && outcome.status !== 'missing') {
      this.#warn(`an app record was refused: ${outcome.status}`);
      return;
    }
    if (outcome.opening === undefined || outcome.digest === undefined) {
      return;
    }
    await this.#deps.openings.put(
      channel.channelKey,
      outcome.digest,
      outcome.opening
    );
    if (outcome.status === 'missing') {
      // A gap in the channel: the record waits in zrdt_pending until its
      // links arrive; a catch-up from its author brings them (or their
      // digests, for a newcomer), and #takeWaiting picks the record up.
      this.#waiting.set(toHex(outcome.digest), {
        digest: outcome.digest,
        conversationId,
        channelKey: channel.channelKey,
        app: route.app,
        authorAci: senderAci,
        opening: outcome.opening,
        hasDescriptor: route.header.descriptor !== undefined,
      });
      this.#log(`an app record waits for ${outcome.digests.length} link(s)`);
      this.#background('channel catch-up', () =>
        this.#catchUp(channel, g, senderAci)
      );
      return;
    }
    this.#take(
      {
        digest: outcome.digest,
        conversationId,
        channelKey: channel.channelKey,
        app: route.app,
        authorAci: senderAci,
        opening: outcome.opening,
        hasDescriptor: route.header.descriptor !== undefined,
      },
      outcome.record,
      'live'
    );
    await this.#takeWaiting(channel.channelKey);
  }

  /** A stored announcement: remember it and fetch (or apply a git push with no objects). */
  #take(
    w: Waiting,
    record: Bytes,
    provenance: Announcement['provenance']
  ): void {
    const known = this.#announcements.has(toHex(w.digest));
    const a = this.#remember({
      digestBytes: w.digest,
      record,
      opening: w.opening,
      conversationId: w.conversationId,
      channelKey: w.channelKey,
      app: w.app,
      authorAci: w.authorAci,
      provenance,
    });
    if (known) {
      return;
    }
    if (!w.hasDescriptor) {
      // A git push with no objects: applied at once.
      this.#gitStore(w.channelKey).addEmptyRecord(a.digest);
      this.#setState(a, 'complete');
      this.#emit({ type: 'complete', digest: a.digest, app: a.app });
      return;
    }
    this.#startFetch(a, false);
  }

  /** Records that waited for links and are stored now. */
  async #takeWaiting(channelKey: string): Promise<void> {
    for (const [hex, w] of [...this.#waiting]) {
      if (w.channelKey !== channelKey) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      if (await this.#deps.stores.has(channelKey, w.digest)) {
        this.#waiting.delete(hex);
        // The record's encoding: group (the channel) ‖ commit ‖ links ‖ author,
        // read back from the store.
        // oxlint-disable-next-line no-await-in-loop
        const record = await this.#recordOf(channelKey, w.digest);
        if (record !== undefined) {
          this.#take(w, record, 'live');
        }
      }
    }
  }

  async #recordOf(
    channelKey: string,
    digest: Digest
  ): Promise<Bytes | undefined> {
    const got = await this.#deps.stores.get(channelKey, digest);
    return got?.record;
  }

  #startFetch(a: AnnouncementRec, clicked: boolean): void {
    if (a.fetching !== undefined) {
      return;
    }
    const run = async (): Promise<void> => {
      try {
        await this.#fetch(a, clicked);
      } catch (error) {
        this.#warn(`fetch of ${a.digest.slice(0, 8)} failed: ${String(error)}`);
        this.#setState(a, 'failed', String(error));
      } finally {
        // oxlint-disable-next-line no-param-reassign
        a.fetching = undefined;
      }
    };
    // oxlint-disable-next-line no-param-reassign
    a.fetching = run();
  }

  async #bind(a: AnnouncementRec): Promise<boolean> {
    const self = this.#self();
    const g = await this.#group(a.conversationId);
    const r = await this.#apps().piecesBind({
      pieceKey: a.digest,
      channelKey: a.channelKey,
      signalGroup: g.groupId,
      app: a.app,
      ownAci: self.aciBytes,
      ownKey: self.key,
      announcement: a.record,
      opening: a.opening,
    });
    if (r.kind === 'badApp' && r.reason === 'notSeated') {
      this.#setState(a, 'notSeated');
      return false;
    }
    if (r.kind !== 'ok') {
      this.#setState(
        a,
        'failed',
        r.kind === 'badApp' ? `BAD_APP ${r.reason}` : r.kind
      );
      return false;
    }
    // oxlint-disable-next-line no-param-reassign
    a.bound = {
      len: r.len,
      exp: r.exp,
      ordered: r.ordered,
      body: r.body,
      manifest: r.manifest,
      pointers: r.pointers,
    };
    // oxlint-disable-next-line no-param-reassign
    a.progress = new PieceProgress(r.ordered);
    return true;
  }

  async #acceptPiece(
    a: AnnouncementRec,
    index: number,
    bytes: Bytes,
    source: 'cdn' | 'local' | 'repair'
  ): Promise<boolean> {
    const r = await this.#apps().pieceAccept(a.digest, index, bytes);
    if (r.kind === 'ok') {
      a.pieces.set(index, bytes);
      a.progress?.set(index, 'ok');
      a.repair?.onChecked(index);
      return true;
    }
    if (source === 'cdn') {
      // The CDN bytes passed Signal's check: the author uploaded wrong bytes.
      a.progress?.set(index, 'authorBad');
      this.#emit({
        type: 'pieceFailedCheck',
        digest: a.digest,
        index,
        from: 'cdn',
      });
    }
    return false;
  }

  async #fetch(a: AnnouncementRec, clicked: boolean): Promise<void> {
    if (a.bound === undefined && !(await this.#bind(a))) {
      return;
    }
    const bound = a.bound;
    const progress = a.progress;
    if (bound === undefined || progress === undefined) {
      return;
    }
    if (a.app === APP_TORRENT && !clicked) {
      const status = (await this.#deps.stores.classify(a.channelKey)).get(
        a.digest
      );
      if (
        status?.kind !== 'confirmedByAuthor' ||
        bound.len > AUTO_FETCH_MAX_BYTES
      ) {
        this.#setState(a, 'needsClick');
        return;
      }
    }
    this.#setState(a, 'fetching');
    const pointers = this.#deps.cdn.decodePointers(bound.pointers);
    const shapes = pointers?.map(p => p.shape) ?? [];
    const fits = checkPointers(shapes, bound.exp, bound.len);
    if (pointers !== undefined && fits.ok) {
      for (const [i, { pointer, shape }] of pointers.entries()) {
        if (progress.state(i) === 'ok') {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        const got = await this.#deps.cdn.download(pointer, shape.size ?? 0);
        if (got.kind === 'ok') {
          // oxlint-disable-next-line no-await-in-loop
          await this.#acceptPiece(a, i, got.bytes, 'cdn');
        } else {
          progress.set(i, got.kind === 'missing' ? 'cdnMissing' : 'cdnBad');
          this.#log(`piece ${i} of ${a.digest.slice(0, 8)}: CDN ${got.kind}`);
        }
      }
    } else {
      this.#warn(`the pointers of ${a.digest.slice(0, 8)} are unusable`);
    }
    await this.#complete(a);
  }

  /** PIECES_COMPLETE; on MISSING, repair; on OK, the app's step. */
  async #complete(a: AnnouncementRec): Promise<void> {
    const r = await this.#apps().piecesComplete(a.digest);
    if (r.kind === 'missing') {
      a.progress?.markMissing(r.digests);
      if (a.state === 'repairing' && a.repair?.settled) {
        this.#setState(a, 'failed', 'no member could repair every piece');
        return;
      }
      await this.#startRepair(a);
      return;
    }
    if (r.kind !== 'accepted') {
      this.#setState(a, 'failed', `PIECES_COMPLETE: ${r.kind}`);
      return;
    }
    if (a.app === APP_GIT && a.bound !== undefined) {
      const out = this.#checkedStream(a);
      const objects = await this.#apps().gitObjects(a.digest, out);
      if (objects.kind !== 'ok') {
        this.#setState(a, 'failed', `GIT_OBJECTS: ${objects.kind}`);
        return;
      }
      this.#gitStore(a.channelKey).addRecord(a.digest, out, objects.objects);
    }
    this.#setState(a, 'complete');
    this.#emit({ type: 'complete', digest: a.digest, app: a.app });
  }

  // --- repair: the requester ------------------------------------------------

  async #repairMembers(a: AnnouncementRec): Promise<Array<string>> {
    const self = this.#deps.signal.ourAci();
    const g = await this.#deps.signal.group(a.conversationId);
    if (g === undefined || self === undefined) {
      return [];
    }
    const seated = a.seats
      .filter(s => s.seated && aciHex(s.aci) !== aciStringHex(self))
      .map(s => aciHex(s.aci));
    const current = g.members.filter(m => seated.includes(aciStringHex(m.aci)));
    const author = aciStringHex(a.authorAci);
    return [
      ...current.filter(m => aciStringHex(m.aci) === author),
      ...current.filter(m => aciStringHex(m.aci) !== author),
    ].map(m => m.aci);
  }

  async #startRepair(a: AnnouncementRec): Promise<void> {
    const needed = a.progress?.needRepair() ?? [];
    if (needed.length === 0) {
      return;
    }
    if (a.repair === undefined) {
      // oxlint-disable-next-line no-param-reassign
      a.repair = new RepairPlan({
        needed,
        members: await this.#repairMembers(a),
        timeoutMs: readRepairTimeoutMs(this.#deps.env ?? {}),
      });
    }
    this.#setState(a, 'repairing');
    await this.#pumpRepair(a);
  }

  async #pumpRepair(a: AnnouncementRec): Promise<void> {
    const plan = a.repair;
    const bound = a.bound;
    if (plan === undefined || bound === undefined) {
      return;
    }
    plan.expire(this.#now());
    if (plan.settled) {
      this.#emit({
        type: 'repair',
        status: this.repairStatus(a.digest) ?? emptyRepair(a.digest),
      });
      await this.#complete(a);
      return;
    }
    const g = await this.#group(a.conversationId);
    for (const ask of plan.next(this.#now())) {
      const requestId = new Uint8Array(randomBytes(16));
      const rid = toHex(requestId);
      a.asks.set(rid, ask.id);
      this.#repairAsks.set(rid, {
        kind: 'pieces',
        digest: a.digest,
        askId: ask.id,
      });
      const member = g.members.find(
        m => aciStringHex(m.aci) === aciStringHex(ask.member)
      );
      this.#repairBook.add({
        requestId: rid,
        conversationId: a.conversationId,
        responderAci: ask.member,
        responderKey: member?.key === undefined ? undefined : toHex(member.key),
        mode: 'perDigest',
        digests: ask.indices.map(i =>
          toHex(bound.ordered[i] ?? new Uint8Array())
        ),
        sentAt: this.#now(),
      });
      try {
        // oxlint-disable-next-line no-await-in-loop
        await this.#deps.signal.sendRepairRequest(ask.member, {
          groupId: g.groupId,
          requestId,
          announcement: a.digestBytes,
          wanted: ask.indices.map(i => bound.ordered[i] ?? new Uint8Array()),
        });
        this.#log(
          `asked ${ask.member.slice(0, 8)} for pieces ${ask.indices.join(',')} of ${a.digest.slice(0, 8)}`
        );
      } catch (error) {
        this.#warn(`repair request to ${ask.member} failed: ${String(error)}`);
        plan.onReply(ask.id, new Map());
      }
    }
    this.#emit({
      type: 'repair',
      status: this.repairStatus(a.digest) ?? emptyRepair(a.digest),
    });
    this.#scheduleRepairTick(a);
  }

  #scheduleRepairTick(a: AnnouncementRec): void {
    const deadline = a.repair?.nextDeadline();
    if (deadline === undefined) {
      return;
    }
    const delay = Math.max(0, deadline - this.#now()) + 5;
    setTimeout(() => {
      if (a.state === 'repairing') {
        this.#background('repair tick', () => this.#pumpRepair(a));
      }
    }, delay).unref?.();
  }

  /** Whether a request id is one of this device's piece repairs. */
  ownsRepairRequest(requestIdHex: string): boolean {
    return this.#repairAsks.has(requestIdHex);
  }

  /** The book the §4.4 checks run against for piece repairs. */
  repairBook(): ServeRequestBook {
    return this.#repairBook;
  }

  /**
   * A sealed reply to one of this device's piece repairs, opened and checked
   * (JOIN §4.4) by the Signal side. Each addressed entry's opening gives
   * (i, bytes) for PIECE_ACCEPT; a refused piece blames the responder.
   */
  async onRepairReply(
    responderAci: string,
    requestIdHex: string,
    entries: ReadonlyArray<ServeEntry>
  ): Promise<void> {
    const ask = this.#repairAsks.get(requestIdHex);
    if (ask === undefined) {
      return;
    }
    this.#repairAsks.delete(requestIdHex);
    if (ask.kind === 'channel') {
      await this.#onChannelServed(responderAci, ask.channelKey, entries);
      return;
    }
    const a = this.#announcements.get(ask.digest);
    if (a === undefined || a.repair === undefined) {
      return;
    }
    const outcomes = new Map<number, 'ok' | 'bad'>();
    for (const entry of entries) {
      if (entry.kind !== 'addressed' || entry.opening === undefined) {
        continue;
      }
      const piece = pieceOfOpening(entry.opening);
      if (piece === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const ok = await this.#acceptPiece(a, piece.index, piece.bytes, 'repair');
      outcomes.set(piece.index, ok ? 'ok' : 'bad');
      if (!ok) {
        this.#emit({
          type: 'pieceFailedCheck',
          digest: a.digest,
          index: piece.index,
          from: responderAci,
        });
        this.#warn(
          `piece ${piece.index} from ${responderAci.slice(0, 8)} failed its check`
        );
      }
    }
    a.repair.onReply(ask.askId, outcomes);
    if (a.progress?.done) {
      await this.#complete(a);
      return;
    }
    await this.#pumpRepair(a);
  }

  // --- repair: the responder ------------------------------------------------

  /**
   * A member's piece repair request (BUILD_M1 §B.9 "Responder"): a current
   * member (T-m11), the piece store by A's digest (T-m10), PIECE_OPENING for
   * each wanted piece this device holds, per-digest SERVE on the piece key,
   * then the JOIN seal (the Signal side). Returns the reply's entry count.
   */
  async onRepairRequest(
    requesterAci: string,
    requesterKey: Bytes | undefined,
    request: RepairRequestMessage
  ): Promise<number> {
    const g = (await this.#deps.signal.groups()).find(
      x => toHex(x.groupId) === toHex(request.groupId)
    );
    const isMember =
      g !== undefined &&
      g.members.some(m => aciStringHex(m.aci) === aciStringHex(requesterAci));
    if (request.channel !== undefined) {
      return this.#serveChannel(
        requesterAci,
        requesterKey,
        request,
        g,
        isMember
      );
    }
    const check = checkRepairRequest({
      isMember,
      announcement: request.announcement,
      wanted: request.wanted,
    });
    if (!check.ok || g === undefined || requesterKey === undefined) {
      this.#warn(
        `piece repair request from ${requesterAci} dropped: ${check.ok ? 'no key' : check.reason}`
      );
      return 0;
    }
    const a = this.#announcements.get(
      toHex(request.announcement ?? new Uint8Array())
    );
    if (a?.bound === undefined) {
      return 0;
    }
    const apps = this.#apps();
    const held = new Array<ServeHeld>();
    const ordered = a.bound.ordered.map(toHex);
    for (const want of request.wanted) {
      const index = ordered.indexOf(toHex(want));
      const bytes = index < 0 ? undefined : a.pieces.get(index);
      if (bytes === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const o = await apps.pieceOpening(a.digest, index, bytes);
      if (o.kind === 'ok') {
        held.push({ digest: want, opening: o.opening });
      }
    }
    const self = this.#self();
    let reply = await apps.serve({
      chat: a.digest,
      ownAci: self.aciBytes,
      requesterAci: aciBytes(requesterAci),
      key: requesterKey,
      requestId: request.requestId,
      since: [],
      ownSince: [],
      mode: 'perDigest',
      wanted: request.wanted,
      forExport: false,
      strict: false,
      live: [],
      disown: [],
      held,
    });
    if (this.#deps.tamperServed?.() === true) {
      reply = tamperReply(reply);
    }
    await this.#deps.signal.sendRepairReply(
      requesterAci,
      g.groupId,
      reply,
      requesterKey
    );
    return reply.entries.length;
  }

  // --- channel catch-up (JOIN §6 on an app channel) -------------------------

  /** A member's catch-up of an app channel: catch-up SERVE on the channel store. */
  async #serveChannel(
    requesterAci: string,
    requesterKey: Bytes | undefined,
    request: RepairRequestMessage,
    g: HostGroup | undefined,
    isMember: boolean
  ): Promise<number> {
    if (!isMember || g === undefined || requesterKey === undefined) {
      this.#warn(`channel catch-up from ${requesterAci} dropped`);
      return 0;
    }
    const channelHex = toHex(request.channel ?? new Uint8Array());
    let app: AppTag | undefined;
    for (const x of [APP_TORRENT, APP_GIT] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const r = await this.#apps().channel(g.groupId, x, CHANNEL_OF[x]);
      if (r.kind === 'ok' && toHex(r.channel) === channelHex) {
        app = x;
      }
    }
    if (app === undefined) {
      this.#warn(
        'a catch-up for a channel of no app this client runs: dropped'
      );
      return 0;
    }
    const channel = await this.openChannel(g.conversationId, app);
    const self = this.#self();
    const held = await this.#deps.openings.all(channel.channelKey);
    const reply = await this.#deps.stores.serve(channel.channelKey, {
      ownAci: self.aciBytes,
      requesterAci: aciBytes(requesterAci),
      key: requesterKey,
      requestId: request.requestId,
      since: request.since ?? [],
      ownSince: [],
      mode: 'catchup',
      wanted: [],
      forExport: false,
      strict: false,
      live: [],
      disown: [],
      held,
    });
    await this.#deps.signal.sendRepairReply(
      requesterAci,
      g.groupId,
      reply,
      requesterKey
    );
    return reply.entries.length;
  }

  async #onChannelServed(
    responderAci: string,
    channelKey: string,
    entries: ReadonlyArray<ServeEntry>
  ): Promise<void> {
    const results = await this.#deps.stores.acceptView(channelKey, {
      voucherAci: responderAci,
      forImport: false,
      mode: 'catchup',
      items: entries.map(entry => ({
        entry,
        provenance: { kind: 'relayed' as const, byAci: responderAci },
      })),
    });
    // Keep the openings the reply carried for records now stored, and take
    // the announcements among them (a record this device missed live).
    const channel = [...this.#channels.values()].find(
      c => c.channelKey === channelKey
    );
    for (const [i, entry] of entries.entries()) {
      const r = results[i]?.result;
      if (
        entry.kind !== 'addressed' ||
        entry.opening === undefined ||
        r?.kind !== 'ok'
      ) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await this.#deps.openings.put(channelKey, r.digest, entry.opening);
      const header = appOfOpening(entry.opening);
      if (
        channel !== undefined &&
        header !== undefined &&
        fromUtf8(header.app) === channel.app
      ) {
        this.#waiting.delete(toHex(r.digest));
        this.#take(
          {
            digest: r.digest,
            conversationId: channel.conversationId,
            channelKey,
            app: channel.app,
            authorAci: hexToAciString(toHex(entry.record.slice(-16))),
            opening: entry.opening,
            hasDescriptor: header.descriptor !== undefined,
          },
          entry.record,
          'relayed'
        );
      }
    }
    if (!entries.some(e => e.kind === 'boundary')) {
      await this.#deps.stores.closeRelative(channelKey);
    }
    this.#log(
      `channel caught up from ${responderAci.slice(0, 8)}: ${entries.length} entries`
    );
    await this.#takeWaiting(channelKey);
  }

  // --- git (the desk behind ENDPOINT.md's routes) --------------------------

  #gitStore(channelKey: string): GitObjectStore {
    let store = this.#gitObjects.get(channelKey);
    if (store === undefined) {
      store = new GitObjectStore();
      this.#gitObjects.set(channelKey, store);
    }
    return store;
  }

  async #heldGit(channel: ChannelHandle): Promise<{
    helds: Array<ServeHeld>;
    records: Array<HeldGitRecord & { body: GitBody }>;
  }> {
    const helds = await this.#deps.openings.all(channel.channelKey);
    const store = this.#gitStore(channel.channelKey);
    const records = new Array<HeldGitRecord & { body: GitBody }>();
    for (const h of helds) {
      const header = appOfOpening(h.opening);
      const body = header ? parseBody(header.body) : undefined;
      if (
        header === undefined ||
        body === undefined ||
        fromUtf8(header.app) !== APP_GIT
      ) {
        continue;
      }
      const digest = toHex(h.digest);
      const a = this.#announcements.get(digest);
      records.push({
        digest,
        seq: a?.seq ?? 0,
        authorAci: a?.authorAci ?? '',
        provenance: a?.provenance ?? 'live',
        links: [],
        body,
        applied: store.isApplied(digest),
        missingPieces: a?.progress?.needRepair().length ?? 0,
      });
    }
    return { helds, records };
  }

  #nameOfSeat(g: HostGroup): (seat: AppSeat) => string {
    return seat => {
      const hex = aciHex(seat.aci);
      const m = g.members.find(x => aciStringHex(x.aci) === hex);
      return m?.name ?? hexToAciString(hex).slice(0, 8);
    };
  }

  /** The git desk for gitRoutes.std.ts. */
  gitDesk(): GitDesk {
    return {
      running: () =>
        this.available() && this.#deps.signal.ourAci() !== undefined,
      member: () => {
        const self = this.#deps.signal.ourAci();
        return self === undefined ? 'me' : this.#deps.signal.memberName(self);
      },
      findGroup: alias => this.findGroup(alias),
      repoState: (group, repo) => this.#repoState(group, repo),
      objects: async (group, repo, ids) => {
        const channel = await this.openChannel(group.conversationId, APP_GIT);
        const { records } = await this.#heldGit(channel);
        return this.#gitStore(channel.channelKey).objectsFor(
          records
            .filter(r => r.body.repo === repo && r.applied)
            .map(r => r.digest),
          ids
        );
      },
      push: (group, repo, plan) => this.#push(group, repo, plan),
    };
  }

  async #repoState(group: AppGroup, repo: string): Promise<RepoStateJson> {
    const g = await this.#group(group.conversationId);
    const channel = await this.openChannel(group.conversationId, APP_GIT);
    const { helds, records } = await this.#heldGit(channel);
    const view = await this.#apps().gitView(
      g.groupId,
      channel.channelKey,
      repo,
      helds
    );
    if (view.kind !== 'ok') {
      throw new Error(`GIT_VIEW: ${view.kind}`);
    }
    const heads = (await this.#deps.stores.heads(channel.channelKey)).map(h =>
      toHex(h)
    );
    const statuses = await this.#deps.stores.classify(channel.channelKey);
    const boundary = await this.#deps.stores.boundary(channel.channelKey);
    const held = new Set(helds.map(h => toHex(h.digest)));
    const notGiven =
      [...statuses.keys()].filter(d => !held.has(d)).length + boundary.length;
    return repoState({
      group: group.title,
      repo,
      members: group.members,
      heads,
      compareCode:
        heads.length === 0 ? '' : heads.map(h => h.slice(0, 5)).join('-'),
      held: records,
      notGiven,
      view,
      nameOf: aci => this.#member(g, aci).name,
      seatName: hex =>
        this.#nameOfSeat(g)({
          aci: fromHex(hex) ?? new Uint8Array(16),
          tag: new Uint8Array(16),
        }),
    });
  }

  async #prepare(
    g: HostGroup,
    channel: ChannelHandle,
    repo: string,
    plan: GitPushPlan,
    audience: Bytes,
    expect: ReadonlyArray<AppSeat>,
    pointers: Bytes,
    nonce: Bytes
  ): Promise<GitPrepareResult> {
    const self = this.#self();
    const { helds } = await this.#heldGit(channel);
    const request: GitPrepareRequest = {
      signalGroup: g.groupId,
      channelKey: channel.channelKey,
      author: self.aciBytes,
      nonce,
      exp: this.#exp(),
      audience,
      share: plan.share,
      expect,
      repo,
      updates: plan.updates,
      helds,
      pointers,
      stream: plan.stream,
    };
    return this.#apps().gitPrepare(request);
  }

  #coverSeats(
    g: HostGroup,
    audience: Bytes,
    names: ReadonlyArray<string>
  ): Array<AppSeat> {
    const seats = parseAudience(audience) ?? [];
    const out = new Array<AppSeat>();
    for (const name of names) {
      const m = g.members.find(x => x.name === name || x.aci === name);
      const s = m && seats.find(x => aciHex(x.aci) === aciStringHex(m.aci));
      if (s !== undefined) {
        out.push({ aci: s.aci, tag: s.tag });
      }
    }
    return out.sort((x, y) =>
      compareStrings(toHex(x.aci) + toHex(x.tag), toHex(y.aci) + toHex(y.tag))
    );
  }

  async #push(
    group: AppGroup,
    repo: string,
    plan: GitPushPlan
  ): Promise<GitPushOutcome> {
    const g = await this.#group(group.conversationId);
    const channel = await this.openChannel(group.conversationId, APP_GIT);
    const nameOf = this.#nameOfSeat(g);
    const storeNonce = new Uint8Array(randomBytes(32));
    const audience = await this.#audience(g);
    const expect = this.#coverSeats(g, audience, plan.covers ?? []);
    const audienceNames = (parseAudience(audience) ?? [])
      .filter(s => s.seated)
      .map(s => nameOf(s));

    // 1. The pre-check, before any upload.
    const pre = await this.#prepare(
      g,
      channel,
      repo,
      plan,
      audience,
      expect,
      new Uint8Array(0),
      storeNonce
    );
    const refused = refusalOf(pre, nameOf);
    if (refused !== undefined) {
      return refused;
    }
    if (pre.kind !== 'ok') {
      throw new Error('unreachable');
    }
    if (!this.#listsExactly(pre.message, plan.objects)) {
      return {
        status: 'refused',
        reason: 'BAD_OBJECTS',
        message: 'the uploaded objects are not the listed objects',
      };
    }
    const { records } = await this.#heldGit(channel);
    if (!plan.create && !records.some(r => r.body.repo === repo)) {
      return {
        status: 'refused',
        reason: 'NEEDS_CREATE',
        message: `${group.title}/${repo} holds no push of yours to build on; push with create to start it`,
      };
    }
    const covers = pre.covers.map(nameOf).sort();
    if (plan.share) {
      const yes = await this.#ask({
        kind: 'gitShare',
        group: g.title,
        repo,
        ref: plan.updates[0]?.name ?? '',
        commit: toHex(plan.updates[0]?.new ?? new Uint8Array()),
        covers: pre.covers.map(s =>
          this.#member(g, hexToAciString(aciHex(s.aci)))
        ),
      });
      if (!yes) {
        return {
          status: 'refused',
          reason: 'DECLINED',
          message: 'the share was declined in Signal',
        };
      }
    }
    if (plan.dryRun) {
      return { status: 'ok', record: null, audience: audienceNames, covers };
    }

    // 2. Uploads, then 3. the freeze (GIT_PREPARE again with the pointers).
    const pointers =
      plan.stream.length === 0
        ? new Uint8Array(0)
        : await this.#upload(plan.stream);
    const sent = await this.#freezeAndSend<GitPushOutcome>(
      channel,
      async frozen => {
        const r = await this.#prepare(
          g,
          channel,
          repo,
          plan,
          frozen,
          this.#coverSeats(g, frozen, covers),
          pointers,
          storeNonce
        );
        const again = refusalOf(r, nameOf);
        if (again !== undefined) {
          return { refused: again };
        }
        return r.kind === 'ok'
          ? { message: r.message }
          : {
              refused: {
                status: 'refused',
                reason: 'INTERNAL',
                message: r.kind,
              },
            };
      }
    );
    if (sent.kind === 'refused') {
      return sent.refused;
    }
    // 4. Bind our own push as a receiver does.
    await this.#bindOwn(channel, sent, plan.stream);
    return {
      status: 'ok',
      record: toHex(sent.digest),
      audience: audienceNames,
      covers,
    };
  }

  #listsExactly(message: Bytes, objects: ReadonlyArray<string>): boolean {
    const header = parseAppHeader(message);
    const body = header ? parseBody(header.body) : undefined;
    if (body === undefined) {
      return false;
    }
    const ids = body.oids.map(toHex);
    return (
      ids.length === objects.length && ids.every((id, i) => id === objects[i])
    );
  }
}

function emptyRepair(digest: string): RepairStatus {
  return { digest, pieces: [], failedChecks: [], dropped: [] };
}

/**
 * Demo only (Dave, `ZRDT_DEMO_VILLAIN=tamper` through a CI hook): flips the
 * last byte of every opening in a SERVE reply, after zrdtd built it and
 * before the seal, so the requester's PIECE_ACCEPT refuses it.
 */
export function tamperReply(reply: ServeReply): ServeReply {
  const entries = reply.entries.map((e): ServeEntry => {
    if (
      e.kind !== 'addressed' ||
      e.opening === undefined ||
      e.opening.length === 0
    ) {
      return e;
    }
    const opening = new Uint8Array(e.opening);
    opening[opening.length - 1] =
      ((opening[opening.length - 1] ?? 0) + 1) % 256;
    return { ...e, opening };
  });
  // The entries' bytes are re-encoded the way codec.std.ts writes them.
  return { ...reply, entries, entriesBytes: encodeServeEntries(entries) };
}
