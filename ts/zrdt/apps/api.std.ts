// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The apps API (zrdt docs/apps/BUILD_M1.md §D.2, "Interfaces between
// lanes"): what the transport lane offers the app code of the fork (the
// torrent manager and its routes, the share dialogs, the git routes). The
// transport implements it in ./transport.preload.ts; app code imports only
// these types and gets an instance from `getAppsApi()` there.
//
// It hides zrdt's plumbing: no pointer, opening, nonce, piece key or SERVE
// request crosses it (BUILD_M1 §B.10). App code sees groups, channels,
// announcements by digest, checked bytes, and events.
//
// Routes: the local endpoint (./endpoint.node.ts) serves HTTP on 127.0.0.1
// and on `<userData>/zrdt-apps.sock`; each app registers its routes under
// `/v1/<prefix>/...` and its client's token is scoped to that app. The git
// routes follow the helper's tools/git-remote-zrdt/ENDPOINT.md.

/** An app tag (field 210). */
export type AppTag = 'bt' | 'git-sha256';

/** A member of a Signal group, as an app sees it. */
export type AppMember = Readonly<{
  /** The member's ACI (uuid string). */
  aci: string;
  /** A display name (for messages only). */
  name: string;
  /** This device's account. */
  self: boolean;
}>;

/** A Signal group an app may use. */
export type AppGroup = Readonly<{
  conversationId: string;
  /** The group's title: the alias tools use (`zbt share --group Camping`). */
  title: string;
  members: ReadonlyArray<AppMember>;
}>;

/** An app channel: one per (Signal group, app). */
export type ChannelHandle = Readonly<{
  conversationId: string;
  app: AppTag;
  /** The host's store key for the channel (opaque to app code). */
  channelKey: string;
  /** The channel id, hex: SHA-256("zrdtC1" ‖ group ‖ app ‖ name). */
  channelId: string;
}>;

/** Who vouches for an announcement (CLASSIFY, PLAN.md §3.5). */
export type AppRecordStatus =
  | 'confirmedByAuthor'
  | 'notConfirmedByAuthor'
  | 'heldBy'
  | 'unconfirmed';

/**
 * Where a received announcement stands on this device.
 * - `received`: stored in the channel, not bound yet;
 * - `needsClick`: the fetch policy wants the user to start it (T-M4);
 * - `notSeated`: A's audience does not seat this device (T-m12): never
 *   offered, opened or fetched;
 * - `fetching`: pieces are coming from the CDN;
 * - `repairing`: some pieces are being asked of members;
 * - `complete`: PIECES_COMPLETE said OK; the stream is checked;
 * - `failed`: the bind was refused (`reason`), or no member could repair.
 */
export type AnnouncementState =
  | 'received'
  | 'needsClick'
  | 'notSeated'
  | 'fetching'
  | 'repairing'
  | 'complete'
  | 'failed';

/** An announcement (a channel record with a piece store), as app code sees it. */
export type Announcement = Readonly<{
  /** A's record digest, hex: its id everywhere in the API. */
  digest: string;
  conversationId: string;
  app: AppTag;
  author: AppMember;
  /** How A reached this device. */
  provenance: 'self' | 'live' | 'relayed' | 'imported';
  status: AppRecordStatus;
  receivedAt: number;
  state: AnnouncementState;
  /** Why it failed, for the log and the notice. */
  reason?: string;
  /** From PIECES_BIND, once bound: stream length, piece size 2^exp, N. */
  len?: number;
  exp?: number;
  pieces?: number;
  /** Pieces checked so far. */
  checked?: number;
  /** The app body (212) and app manifest (226), once bound (app-defined bytes). */
  body?: Uint8Array<ArrayBuffer>;
  manifest?: Uint8Array<ArrayBuffer>;
}>;

/** What app code asks the transport to publish (torrent; git goes through gitRoutes). */
export type TorrentPublishRequest = Readonly<{
  app: 'bt';
  conversationId: string;
  /** The file name (BT_BUILD checks `safeComponent`). */
  name: string;
  /** The whole file: at most 64 MiB. */
  stream: Uint8Array<ArrayBuffer>;
}>;

export type PublishResult =
  | Readonly<{ kind: 'ok'; digest: string; audience: ReadonlyArray<AppMember> }>
  | Readonly<{ kind: 'declined' }>
  | Readonly<{ kind: 'refused'; reason: string; message: string }>;

/** One piece's state in a repair (BUILD_M1 §A.1 step 5). */
export type RepairPieceStatus = Readonly<{
  index: number;
  state: 'wanted' | 'asked' | 'ok' | 'failed';
  /** The member asked, or who supplied it. */
  member?: string;
}>;

export type RepairStatus = Readonly<{
  digest: string;
  pieces: ReadonlyArray<RepairPieceStatus>;
  /** Pieces that failed zrdt's check, and who sent them (shown to this user only). */
  failedChecks: ReadonlyArray<Readonly<{ index: number; member: string }>>;
  /** Members no longer asked (a bad piece, or no answer). */
  dropped: ReadonlyArray<string>;
}>;

/** Events for UIs and the endpoint's subscribers. */
export type AppEvent =
  | Readonly<{ type: 'announcement'; announcement: Announcement }>
  | Readonly<{
      type: 'pieceFailedCheck';
      digest: string;
      index: number;
      /** The member whose bytes failed (a repair), or 'cdn' (the author's upload). */
      from: string;
    }>
  | Readonly<{ type: 'repair'; status: RepairStatus }>
  | Readonly<{ type: 'complete'; digest: string; app: AppTag }>;

/**
 * What the fork's own dialog is asked before a share (BUILD_M1 §B.10: a share
 * happens only after it). The transport calls the registered handler and
 * waits for the user's answer; no handler means "no".
 */
export type ConfirmRequest =
  | Readonly<{
      kind: 'torrentShare';
      group: string;
      name: string;
      size: number;
      members: ReadonlyArray<AppMember>;
    }>
  | Readonly<{
      kind: 'gitShare';
      group: string;
      repo: string;
      ref: string;
      /** The commit id, hex. */
      commit: string;
      /** The members the share gives the commit to (COVERS_CHANGED's list). */
      covers: ReadonlyArray<AppMember>;
    }>;

export type ConfirmHandler = (request: ConfirmRequest) => Promise<boolean>;

// --- routes on the local endpoint ---------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RouteRequest = Readonly<{
  method: HttpMethod;
  /** The path, decoded per segment. */
  path: string;
  /** The `:name` segments of the pattern. */
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  /** The JSON body, parsed (undefined for none). */
  body: unknown;
  /** The app the client's token belongs to. */
  app: AppTag;
}>;

export type RouteResponse = Readonly<{ status: number; body: unknown }>;

export type Route = Readonly<{
  method: HttpMethod;
  /** e.g. `/v1/git/:group/:repo/objects`; segments match exactly or bind `:name`. */
  pattern: string;
  handle: (request: RouteRequest) => Promise<RouteResponse>;
}>;

/**
 * A failed call: an HTTP status and ENDPOINT.md's error code (§3):
 * 400 `bad_request`, 401 `unauthorized`, 404 `no_group` / `no_upload` /
 * `not_found`, 405 `bad_method`, 413 `too_large`, 400 `bad_piece`,
 * 500 `internal`, 503 `not_running`.
 */
export class RouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.code = code;
  }
}

/** The `:name` bindings of `pattern` for `path`, or undefined. */
export function matchRoute(
  pattern: string,
  path: string
): Record<string, string> | undefined {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const w = want[i] ?? '';
    const g = got[i] ?? '';
    if (w.startsWith(':')) {
      let value: string;
      try {
        value = decodeURIComponent(g);
      } catch {
        return undefined;
      }
      if (value === '') {
        return undefined;
      }
      params[w.slice(1)] = value;
    } else if (w !== g) {
      return undefined;
    }
  }
  return params;
}

// --- the API ------------------------------------------------------------------

export type AppsApi = Readonly<{
  /** Whether the apps run: zrdtd speaks protocol 5 and the endpoint is up. */
  available(): boolean;

  /** The groups this account is a member of. */
  groups(): Promise<ReadonlyArray<AppGroup>>;

  /** The group whose title (or conversation id) is `alias`, if this account is in it. */
  findGroup(alias: string): Promise<AppGroup | undefined>;

  /** The channel of `app` in the group: opened (or caught up) on first use. */
  openChannel(conversationId: string, app: AppTag): Promise<ChannelHandle>;

  /**
   * Publishes a torrent: the fork's dialog first (`ConfirmRequest`
   * `torrentShare`), then uploads, the freeze, the send, and the author's own
   * bind (BUILD_M1 §B.9 "Author").
   */
  publish(request: TorrentPublishRequest): Promise<PublishResult>;

  /** The announcements of `app` in the group, oldest first. */
  announcements(
    conversationId: string,
    app: AppTag
  ): Promise<ReadonlyArray<Announcement>>;

  /**
   * Fetches an announcement's pieces (CDN, then repair). `click` is the
   * user's go-ahead for one the fetch policy holds back. Resolves with the
   * announcement's state once it is complete or failed.
   */
  fetchPieces(
    digest: string,
    options?: Readonly<{ click?: boolean }>
  ): Promise<Announcement>;

  /** The checked stream of a complete announcement (piece bytes PIECE_ACCEPT took). */
  stream(digest: string): Promise<Uint8Array<ArrayBuffer> | undefined>;

  /** ASSEMBLE: whether `stream` is exactly the announced stream (after a write). */
  assemble(digest: string, stream: Uint8Array<ArrayBuffer>): Promise<boolean>;

  /** The repair of an announcement, if one ran. */
  repairStatus(digest: string): RepairStatus | undefined;

  /** Events; returns the unsubscribe function. */
  subscribe(listener: (event: AppEvent) => void): () => void;

  /** The share dialog (torrent-ui registers it). */
  registerConfirm(handler: ConfirmHandler): void;

  /** Routes on the local endpoint for `app`'s clients. */
  registerRoutes(app: AppTag, routes: ReadonlyArray<Route>): void;
}>;
