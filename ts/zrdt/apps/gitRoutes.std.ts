// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The git routes of the local endpoint (zrdt tools/git-remote-zrdt/
// ENDPOINT.md, version 1; zrdt docs/apps/BUILD_M1.md §B.10): what
// `git-remote-zrdt` and `git zrdt` call. Git work stays in the helper, zrdt
// work in the desktop: this module validates the JSON, keeps the uploads (a
// local hand-over only), and maps the calls onto a `GitDesk`, which the
// transport implements with GIT_VIEW, GIT_PREPARE and the piece stores. It
// also maps zrdtd's refusals onto ENDPOINT.md's reasons.
//
// Never returned: a pointer, an opening, a nonce, a piece key, a SERVE
// request. A share is published only after the desk's own dialog.

import type {
  AppSeat,
  GitPrepareResult,
  GitUpdate,
  Oid,
} from '../ZrdtBackend.std.ts';
import type {
  AppGroup,
  Route,
  RouteRequest,
  RouteResponse,
} from './api.std.ts';
import { RouteError } from './api.std.ts';
import {
  APP_GIT,
  compareStrings,
  concat,
  fromHex,
  toHex,
} from './appMessage.std.ts';
import { validRefName, validRepoName } from './gitBody.std.ts';
import type { RepoStateJson } from './gitFetch.std.ts';

type Bytes = Uint8Array<ArrayBuffer>;

/** ENDPOINT.md's protocol version. */
export const ENDPOINT_PROTOCOL = 1;

/** Uploads expire after an hour (ENDPOINT §4.3). */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

const OID = /^[0-9a-f]{64}$/;

/** A push the helper asks for, validated (ENDPOINT §4.5). */
export type GitPushPlan = Readonly<{
  /** The upload's stream: the raw objects, sorted by id (empty for none). */
  stream: Bytes;
  /** The record's object list, strictly increasing (hex). */
  objects: ReadonlyArray<string>;
  updates: ReadonlyArray<GitUpdate>;
  share: boolean;
  /** The covers the user confirmed in `git zrdt share` (names), or null. */
  covers: ReadonlyArray<string> | null;
  create: boolean;
  dryRun: boolean;
}>;

/** ENDPOINT §4.5's replies: `ok` (200) or a refusal (409; nothing was sent). */
export type GitPushOutcome =
  | Readonly<{
      status: 'ok';
      record: string | null;
      audience: ReadonlyArray<string>;
      covers: ReadonlyArray<string>;
    }>
  | Readonly<{
      status: 'refused';
      reason: string;
      message: string;
      [extra: string]: unknown;
    }>;

/** What the routes need from the desktop. */
export type GitDesk = Readonly<{
  /** False until Signal is linked and zrdtd speaks protocol 5 (503 `not_running`). */
  running(): boolean;
  /** This account's display name. */
  member(): string;
  /** The group the alias names, if this account is a member (else 404 `no_group`). */
  findGroup(alias: string): Promise<AppGroup | undefined>;
  repoState(group: AppGroup, repo: string): Promise<RepoStateJson>;
  /** The raw objects some held, applied record carries; the rest are missing. */
  objects(
    group: AppGroup,
    repo: string,
    ids: ReadonlyArray<string>
  ): Promise<{
    found: Array<{ id: string; raw: Bytes }>;
    missing: Array<string>;
  }>;
  /** Checks, then (unless a dry run) the dialog for a share, uploads, freeze, send. */
  push(
    group: AppGroup,
    repo: string,
    plan: GitPushPlan
  ): Promise<GitPushOutcome>;
}>;

export type GitRoutesOptions = Readonly<{
  /** The piece size uploads use: 1 MiB on hosts. */
  pieceSize: number;
  /** At most this many bytes of objects per push (64 MiB in M1). */
  maxStream: number;
  maxObjectsPerRequest: number;
  now?: () => number;
}>;

type Upload = {
  conversationId: string;
  repo: string;
  size: number;
  count: number;
  pieces: Map<number, Bytes>;
  created: number;
};

function base64ToBytes(text: string): Bytes | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    return undefined;
  }
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(
    new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  );
}

function bad(message: string): RouteError {
  return new RouteError(400, 'bad_request', message);
}

/** A list of strings that each pass `ok`, or undefined. */
function stringList(
  value: unknown,
  ok: (s: string) => boolean
): Array<string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = new Array<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !ok(item)) {
      return undefined;
    }
    out.push(item);
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function oidOf(hex: string): Oid {
  const out = fromHex(hex);
  if (out === undefined || out.length !== 32) {
    throw bad(`not an object id: ${hex}`);
  }
  return out;
}

/**
 * ENDPOINT's updates as zrdtd's (one `old` per update). M1's body holds one
 * old value per update and distinct names, so an update that merges several
 * concurrent values (`old` with more than one id) is refused here.
 */
export function parseUpdates(raw: unknown): Array<GitUpdate> {
  if (!Array.isArray(raw)) {
    throw bad('updates must be a list');
  }
  const names = new Set<string>();
  const out = new Array<GitUpdate>();
  for (const u of raw) {
    if (!isObject(u)) {
      throw bad('an update is an object');
    }
    const { name, old = [], new: next = null, forced = false } = u;
    if (typeof name !== 'string' || names.has(name)) {
      throw bad('update names must be distinct strings');
    }
    if (
      !Array.isArray(old) ||
      !old.every(v => typeof v === 'string' && OID.test(v)) ||
      old.length > 1
    ) {
      throw bad(
        'old must be a list of at most one object id (merging concurrent values is not in M1)'
      );
    }
    if (next != null && (typeof next !== 'string' || !OID.test(next))) {
      throw bad('new must be an object id or null');
    }
    if (typeof forced !== 'boolean') {
      throw bad('forced must be a boolean');
    }
    names.add(name);
    const first: string | undefined = old[0];
    out.push({
      name,
      ...(first === undefined ? {} : { old: oidOf(first) }),
      ...(typeof next === 'string' ? { new: oidOf(next) } : {}),
      forced,
    });
  }
  return out.sort((a, b) => compareStrings(a.name, b.name));
}

/**
 * zrdtd's GIT_PREPARE refusal as ENDPOINT §4.5's 409 body, or undefined for
 * `ok`. `nameOf` names a seat (a member of the group). A refusal that is not
 * about the push (the host's openings, the channel) is a 500.
 */
export function refusalOf(
  result: GitPrepareResult,
  nameOf: (seat: AppSeat) => string
): GitPushOutcome | undefined {
  switch (result.kind) {
    case 'ok':
      return undefined;
    case 'badObjects':
      return {
        status: 'refused',
        reason: result.reason === 'name' ? 'BAD_REF' : 'BAD_OBJECTS',
        message: `the objects or names do not pass (${result.reason})`,
        objects: result.oid === undefined ? [] : [toHex(result.oid)],
      };
    case 'pushRefused': {
      const oids = result.oids.map(toHex);
      switch (result.reason) {
        case 'root':
          return {
            status: 'refused',
            reason: 'ROOT',
            message:
              'a root commit cannot be pushed from a table that is not complete',
            objects: oids,
          };
        case 'oldObject':
          return {
            status: 'refused',
            reason: 'OLD_OBJECT',
            message: `${oids.length} object(s) were already carried by earlier pushes`,
            objects: oids,
          };
        case 'gate': {
          const seats = result.seats.map(({ seat, mark }) => ({
            member: nameOf(seat),
            reason: mark === 'keyChanged' ? 'KEY_CHANGED' : 'NEW',
            missing: oids.length,
            names: [...result.refs],
          }));
          const who = seats.map(s => s.member).join(', ');
          return {
            status: 'refused',
            reason: 'GATE',
            message:
              `${who} ${seats.length === 1 ? 'has' : 'have'} not been given ` +
              `the history this push builds on`,
            seats,
          };
        }
        case 'badShare':
          return {
            status: 'refused',
            reason: 'BAD_SHARE',
            message:
              'a share carries exactly its updates’ commits with their trees, and deletes nothing',
          };
        case 'keyChanged': {
          const seats = result.seats.map(({ seat }) => ({
            member: nameOf(seat),
            reason: 'KEY_CHANGED',
          }));
          return {
            status: 'refused',
            reason: 'KEY_CHANGED',
            message: `a share would cover ${seats.map(s => s.member).join(', ')}, whose key changed`,
            seats,
          };
        }
        case 'coversChanged': {
          const covers = result.seats.map(({ seat }) => nameOf(seat)).sort();
          return {
            status: 'refused',
            reason: 'COVERS_CHANGED',
            message: `this share covers: ${covers.join(', ') || 'nobody'}`,
            covers,
          };
        }
        default:
          throw new RouteError(500, 'internal', 'unknown refusal');
      }
    }
    case 'openingsMissing':
    case 'badOpening':
    case 'badApp':
      throw new RouteError(
        500,
        'internal',
        `the desktop's git channel cannot be checked (${result.kind})`
      );
    default:
      throw new RouteError(500, 'internal', 'unknown reply');
  }
}

/** The git app's routes for the endpoint. */
export function gitRoutes(
  desk: GitDesk,
  options: GitRoutesOptions
): Array<Route> {
  const now = options.now ?? (() => Date.now());
  const uploads = new Map<string, Upload>();
  let uploadCounter = 0;

  const ready = (): void => {
    if (!desk.running()) {
      throw new RouteError(
        503,
        'not_running',
        'Signal is not linked or zrdt is not running'
      );
    }
  };

  const group = async (req: RouteRequest): Promise<AppGroup> => {
    ready();
    const alias = req.params.group ?? '';
    if (
      alias.length < 1 ||
      alias.length > 64 ||
      alias.includes('/') ||
      /[\x00-\x1f\x7f]/.test(alias) ||
      alias.trim() !== alias
    ) {
      throw bad('not a group name');
    }
    const found = await desk.findGroup(alias);
    if (found === undefined) {
      throw new RouteError(404, 'no_group', `no group ${alias}`);
    }
    return found;
  };

  const repoOf = (req: RouteRequest): string => {
    const repo = req.params.repo ?? '';
    if (!validRepoName(repo)) {
      throw bad(
        'a repository name is 1-64 of A-Za-z0-9._-, starting with a letter or digit'
      );
    }
    return repo;
  };

  const expire = (): void => {
    for (const [id, u] of uploads) {
      if (now() - u.created > UPLOAD_TTL_MS) {
        uploads.delete(id);
      }
    }
  };

  const ok = (body: unknown, status = 200): RouteResponse => ({ status, body });

  return [
    {
      method: 'GET',
      pattern: '/v1/hello',
      handle: async () =>
        ok({
          protocol: ENDPOINT_PROTOCOL,
          app: APP_GIT,
          objectFormat: 'sha256',
          member: desk.member(),
          pieceSize: options.pieceSize,
          maxStream: options.maxStream,
          maxObjectsPerRequest: options.maxObjectsPerRequest,
        }),
    },
    {
      method: 'GET',
      pattern: '/v1/git/:group/:repo',
      handle: async req => {
        const g = await group(req);
        return ok(await desk.repoState(g, repoOf(req)));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/git/:group/:repo/uploads',
      handle: async req => {
        const g = await group(req);
        const repo = repoOf(req);
        const size = isObject(req.body) ? req.body.size : undefined;
        if (
          typeof size !== 'number' ||
          !Number.isSafeInteger(size) ||
          size < 1
        ) {
          throw bad('size: the stream length, at least 1');
        }
        if (size > options.maxStream) {
          throw new RouteError(
            413,
            'too_large',
            `an object stream is at most ${options.maxStream} bytes`
          );
        }
        expire();
        uploadCounter += 1;
        const id = `u${uploadCounter}-${toHex(
          globalThis.crypto.getRandomValues(new Uint8Array(8))
        )}`;
        const count = Math.ceil(size / options.pieceSize);
        uploads.set(id, {
          conversationId: g.conversationId,
          repo,
          size,
          count,
          pieces: new Map(),
          created: now(),
        });
        return ok(
          { upload: id, pieceSize: options.pieceSize, pieces: count },
          201
        );
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/git/:group/:repo/uploads/:upload/pieces/:index',
      handle: async req => {
        const g = await group(req);
        const repo = repoOf(req);
        expire();
        const u = uploads.get(req.params.upload ?? '');
        if (
          u === undefined ||
          u.conversationId !== g.conversationId ||
          u.repo !== repo
        ) {
          throw new RouteError(404, 'no_upload', 'no such upload');
        }
        const index = Number(req.params.index);
        if (!Number.isSafeInteger(index) || index < 0 || index >= u.count) {
          throw bad('piece index out of range');
        }
        const body = isObject(req.body) ? req.body : {};
        const data =
          typeof body.data === 'string' ? base64ToBytes(body.data) : undefined;
        if (data === undefined) {
          throw bad('piece data is not base64');
        }
        const want =
          index < u.count - 1
            ? options.pieceSize
            : u.size - options.pieceSize * (u.count - 1);
        if (data.length !== want) {
          throw new RouteError(
            400,
            'bad_piece',
            `piece ${index} has ${data.length} bytes, expected ${want}`
          );
        }
        if ((await sha256Hex(data)) !== body.sha256) {
          throw new RouteError(
            400,
            'bad_piece',
            `piece ${index} does not match its sha256`
          );
        }
        u.pieces.set(index, data);
        return ok({ ok: true });
      },
    },
    {
      method: 'POST',
      pattern: '/v1/git/:group/:repo/objects',
      handle: async req => {
        const g = await group(req);
        const repo = repoOf(req);
        const ids = stringList(
          isObject(req.body) ? req.body.ids : undefined,
          s => OID.test(s)
        );
        if (ids === undefined || ids.length > options.maxObjectsPerRequest) {
          throw bad(`ids: at most ${options.maxObjectsPerRequest} object ids`);
        }
        const { found, missing } = await desk.objects(g, repo, ids);
        return ok({
          objects: found.map(o => ({ id: o.id, raw: bytesToBase64(o.raw) })),
          missing,
        });
      },
    },
    {
      method: 'POST',
      pattern: '/v1/git/:group/:repo/pushes',
      handle: async req => {
        const g = await group(req);
        const repo = repoOf(req);
        if (!isObject(req.body)) {
          throw bad('a push is an object');
        }
        const b = req.body;
        const updates = parseUpdates(b.updates);
        const objects = stringList(b.objects ?? [], s => OID.test(s));
        if (objects === undefined) {
          throw bad('objects must be a list of object ids');
        }
        const covers =
          b.covers == null ? null : stringList(b.covers, () => true);
        if (covers === undefined) {
          throw bad('covers must be null or a list of members');
        }
        const refusal = (
          reason: string,
          message: string,
          extra = {}
        ): RouteResponse => ({
          status: 409,
          body: { status: 'refused', reason, message, ...extra },
        });
        const sorted = [...new Set(objects)].sort();
        if (
          sorted.length !== objects.length ||
          sorted.some((o, i) => o !== objects[i])
        ) {
          return refusal(
            'BAD_OBJECTS',
            'object ids must be strictly increasing'
          );
        }
        for (const u of updates) {
          if (!validRefName(u.name)) {
            return refusal('BAD_REF', `${u.name}: not a ref name M1 takes`, {
              name: u.name,
            });
          }
        }
        if (updates.length === 0) {
          return refusal('BAD_REF', 'a push updates at least one ref');
        }
        if (updates.length > 16) {
          return refusal('BAD_REF', 'at most 16 ref updates per push');
        }
        let stream: Bytes = new Uint8Array(0);
        const uploadId = b.upload ?? null;
        if (objects.length > 0) {
          expire();
          const u =
            typeof uploadId === 'string' ? uploads.get(uploadId) : undefined;
          if (
            u === undefined ||
            u.conversationId !== g.conversationId ||
            u.repo !== repo
          ) {
            return refusal(
              'BAD_OBJECTS',
              'the push lists objects but names no upload of yours'
            );
          }
          if (u.pieces.size !== u.count) {
            return refusal(
              'BAD_OBJECTS',
              `the upload is missing ${u.count - u.pieces.size} piece(s)`
            );
          }
          stream = concat(
            Array.from(
              { length: u.count },
              (_, i) => u.pieces.get(i) ?? new Uint8Array(0)
            )
          );
        } else if (uploadId != null) {
          return refusal(
            'BAD_OBJECTS',
            'an upload was named but no objects were listed'
          );
        }
        const outcome = await desk.push(g, repo, {
          stream,
          objects,
          updates,
          share: b.share === true,
          covers,
          create: b.create === true,
          dryRun: b.dryRun === true,
        });
        if (outcome.status === 'ok') {
          if (outcome.record != null && typeof uploadId === 'string') {
            uploads.delete(uploadId);
          }
          return ok(outcome);
        }
        return { status: 409, body: outcome };
      },
    },
  ];
}
