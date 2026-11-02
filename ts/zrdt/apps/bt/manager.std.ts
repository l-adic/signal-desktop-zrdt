// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// The torrent manager: the user side of app "bt" (zrdt
// docs/apps/BUILD_M1.md §A.1, §B.6, §B.9; docs/zrdt/FORK_MAP.md).
//
// One transfer row per file: "Share a file" (the author's dialog, then the
// publish), and for every member the per-piece progress, the "checked"
// state, "resent by <member>" labels, and the notice when a piece does not
// pass its check. It drives one announcement A at a time through lane
// transport's API (`BtApi` below; ts/zrdt/apps/api.std.ts implements it) and
// writes a received file through `BtWriter` (write.node.ts).
//
// It never hashes, never decides that a piece is good and never builds an app
// message: zrdtd does (BT_BUILD, PIECE_ACCEPT, PIECES_COMPLETE, BT_FILE,
// ASSEMBLE). The manager shows what comes back. It asks for the file's bytes
// only after PIECES_COMPLETE answered OK, writes them into a new folder, and
// then has ASSEMBLE check the bytes read back from disk.
//
// Piece indices are 0-based here and in the API (zrdtd's i). People count
// from 1: "piece 7" is index 6, and the 7th upload of the share.

/** Raw bytes. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** 64 lowercase hex digits: A's digest, the file's id. */
export type DigestHex = string;

/** A member as the row shows them. `aci` identifies, `name` is for display. */
export type BtMember = Readonly<{ aci: string; name: string }>;

export const BT_APP = 'bt';
export const BT_CHANNEL = 'files';

/** k = 20: hosts always use 1 MiB pieces (BUILD_M1 §B.2). */
export const PIECE_LOG2 = 20;
export const PIECE_BYTES = 2 ** PIECE_LOG2;
/** One file of at most 64 MiB, so at most 64 pieces (BUILD_M1 §B.3). */
export const MAX_PIECES = 64;
export const MAX_FILE_BYTES = MAX_PIECES * PIECE_BYTES;
/** The fetch policy's bound for files that start without a click (§B.9). */
export const AUTO_FETCH_MAX_BYTES = 32 * PIECE_BYTES;

/** ⌈size / pieceBytes⌉: the number of pieces of a file of `size` bytes. */
export function pieceCount(size: number, pieceBytes = PIECE_BYTES): number {
  return Math.ceil(size / pieceBytes);
}

// ---------------------------------------------------------------------------
// safeComponent (BUILD_M1 §B.6)
//
// zrdtd checks a file name in BT_BUILD and BT_FILE (BAD_NAME). The host checks
// it again before it shows a dialog and before it writes: defence in depth,
// never a reason to accept what zrdtd refused.

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// "/", "\", ":", "<", ">", '"', "|", "?", "*", NUL, below 0x20, DEL.
const FORBIDDEN_CHARS = /[/\\:<>"|?*\u0000-\u001f\u007f]/;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** True when `name` may be a file name on every host (§B.6, all rules). */
export function safeComponent(name: string): boolean {
  if (!name.isWellFormed()) {
    return false;
  }
  const length = utf8Length(name);
  if (length < 1 || length > 255) {
    return false;
  }
  if (name === '.' || name === '..') {
    return false;
  }
  if (FORBIDDEN_CHARS.test(name)) {
    return false;
  }
  if (/^[ .]|[ .]$/.test(name)) {
    return false;
  }
  return !WINDOWS_RESERVED.test(name);
}

// ---------------------------------------------------------------------------
// Lane transport's API, as the manager uses it (BUILD_M1 §D.2: `publish`,
// `fetchPieces`, `repairStatus`). Until ts/zrdt/apps/api.std.ts lands, tests
// and the demo use fakes of this type.

/** Where a checked piece came from. */
export type PieceSource =
  /** The author's own file (the author binds its own A, §B.9 step 4). */
  | Readonly<{ kind: 'local' }>
  /** The CDN object A's pointer names. */
  | Readonly<{ kind: 'cdn' }>
  /** A member's sealed SERVE reply: piece repair. */
  | Readonly<{ kind: 'member'; member: BtMember }>;

/**
 * One step of one piece, as lane transport reports it. A piece is "checked"
 * only when PIECE_ACCEPT answered OK for it.
 */
export type BtPieceEvent =
  /** Author: the slice is going to the CDN. */
  | Readonly<{ kind: 'uploading'; index: number }>
  /** Receiver: the CDN download started. */
  | Readonly<{ kind: 'fetching'; index: number }>
  /** PIECE_ACCEPT answered OK. */
  | Readonly<{ kind: 'checked'; index: number; source: PieceSource }>
  /**
   * The CDN download failed before zrdtd saw any byte: 404, or Signal's
   * attachment MAC refused the ciphertext. The piece goes to repair.
   */
  | Readonly<{
      kind: 'cdnFailed';
      index: number;
      reason: 'notFound' | 'badMac' | 'network';
    }>
  /**
   * The CDN bytes passed Signal's MAC, and PIECE_ACCEPT answered BAD_PIECE:
   * the author uploaded bytes that are not the piece A names (§B.9 step 4).
   */
  | Readonly<{ kind: 'cdnBadPiece'; index: number }>
  /** A repair request for this piece went to `member`. */
  | Readonly<{ kind: 'asking'; index: number; member: BtMember }>
  /** `member` did not answer in time; the piece goes to someone else. */
  | Readonly<{ kind: 'noAnswer'; index: number; member: BtMember }>
  /**
   * `member`'s reply for this piece got BAD_PIECE. Repair stops asking them,
   * and only this user is told.
   */
  | Readonly<{ kind: 'memberBadPiece'; index: number; member: BtMember }>
  /** Nobody left to ask for this piece. */
  | Readonly<{ kind: 'unavailable'; index: number }>;

export type BtPublishRequest = Readonly<{
  conversationId: string;
  name: string;
  /** The whole file: lane transport slices it into 2^k-byte pieces. */
  stream: Bytes;
  onPiece: (event: BtPieceEvent) => void;
}>;

export type BtPublishResult =
  /**
   * Uploaded, frozen (AUDIENCE, BT_BUILD, COMMIT, re-check, ACCEPT), sent as
   * Content 205, and bound by the author like any receiver
   * (PIECES_COMPLETE OK). `audience`: how many members A seats.
   */
  | Readonly<{ kind: 'published'; announcement: DigestHex; audience: number }>
  /** Nothing was sent. `badName`: BT_BUILD answered BAD_NAME. */
  | Readonly<{
      kind: 'refused';
      reason: 'badName' | 'tooLarge' | 'notMember' | 'failed';
      detail?: string;
    }>;

export type BtBindResult =
  /** PIECES_BIND answered OK: L and N. */
  | Readonly<{ kind: 'bound'; size: number; pieces: number }>
  /** BAD_APP 4: A does not seat us. Never offer, open or fetch (T-m12). */
  | Readonly<{ kind: 'notSeated' }>
  /** Any other refusal (MALFORMED, BAD_APP 1, 2, 3, 5, ...). */
  | Readonly<{ kind: 'refused'; detail: string }>;

export type BtFileResult =
  /** BT_FILE: the manifest's name (safeComponent) and length. */
  | Readonly<{ kind: 'file'; name: string; size: number }>
  | Readonly<{ kind: 'refused'; detail: string }>;

export type BtFetchResult =
  /** PIECES_COMPLETE answered OK: the piece store's heads are {F}. */
  | Readonly<{ kind: 'complete' }>
  /** Repair gave up; `missing` are 0-based indices. */
  | Readonly<{ kind: 'incomplete'; missing: ReadonlyArray<number> }>;

export type BtAssembleResult =
  | Readonly<{ kind: 'ok' }>
  /** ASSEMBLE's first bad index; N when the length is not L. */
  | Readonly<{ kind: 'badPiece'; index: number }>;

export type BtApi = Readonly<{
  /** The author's side (§B.9 "Author"), for app "bt". */
  publish: (request: BtPublishRequest) => Promise<BtPublishResult>;
  /** PIECES_BIND of an accepted A (§B.9 receiver step 3). */
  bind: (
    conversationId: string,
    announcement: DigestHex
  ) => Promise<BtBindResult>;
  /** BT_FILE on the bound piece key. */
  file: (announcement: DigestHex) => Promise<BtFileResult>;
  /**
   * Download, PIECE_ACCEPT, PIECES_COMPLETE and repair (§B.9 steps 4-5 and
   * "Repair"), reporting each piece. Calling it again retries what is
   * missing.
   */
  fetchPieces: (
    announcement: DigestHex,
    onPiece: (event: BtPieceEvent) => void
  ) => Promise<BtFetchResult>;
  /** The checked pieces, concatenated in index order (after `complete`). */
  readStream: (announcement: DigestHex) => Promise<Bytes>;
  /** ASSEMBLE of the bytes read back from disk. */
  assemble: (
    announcement: DigestHex,
    stream: Bytes
  ) => Promise<BtAssembleResult>;
}>;

/** write.node.ts: a new folder per file, never an overwrite. */
export type BtWriter = Readonly<{
  write: (name: string, bytes: Bytes) => Promise<Readonly<{ file: string }>>;
  readBack: (file: string) => Promise<Bytes>;
  /** Removes a written file that did not pass ASSEMBLE, and its folder. */
  discard: (file: string) => Promise<void>;
}>;

/** What the share dialog shows (BUILD_M1 §A.1 step 1). */
export type BtShareQuestion = Readonly<{
  conversationId: string;
  groupTitle: string;
  memberCount: number;
  name: string;
  size: number;
}>;

export type BtManagerDeps = Readonly<{
  api: BtApi;
  /**
   * The fork's own dialog. Resolves true only when the user pressed Share.
   * A share never happens without it (§B.10).
   */
  confirmShare: (question: BtShareQuestion) => Promise<boolean>;
  writer: BtWriter;
  /** Logs one line; never a pointer, a key or file content. */
  log?: (line: string) => void;
}>;

// ---------------------------------------------------------------------------
// Transfers

export type BtPhase =
  /** Author: the share dialog is open. */
  | 'confirming'
  /** Author: the slices go to the CDN, then the freeze and the send. */
  | 'uploading'
  /** Receiver: PIECES_BIND and BT_FILE. */
  | 'binding'
  /** Receiver: waits for a click (not confirmed by its author, or over 32 MiB). */
  | 'offered'
  /** Receiver: pieces from the CDN. */
  | 'fetching'
  /** Receiver: some pieces were asked from members. */
  | 'repairing'
  /** Receiver: writing, then ASSEMBLE of what is on disk. */
  | 'saving'
  /** Every piece passed its check (author: shared; receiver: saved). */
  | 'checked'
  /** See `failure`. */
  | 'failed';

export type BtFailure =
  /** Repair gave up on these pieces (0-based). */
  | Readonly<{ kind: 'incomplete'; missing: ReadonlyArray<number> }>
  /** The bytes read back from disk failed ASSEMBLE at this index. */
  | Readonly<{ kind: 'notSaved'; index: number }>
  /** The share was refused before anything was sent. */
  | Readonly<{ kind: 'notShared'; reason: string }>
  /** Something broke (a write, the backend); the row can try again. */
  | Readonly<{ kind: 'error'; detail: string }>;

export type BtPieceView =
  | Readonly<{ state: 'waiting' }>
  | Readonly<{ state: 'uploading' }>
  | Readonly<{ state: 'fetching' }>
  | Readonly<{ state: 'checked'; source: PieceSource }>
  /** Not from the CDN (or the author's upload failed its check); to repair. */
  | Readonly<{
      state: 'missing';
      reason: 'notFound' | 'badMac' | 'network' | 'badUpload' | 'badReply';
    }>
  | Readonly<{ state: 'asking'; member: BtMember }>
  | Readonly<{ state: 'unavailable' }>;

/** Members whose replies were checked, with their pieces (0-based, sorted). */
export type BtResent = Readonly<{
  member: BtMember;
  pieces: ReadonlyArray<number>;
}>;

export type BtTransferView = Readonly<{
  /** Stable for the row's life: A's digest once known, a local id before. */
  id: string;
  conversationId: string;
  direction: 'out' | 'in';
  announcement: DigestHex | undefined;
  /** BT_FILE's name; the author's name for outgoing rows. */
  name: string | undefined;
  size: number | undefined;
  /** The author: us for outgoing rows. */
  author: BtMember;
  phase: BtPhase;
  pieces: ReadonlyArray<BtPieceView>;
  checked: number;
  resent: ReadonlyArray<BtResent>;
  /** Shown to this user only, e.g. "piece 7 from Dave failed its check". */
  notices: ReadonlyArray<string>;
  /** Members A seats (author, after the publish). */
  audience: number | undefined;
  /** The written file (receiver, once ASSEMBLE passed). */
  savedTo: string | undefined;
  failure: BtFailure | undefined;
}>;

export type BtShareRequest = Readonly<{
  conversationId: string;
  groupTitle: string;
  memberCount: number;
  /** Us, as the row shows the author. */
  self: BtMember;
  name: string;
  stream: Bytes;
}>;

export type BtShareOutcome =
  | Readonly<{
      kind: 'published';
      id: string;
      announcement: DigestHex;
      audience: number;
    }>
  | Readonly<{ kind: 'declined' }>
  | Readonly<{
      kind: 'refused';
      /** empty, tooLarge, badName, or the publish's refusal. */
      reason: string;
      detail?: string;
    }>;

export type BtAnnouncement = Readonly<{
  conversationId: string;
  announcement: DigestHex;
  author: BtMember;
  /**
   * CLASSIFY reports A confirmed by its author: it came live from them. Only
   * such an A, up to 32 MiB, is fetched without a click (T-M4).
   */
  confirmedByAuthor: boolean;
}>;

type Transfer = {
  id: string;
  conversationId: string;
  direction: 'out' | 'in';
  announcement: DigestHex | undefined;
  name: string | undefined;
  size: number | undefined;
  author: BtMember;
  phase: BtPhase;
  pieces: Array<BtPieceView>;
  notices: Array<string>;
  audience: number | undefined;
  savedTo: string | undefined;
  failure: BtFailure | undefined;
  // A fetch or save is running: a second click does nothing.
  busy: boolean;
};

function isIndex(t: Transfer, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < t.pieces.length;
}

function resentOf(pieces: ReadonlyArray<BtPieceView>): Array<BtResent> {
  const byAci = new Map<string, { member: BtMember; pieces: Array<number> }>();
  pieces.forEach((piece, index) => {
    if (piece.state !== 'checked' || piece.source.kind !== 'member') {
      return;
    }
    const { member } = piece.source;
    const entry = byAci.get(member.aci) ?? { member, pieces: [] };
    entry.pieces.push(index);
    byAci.set(member.aci, entry);
  });
  return [...byAci.values()];
}

function viewOf(t: Transfer): BtTransferView {
  return {
    id: t.id,
    conversationId: t.conversationId,
    direction: t.direction,
    announcement: t.announcement,
    name: t.name,
    size: t.size,
    author: t.author,
    phase: t.phase,
    pieces: [...t.pieces],
    checked: t.pieces.filter(p => p.state === 'checked').length,
    resent: resentOf(t.pieces),
    notices: [...t.notices],
    audience: t.audience,
    savedTo: t.savedTo,
    failure: t.failure,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The transfers of every group, and the steps that move them. One instance
 * per desktop; lane transport calls `onAnnouncement` for each accepted A of
 * a `bt/files` channel, and the UI and the endpoint read `transfers()`.
 */
export class BtManager {
  readonly #deps: BtManagerDeps;
  readonly #transfers = new Map<string, Transfer>();
  readonly #listeners = new Set<() => void>();
  // Announcements between onAnnouncement's start and their row.
  readonly #opening = new Set<DigestHex>();
  #nextLocal = 1;
  #version = 0;
  #snapshot: { version: number; views: ReadonlyArray<BtTransferView> } = {
    version: 0,
    views: [],
  };

  constructor(deps: BtManagerDeps) {
    this.#deps = deps;
  }

  // --- reading ------------------------------------------------------------

  /** Every row, oldest first; the same array until something changes. */
  transfers(): ReadonlyArray<BtTransferView> {
    if (this.#snapshot.version !== this.#version) {
      this.#snapshot = {
        version: this.#version,
        views: [...this.#transfers.values()].map(viewOf),
      };
    }
    return this.#snapshot.views;
  }

  /** The rows of one group, oldest first. */
  transfersOf(conversationId: string): ReadonlyArray<BtTransferView> {
    return this.transfers().filter(t => t.conversationId === conversationId);
  }

  /** One row by `id` or by A's digest. */
  transfer(idOrAnnouncement: string): BtTransferView | undefined {
    return this.transfers().find(
      t => t.id === idOrAnnouncement || t.announcement === idOrAnnouncement
    );
  }

  /** Called after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // --- the author ---------------------------------------------------------

  /**
   * "Share a file": the fork's dialog, then the publish. Resolves when the
   * file was published, the user declined, or the share was refused before
   * anything was sent.
   */
  async share(request: BtShareRequest): Promise<BtShareOutcome> {
    const { conversationId, groupTitle, memberCount, self, name, stream } =
      request;
    const size = stream.byteLength;
    if (size === 0) {
      return { kind: 'refused', reason: 'empty' };
    }
    if (size > MAX_FILE_BYTES) {
      return {
        kind: 'refused',
        reason: 'tooLarge',
        detail: `${formatSize(size)} is over ${formatSize(MAX_FILE_BYTES)}`,
      };
    }
    if (!safeComponent(name)) {
      return { kind: 'refused', reason: 'badName' };
    }

    const id = `out-${this.#nextLocal}`;
    this.#nextLocal += 1;
    const t: Transfer = {
      id,
      conversationId,
      direction: 'out',
      announcement: undefined,
      name,
      size,
      author: self,
      phase: 'confirming',
      pieces: Array.from({ length: pieceCount(size) }, () => ({
        state: 'waiting' as const,
      })),
      notices: [],
      audience: undefined,
      savedTo: undefined,
      failure: undefined,
      busy: true,
    };
    this.#transfers.set(id, t);
    this.#changed();

    let confirmed: boolean;
    try {
      confirmed = await this.#deps.confirmShare({
        conversationId,
        groupTitle,
        memberCount,
        name,
        size,
      });
    } catch (error) {
      this.#log(`share ${id}: dialog failed: ${errorText(error)}`);
      confirmed = false;
    }
    if (!confirmed) {
      this.#transfers.delete(id);
      this.#changed();
      return { kind: 'declined' };
    }

    t.phase = 'uploading';
    this.#changed();
    let result: BtPublishResult;
    try {
      result = await this.#deps.api.publish({
        conversationId,
        name,
        stream,
        onPiece: event => this.#onPiece(id, event),
      });
    } catch (error) {
      result = { kind: 'refused', reason: 'failed', detail: errorText(error) };
    }
    t.busy = false;
    if (result.kind === 'refused') {
      t.phase = 'failed';
      t.failure = {
        kind: 'notShared',
        reason: result.detail ?? result.reason,
      };
      this.#changed();
      return { kind: 'refused', reason: result.reason, detail: result.detail };
    }

    t.announcement = result.announcement;
    t.audience = result.audience;
    // The author bound its own A from the local file: every piece is checked
    // (lane transport reports them; a missing report still means OK, since
    // `published` comes only after PIECES_COMPLETE answered OK).
    t.pieces = t.pieces.map(p =>
      p.state === 'checked'
        ? p
        : { state: 'checked', source: { kind: 'local' } }
    );
    t.phase = 'checked';
    this.#changed();
    return {
      kind: 'published',
      id,
      announcement: result.announcement,
      audience: result.audience,
    };
  }

  // --- a receiver ---------------------------------------------------------

  /**
   * An accepted A of a `bt/files` channel (lane transport, §B.9 receiver
   * step 2). Binds it, reads its name and size, then fetches it at once or
   * offers it for a click.
   */
  async onAnnouncement(a: BtAnnouncement): Promise<void> {
    if (
      this.#find(a.announcement) !== undefined ||
      this.#opening.has(a.announcement)
    ) {
      return; // our own share, or a second delivery
    }
    this.#opening.add(a.announcement);
    try {
      await this.#open(a);
    } finally {
      this.#opening.delete(a.announcement);
    }
  }

  async #open(a: BtAnnouncement): Promise<void> {
    const t: Transfer = {
      id: a.announcement,
      conversationId: a.conversationId,
      direction: 'in',
      announcement: a.announcement,
      name: undefined,
      size: undefined,
      author: a.author,
      phase: 'binding',
      pieces: [],
      notices: [],
      audience: undefined,
      savedTo: undefined,
      failure: undefined,
      busy: true,
    };
    // Not shown until BT_FILE answered: a row for an A we may not open would
    // offer what T-m12 forbids.
    let bound: BtBindResult;
    let file: BtFileResult;
    try {
      bound = await this.#deps.api.bind(a.conversationId, a.announcement);
      if (bound.kind !== 'bound') {
        this.#log(
          `bt ${a.announcement.slice(0, 8)}: not offered (${
            bound.kind === 'notSeated' ? 'not seated' : bound.detail
          })`
        );
        return;
      }
      file = await this.#deps.api.file(a.announcement);
    } catch (error) {
      this.#log(
        `bt ${a.announcement.slice(0, 8)}: bind failed: ${errorText(error)}`
      );
      return;
    }
    // zrdtd already refuses a name that is not safeComponent and an L that
    // is not the descriptor's (BT_FILE); the host checks again.
    if (
      file.kind !== 'file' ||
      !safeComponent(file.name) ||
      file.size !== bound.size ||
      bound.pieces !== pieceCount(bound.size)
    ) {
      this.#log(`bt ${a.announcement.slice(0, 8)}: not offered (bad file)`);
      return;
    }
    if (this.#find(a.announcement) !== undefined) {
      return; // our own share finished meanwhile
    }
    t.name = file.name;
    t.size = file.size;
    t.pieces = Array.from({ length: bound.pieces }, () => ({
      state: 'waiting' as const,
    }));
    const auto = a.confirmedByAuthor && file.size <= AUTO_FETCH_MAX_BYTES;
    t.phase = auto ? 'fetching' : 'offered';
    t.busy = false;
    this.#transfers.set(t.id, t);
    this.#changed();
    if (auto) {
      await this.#fetchAndSave(t.id);
    }
  }

  /** The row's "Download" (an offered file) and "Try again" (a failed one). */
  async download(id: string): Promise<void> {
    const t = this.#find(id);
    if (t === undefined || t.direction !== 'in' || t.busy) {
      return;
    }
    if (t.phase !== 'offered' && t.phase !== 'failed') {
      return;
    }
    t.failure = undefined;
    await this.#fetchAndSave(t.id);
  }

  // --- internals ----------------------------------------------------------

  #find(idOrAnnouncement: string): Transfer | undefined {
    for (const t of this.#transfers.values()) {
      if (t.id === idOrAnnouncement || t.announcement === idOrAnnouncement) {
        return t;
      }
    }
    return undefined;
  }

  async #fetchAndSave(id: string): Promise<void> {
    const { api, writer } = this.#deps;
    const t = this.#transfers.get(id);
    const announcement = t?.announcement;
    if (t === undefined || announcement === undefined || t.name === undefined) {
      return;
    }
    t.busy = true;
    t.phase = 'fetching';
    this.#changed();
    try {
      const fetched = await api.fetchPieces(announcement, event =>
        this.#onPiece(id, event)
      );
      if (fetched.kind === 'incomplete') {
        for (const index of fetched.missing) {
          const p = isIndex(t, index) ? t.pieces[index] : undefined;
          if (p !== undefined && p.state !== 'checked') {
            t.pieces[index] = { state: 'unavailable' };
          }
        }
        t.phase = 'failed';
        t.failure = { kind: 'incomplete', missing: [...fetched.missing] };
        return;
      }
      // PIECES_COMPLETE answered OK: every piece passed PIECE_ACCEPT.
      t.pieces = t.pieces.map(p =>
        p.state === 'checked'
          ? p
          : { state: 'checked', source: { kind: 'cdn' } }
      );
      t.phase = 'saving';
      this.#changed();

      const bytes = await api.readStream(announcement);
      const { file } = await writer.write(t.name, bytes);
      const back = await writer.readBack(file);
      const assembled = await api.assemble(announcement, back);
      if (assembled.kind !== 'ok') {
        await writer.discard(file);
        t.phase = 'failed';
        t.failure = { kind: 'notSaved', index: assembled.index };
        return;
      }
      t.savedTo = file;
      t.phase = 'checked';
    } catch (error) {
      t.phase = 'failed';
      t.failure = { kind: 'error', detail: errorText(error) };
      this.#log(
        `bt ${announcement.slice(0, 8)}: fetch failed: ${errorText(error)}`
      );
    } finally {
      t.busy = false;
      this.#changed();
    }
  }

  #onPiece(id: string, event: BtPieceEvent): void {
    const t = this.#transfers.get(id);
    if (t === undefined) {
      return;
    }
    const { index } = event;
    if (!isIndex(t, index)) {
      this.#log(`bt ${id.slice(0, 8)}: event for piece ${index} ignored`);
      return;
    }
    const notice = (text: string) => {
      if (!t.notices.includes(text)) {
        t.notices.push(text);
      }
    };
    // A checked piece stays checked: PIECE_ACCEPT stored it.
    if (t.pieces[index]?.state === 'checked') {
      return;
    }
    switch (event.kind) {
      case 'uploading':
        t.pieces[index] = { state: 'uploading' };
        break;
      case 'fetching':
        t.pieces[index] = { state: 'fetching' };
        break;
      case 'checked':
        t.pieces[index] = { state: 'checked', source: event.source };
        break;
      case 'cdnFailed':
        t.pieces[index] = { state: 'missing', reason: event.reason };
        break;
      case 'cdnBadPiece':
        t.pieces[index] = { state: 'missing', reason: 'badUpload' };
        notice(uploadFailedText(index, t.author.name));
        break;
      case 'asking':
        t.pieces[index] = { state: 'asking', member: event.member };
        if (t.phase === 'fetching') {
          t.phase = 'repairing';
        }
        break;
      case 'noAnswer':
        // The piece waits for its next 'asking'; the row keeps the old ask.
        break;
      case 'memberBadPiece':
        t.pieces[index] = { state: 'missing', reason: 'badReply' };
        notice(pieceFailedText(index, event.member.name));
        break;
      case 'unavailable':
        t.pieces[index] = { state: 'unavailable' };
        break;
      default:
        throw new Error(
          `BtManager: unknown piece event ${String((event as { kind: unknown }).kind)}`
        );
    }
    this.#changed();
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#log(`listener failed: ${errorText(error)}`);
      }
    }
  }

  #log(line: string): void {
    this.#deps.log?.(line);
  }
}

// ---------------------------------------------------------------------------
// Wording. Plain English, one place, shared by the row, the dialog, zbt's
// output and the beat's checks. A string may say that a member's piece
// failed its check (a fact this user's zrdtd established); it never says
// that the server misbehaved: Signal's attachment MAC catches the server,
// zrdt's check catches members (BUILD_M1 §A.1).
// TODO(zrdt): move to Signal's _locales/ ICU strings after the demo.

/** 20 MiB, 300 KiB, 1.5 MiB, 512 bytes. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${units[unit]}`;
}

function membersText(count: number): string {
  return count === 1 ? '1 member' : `${count} members`;
}

/** "piece 7": people count from 1. */
export function pieceName(index: number): string {
  return `piece ${index + 1}`;
}

export const SHARE_A_FILE = 'Share a file';
export const SHARE = 'Share';
export const CANCEL = 'Cancel';
export const DOWNLOAD = 'Download';
export const TRY_AGAIN = 'Try again';

/** The share dialog's question (BUILD_M1 §A.1 step 1). */
export function shareQuestion(
  q: Omit<BtShareQuestion, 'conversationId'>
): string {
  return (
    `Share ${q.name} (${formatSize(q.size)}) with ${q.groupTitle} ` +
    `(${membersText(q.memberCount)})?`
  );
}

export const SHARE_EXPLAINER =
  'Every member of the group gets the file. Each piece is checked when it ' +
  'arrives, whoever sends it.';

/** "17 of 20 pieces checked". */
export function piecesCheckedText(checked: number, total: number): string {
  return total === 1
    ? `${checked} of 1 piece checked`
    : `${checked} of ${total} pieces checked`;
}

/** "resent by Bob". */
export function resentByText(memberName: string): string {
  return `resent by ${memberName}`;
}

/** "pieces 3, 12 and 15 resent by Bob". */
export function resentSummaryText(r: BtResent): string {
  const numbers = r.pieces.map(i => String(i + 1));
  const list =
    numbers.length < 2
      ? (numbers[0] ?? '')
      : `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
  const noun = numbers.length === 1 ? 'piece' : 'pieces';
  return `${noun} ${list} ${resentByText(r.member.name)}`;
}

/** "piece 7 from Dave failed its check" (this user only). */
export function pieceFailedText(index: number, memberName: string): string {
  return `${pieceName(index)} from ${memberName} failed its check`;
}

/** The CDN bytes passed Signal's MAC but are not the piece A names. */
export function uploadFailedText(index: number, authorName: string): string {
  return `${pieceName(index)} as uploaded by ${authorName} failed its check`;
}

/** The row's subtitle: "20 MiB · from Alice", "20 MiB · shared by you". */
export function subtitleText(t: BtTransferView): string {
  const size = t.size === undefined ? undefined : formatSize(t.size);
  const who = t.direction === 'out' ? 'shared by you' : `from ${t.author.name}`;
  return size === undefined ? who : `${size} · ${who}`;
}

/** The row's status line, by phase. */
export function statusText(t: BtTransferView): string {
  const total = t.pieces.length;
  switch (t.phase) {
    case 'confirming':
      return 'Waiting for you to confirm';
    case 'uploading':
      return 'Uploading';
    case 'binding':
      return 'Opening';
    case 'offered':
      return 'Not downloaded';
    case 'fetching':
    case 'repairing':
      return piecesCheckedText(t.checked, total);
    case 'saving':
      return 'Saving';
    case 'checked':
      return t.direction === 'out'
        ? `Shared with ${membersText(t.audience ?? 0)}: every piece checked`
        : 'Checked: every piece passed its check';
    case 'failed':
      return failureText(t.failure);
    default:
      throw new Error(`statusText: unknown phase ${String(t.phase)}`);
  }
}

/** Why a row failed, in one line. */
export function failureText(failure: BtFailure | undefined): string {
  if (failure === undefined) {
    return 'Failed';
  }
  switch (failure.kind) {
    case 'incomplete': {
      const n = failure.missing.length;
      return n === 1
        ? `${pieceName(failure.missing[0] ?? 0)} did not pass a check from anyone who has it`
        : `${n} pieces did not pass a check from anyone who has them`;
    }
    case 'notSaved':
      return `The saved file failed its check at ${pieceName(failure.index)}; it was removed`;
    case 'notShared':
      return `Not shared: ${failure.reason}`;
    case 'error':
      return `Stopped: ${failure.detail}`;
    default:
      throw new Error('failureText: unknown failure');
  }
}

/** One piece's tooltip: "piece 3: checked, resent by Bob". */
export function pieceTitle(index: number, p: BtPieceView): string {
  const name = pieceName(index);
  switch (p.state) {
    case 'waiting':
      return `${name}: waiting`;
    case 'uploading':
      return `${name}: uploading`;
    case 'fetching':
      return `${name}: downloading`;
    case 'checked':
      return p.source.kind === 'member'
        ? `${name}: checked, ${resentByText(p.source.member.name)}`
        : `${name}: checked`;
    case 'missing':
      switch (p.reason) {
        case 'notFound':
        case 'network':
          return `${name}: could not be downloaded; asking members`;
        case 'badMac':
          return `${name}: did not arrive intact; asking members`;
        case 'badUpload':
        case 'badReply':
          return `${name}: failed its check; asking members`;
        default:
          throw new Error('pieceTitle: unknown reason');
      }
    case 'asking':
      return `${name}: asking ${p.member.name}`;
    case 'unavailable':
      return `${name}: nobody had it`;
    default:
      throw new Error('pieceTitle: unknown state');
  }
}
