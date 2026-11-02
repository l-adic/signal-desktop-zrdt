// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// The torrent's routes on the desktop's local endpoint (BUILD_M1 §B.10), for
// `zbt` (tools/zbt). Lane transport's endpoint (ts/zrdt/apps/endpoint.node.ts)
// owns the HTTP server, the token and the app scoping; it hands every request
// whose token belongs to app "bt" to `handleBtRequest`. The shapes follow the
// git endpoint (zrdt tools/git-remote-zrdt/ENDPOINT.md, version 1): the same
// hello, errors, upload hand-over and JSON conventions, under /v1/bt/.
//
//   GET  /v1/hello
//   GET  /v1/bt/<group>                          the group's files
//   GET  /v1/bt/<group>/files/<id>               one file
//   POST /v1/bt/<group>/uploads                  {"size": L}
//   PUT  /v1/bt/<group>/uploads/<id>/pieces/<i>  {"sha256", "data"}
//   POST /v1/bt/<group>/shares                   {"upload", "name"}
//
// A share waits for the fork's own dialog: the request stays open until the
// user presses Share or Cancel. No route exposes a pointer, an opening, a
// nonce, a piece key or SERVE; a file is named by A's digest only.

import { fromBase64, toHex } from '../../../Bytes.std.ts';
import type { BtManager, BtTransferView, Bytes } from './manager.std.ts';
import {
  MAX_FILE_BYTES,
  PIECE_BYTES,
  pieceCount,
  pieceName,
  statusText,
} from './manager.std.ts';

export const BT_ENDPOINT_PROTOCOL = 1;

/** An upload hand-over lives this long (ENDPOINT.md §4.3). */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** At most this many hand-overs at once per desktop. */
export const MAX_UPLOADS = 4;

/** A request, as the endpoint parsed it. */
export type BtEndpointRequest = Readonly<{
  method: string;
  /** The path and query, as received (percent-encoded). */
  url: string;
  /** The parsed JSON body; undefined when there is none. */
  body: unknown;
}>;

export type BtEndpointResponse = Readonly<{ status: number; body: unknown }>;

/** A group this member is in, by the alias `zbt` and git use. */
export type BtGroup = Readonly<{
  conversationId: string;
  title: string;
  memberCount: number;
}>;

export type BtRoutesDeps = Readonly<{
  manager: BtManager;
  /** Resolves an alias (the group's title) among this member's groups. */
  findGroup: (alias: string) => BtGroup | undefined;
  /** Us, as the rows show the author. */
  self: () => Readonly<{ aci: string; name: string }>;
  /** SHA-256 of `bytes` (32 bytes). */
  sha256: (bytes: Bytes) => Bytes;
  /** A fresh, unguessable id (hex). */
  randomId: () => string;
  now: () => number;
}>;

type Upload = {
  id: string;
  conversationId: string;
  size: number;
  pieces: Array<Bytes | undefined>;
  expires: number;
};

function error(
  status: number,
  code: string,
  message: string
): BtEndpointResponse {
  return { status, body: { error: code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

/** Splits `/v1/bt/Camping/files/ab` into decoded segments; undefined if bad. */
function segments(url: string): Array<string> | undefined {
  const pathname = url.split('?')[0] ?? '';
  try {
    return pathname
      .split('/')
      .filter(s => s.length > 0)
      .map(s => decodeURIComponent(s));
  } catch {
    return undefined;
  }
}

/** A file as `zbt` sees it: 1-based piece numbers, no secret. */
export type BtFileJson = Readonly<{
  id: string;
  file: string | null;
  name: string | null;
  size: number | null;
  from: string;
  self: boolean;
  state: string;
  status: string;
  pieces: number;
  checked: number;
  pieceStates: ReadonlyArray<string>;
  resent: ReadonlyArray<
    Readonly<{ member: string; pieces: ReadonlyArray<number> }>
  >;
  notices: ReadonlyArray<string>;
  savedTo: string | null;
  failure: string | null;
}>;

export function fileJson(t: BtTransferView): BtFileJson {
  return {
    id: t.id,
    file: t.announcement ?? null,
    name: t.name ?? null,
    size: t.size ?? null,
    from: t.author.name,
    self: t.direction === 'out',
    state: t.phase,
    status: statusText(t),
    pieces: t.pieces.length,
    checked: t.checked,
    pieceStates: t.pieces.map(p => p.state),
    resent: t.resent.map(r => ({
      member: r.member.name,
      pieces: r.pieces.map(i => i + 1),
    })),
    notices: t.notices,
    savedTo: t.savedTo ?? null,
    failure: t.phase === 'failed' ? statusText(t) : null,
  };
}

/**
 * The bt routes of one desktop. Keeps the upload hand-overs in memory: they
 * are local, consumed by a share, and expire after an hour.
 */
export class BtRoutes {
  readonly #deps: BtRoutesDeps;
  readonly #uploads = new Map<string, Upload>();

  constructor(deps: BtRoutesDeps) {
    this.#deps = deps;
  }

  /** Answers one request; 404 `not_found` for any other path. */
  async handle(request: BtEndpointRequest): Promise<BtEndpointResponse> {
    this.#expire();
    const parts = segments(request.url);
    if (parts === undefined) {
      return error(400, 'bad_request', 'bad percent-encoding');
    }
    const { method } = request;
    if (parts.length === 2 && parts[0] === 'v1' && parts[1] === 'hello') {
      return method === 'GET'
        ? this.#hello()
        : error(405, 'bad_method', 'GET only');
    }
    if (parts.length < 3 || parts[0] !== 'v1' || parts[1] !== 'bt') {
      return error(404, 'not_found', 'no such route');
    }
    const group = this.#deps.findGroup(parts[2] ?? '');
    if (group === undefined) {
      // A group we are not in looks exactly like one that does not exist.
      return error(404, 'no_group', 'no such group');
    }
    const rest = parts.slice(3);
    const [first, second, third, fourth] = rest;

    if (rest.length === 0) {
      return method === 'GET'
        ? this.#list(group)
        : error(405, 'bad_method', 'GET only');
    }
    if (first === 'files' && rest.length === 2 && second !== undefined) {
      return method === 'GET'
        ? this.#file(group, second)
        : error(405, 'bad_method', 'GET only');
    }
    if (first === 'uploads' && rest.length === 1) {
      return method === 'POST'
        ? this.#newUpload(group, request.body)
        : error(405, 'bad_method', 'POST only');
    }
    if (
      first === 'uploads' &&
      rest.length === 4 &&
      second !== undefined &&
      third === 'pieces' &&
      fourth !== undefined
    ) {
      return method === 'PUT'
        ? this.#putPiece(group, second, fourth, request.body)
        : error(405, 'bad_method', 'PUT only');
    }
    if (first === 'shares' && rest.length === 1) {
      return method === 'POST'
        ? this.#share(group, request.body)
        : error(405, 'bad_method', 'POST only');
    }
    return error(404, 'not_found', 'no such route');
  }

  #hello(): BtEndpointResponse {
    return {
      status: 200,
      body: {
        protocol: BT_ENDPOINT_PROTOCOL,
        app: 'bt',
        member: this.#deps.self().name,
        pieceSize: PIECE_BYTES,
        maxStream: MAX_FILE_BYTES,
      },
    };
  }

  #list(group: BtGroup): BtEndpointResponse {
    const files = this.#deps.manager
      .transfersOf(group.conversationId)
      .map(fileJson);
    return {
      status: 200,
      body: { group: group.title, members: group.memberCount, files },
    };
  }

  #file(group: BtGroup, id: string): BtEndpointResponse {
    const t = this.#deps.manager.transfer(id);
    if (t === undefined || t.conversationId !== group.conversationId) {
      return error(404, 'not_found', 'no such file');
    }
    return { status: 200, body: fileJson(t) };
  }

  #newUpload(group: BtGroup, body: unknown): BtEndpointResponse {
    const size = isRecord(body) ? body.size : undefined;
    if (typeof size !== 'number' || !Number.isSafeInteger(size)) {
      return error(400, 'bad_request', 'size must be an integer');
    }
    if (size < 1 || size > MAX_FILE_BYTES) {
      return error(413, 'too_large', `size must be 1 to ${MAX_FILE_BYTES}`);
    }
    if (this.#uploads.size >= MAX_UPLOADS) {
      return error(413, 'too_large', 'too many uploads at once');
    }
    const id = this.#deps.randomId();
    const pieces = pieceCount(size);
    this.#uploads.set(id, {
      id,
      conversationId: group.conversationId,
      size,
      pieces: Array.from({ length: pieces }, () => undefined),
      expires: this.#deps.now() + UPLOAD_TTL_MS,
    });
    return {
      status: 201,
      body: { upload: id, pieceSize: PIECE_BYTES, pieces },
    };
  }

  #putPiece(
    group: BtGroup,
    id: string,
    indexText: string,
    body: unknown
  ): BtEndpointResponse {
    const upload = this.#uploads.get(id);
    if (
      upload === undefined ||
      upload.conversationId !== group.conversationId
    ) {
      return error(404, 'no_upload', 'no such upload');
    }
    if (!/^(0|[1-9][0-9]*)$/.test(indexText)) {
      return error(400, 'bad_request', 'bad piece index');
    }
    const index = Number(indexText);
    if (index >= upload.pieces.length) {
      return error(400, 'bad_request', 'piece index out of range');
    }
    if (
      !isRecord(body) ||
      typeof body.data !== 'string' ||
      typeof body.sha256 !== 'string'
    ) {
      return error(400, 'bad_request', 'need "data" and "sha256"');
    }
    let data: Bytes;
    try {
      data = fromBase64(body.data);
    } catch {
      return error(400, 'bad_request', 'data is not base64');
    }
    const want =
      index === upload.pieces.length - 1
        ? upload.size - index * PIECE_BYTES
        : PIECE_BYTES;
    if (data.byteLength !== want) {
      return error(
        400,
        'bad_piece',
        `${pieceName(index)} must be ${want} bytes, not ${data.byteLength}`
      );
    }
    if (toHex(this.#deps.sha256(data)) !== body.sha256.toLowerCase()) {
      return error(400, 'bad_piece', `${pieceName(index)}: sha256 differs`);
    }
    upload.pieces[index] = data;
    return { status: 200, body: { ok: true } };
  }

  async #share(group: BtGroup, body: unknown): Promise<BtEndpointResponse> {
    if (
      !isRecord(body) ||
      typeof body.upload !== 'string' ||
      typeof body.name !== 'string'
    ) {
      return error(400, 'bad_request', 'need "upload" and "name"');
    }
    const upload = this.#uploads.get(body.upload);
    if (
      upload === undefined ||
      upload.conversationId !== group.conversationId
    ) {
      return error(404, 'no_upload', 'no such upload');
    }
    const missing = upload.pieces.findIndex(p => p === undefined);
    if (missing >= 0) {
      return error(400, 'bad_request', `${pieceName(missing)} not uploaded`);
    }
    const stream = new Uint8Array(upload.size);
    upload.pieces.forEach((p, i) => {
      if (p !== undefined) {
        stream.set(p, i * PIECE_BYTES);
      }
    });
    // One share per hand-over, whatever the answer.
    this.#uploads.delete(upload.id);

    const outcome = await this.#deps.manager.share({
      conversationId: group.conversationId,
      groupTitle: group.title,
      memberCount: group.memberCount,
      self: this.#deps.self(),
      name: body.name,
      stream,
    });
    switch (outcome.kind) {
      case 'published':
        return {
          status: 200,
          body: {
            status: 'ok',
            id: outcome.id,
            file: outcome.announcement,
            audience: outcome.audience,
          },
        };
      case 'declined':
        return {
          status: 409,
          body: {
            status: 'refused',
            reason: 'DECLINED',
            message: 'the share was cancelled in Signal',
          },
        };
      case 'refused':
        return {
          status: 409,
          body: {
            status: 'refused',
            reason: refusalCode(outcome.reason),
            message: outcome.detail ?? refusalCode(outcome.reason),
          },
        };
      default:
        throw new Error('BtRoutes: unknown share outcome');
    }
  }

  #expire(): void {
    const now = this.#deps.now();
    for (const [id, upload] of this.#uploads) {
      if (upload.expires <= now) {
        this.#uploads.delete(id);
      }
    }
  }
}

/** badName -> BAD_NAME, tooLarge -> TOO_LARGE. */
function refusalCode(reason: string): string {
  return reason.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}
