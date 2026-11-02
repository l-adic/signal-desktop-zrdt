// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// zbt's client for a desktop's local endpoint (BUILD_M1 §B.10; the bt routes
// in ts/zrdt/apps/bt/routes.std.ts, shaped like zrdt's
// tools/git-remote-zrdt/ENDPOINT.md). No dependencies beyond Node: run it
// with `node tools/zbt/zbt.ts` (Node 24 strips the types).
//
// Where the endpoint is, first match wins:
//   --endpoint, then ZRDT_ENDPOINT, then ZRDT_SOCKET (a path), then ZRDT_URL.
//   A value is `http://127.0.0.1:<port>`, `unix:<path>`, or the path of the
//   desktop's endpoint file (`<userData>/zrdt-apps.json`), which holds
//   {"endpoint": "...", "tokens": {"bt": "..."}} or {"port": N, ...}.
// The token, first match wins:
//   ZRDT_TOKEN, the file named by --token-file or ZRDT_TOKEN_FILE, then the
//   endpoint file's tokens.bt, then the file its tokenFiles.bt names.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';

export const PROTOCOL = 1;

export type Endpoint =
  | Readonly<{ kind: 'tcp'; host: string; port: number }>
  | Readonly<{ kind: 'unix'; path: string }>;

export type Discovery = Readonly<{
  endpoint: Endpoint;
  token: string;
}>;

export type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `http://127.0.0.1:7470` or `unix:/path`; undefined for anything else. */
export function parseEndpoint(value: string): Endpoint | undefined {
  if (value.startsWith('unix:')) {
    const p = value.slice('unix:'.length);
    return p.length > 0 ? { kind: 'unix', path: p } : undefined;
  }
  if (!value.startsWith('http://')) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  // Loopback only: a client refuses any other host (ENDPOINT.md §1).
  if (!LOOPBACK.has(url.hostname) || url.port === '') {
    return undefined;
  }
  const host = url.hostname === '[::1]' ? '::1' : url.hostname;
  return { kind: 'tcp', host, port: Number(url.port) };
}

export class ZbtError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type EndpointFile = {
  endpoint?: unknown;
  url?: unknown;
  port?: unknown;
  socket?: unknown;
  tokens?: unknown;
  tokenFiles?: unknown;
};

function field(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj != null
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

async function readToken(
  file: string,
  readFile: (p: string) => Promise<string>
): Promise<string> {
  const token = (await readFile(file)).trim();
  if (token.length === 0) {
    throw new ZbtError('no_token', `the token file ${file} is empty`);
  }
  return token;
}

/** Finds the endpoint and the token (see the header). */
export async function discover(
  env: Env,
  flags: Readonly<{ endpoint?: string; tokenFile?: string }>,
  readFile: (p: string) => Promise<string> = p => fs.readFile(p, 'utf8')
): Promise<Discovery> {
  const raw =
    flags.endpoint ??
    env.ZRDT_ENDPOINT ??
    (env.ZRDT_SOCKET === undefined ? undefined : `unix:${env.ZRDT_SOCKET}`) ??
    env.ZRDT_URL;
  if (raw === undefined || raw.length === 0) {
    throw new ZbtError(
      'no_endpoint',
      'no endpoint: set ZRDT_ENDPOINT (http://127.0.0.1:<port>, unix:<path>, ' +
        "or the desktop's zrdt-apps.json), or pass --endpoint"
    );
  }

  let endpoint = parseEndpoint(raw);
  let fileData: EndpointFile | undefined;
  if (endpoint === undefined) {
    if (raw.startsWith('http')) {
      throw new ZbtError(
        'bad_endpoint',
        `${raw}: only http://127.0.0.1:<port> (loopback) is allowed`
      );
    }
    let text: string;
    try {
      text = await readFile(raw);
    } catch {
      throw new ZbtError('no_endpoint', `cannot read the endpoint file ${raw}`);
    }
    try {
      fileData = JSON.parse(text) as EndpointFile;
    } catch {
      throw new ZbtError('bad_endpoint', `${raw} is not JSON`);
    }
    const inner = fileData.endpoint ?? fileData.url;
    if (typeof inner === 'string') {
      endpoint = parseEndpoint(inner);
    } else if (typeof fileData.socket === 'string') {
      endpoint = { kind: 'unix', path: fileData.socket };
    } else if (typeof fileData.port === 'number') {
      endpoint = { kind: 'tcp', host: '127.0.0.1', port: fileData.port };
    }
    if (endpoint === undefined) {
      throw new ZbtError('bad_endpoint', `${raw} names no loopback endpoint`);
    }
  }

  let token: string | undefined = env.ZRDT_TOKEN;
  const tokenFile = flags.tokenFile ?? env.ZRDT_TOKEN_FILE;
  if ((token === undefined || token.length === 0) && tokenFile !== undefined) {
    token = await readToken(tokenFile, readFile);
  }
  if (token === undefined || token.length === 0) {
    const inline = field(fileData?.tokens, 'bt');
    const named = field(fileData?.tokenFiles, 'bt');
    if (typeof inline === 'string' && inline.length > 0) {
      token = inline;
    } else if (typeof named === 'string') {
      token = await readToken(named, readFile);
    }
  }
  if (token === undefined || token.length === 0) {
    throw new ZbtError(
      'no_token',
      'no token: set ZRDT_TOKEN or ZRDT_TOKEN_FILE (<userData>/zrdt-apps-bt.token)'
    );
  }
  return { endpoint, token };
}

export type Reply = Readonly<{ status: number; body: unknown }>;

/** One JSON request. `timeoutMs` 0 waits forever (a share waits for a click). */
export function call(
  d: Discovery,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000
): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const target =
    d.endpoint.kind === 'unix'
      ? { socketPath: d.endpoint.path }
      : { host: d.endpoint.host, port: d.endpoint.port };
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...target,
        method,
        path,
        headers: {
          authorization: `Bearer ${d.token}`,
          'x-zrdt-protocol': String(PROTOCOL),
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = text.length === 0 ? undefined : JSON.parse(text);
          } catch {
            parsed = { error: 'bad_reply', message: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', reject);
      }
    );
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new ZbtError('timeout', `${method} ${path} timed out`));
      });
    }
    req.on('error', error => {
      reject(
        error instanceof ZbtError
          ? error
          : new ZbtError(
              'not_running',
              `cannot reach the desktop (${error.message}); is Signal running?`
            )
      );
    });
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

function errorOf(reply: Reply): ZbtError {
  const code = field(reply.body, 'error');
  const message = field(reply.body, 'message');
  return new ZbtError(
    typeof code === 'string' ? code : `http_${reply.status}`,
    typeof message === 'string' ? message : `HTTP ${reply.status}`
  );
}

/** `/v1/bt/<group>[/...]`, percent-encoded. */
export function groupPath(
  group: string,
  ...rest: ReadonlyArray<string>
): string {
  return ['', 'v1', 'bt', group, ...rest]
    .map(s => encodeURIComponent(s))
    .join('/');
}

export async function hello(d: Discovery): Promise<Record<string, unknown>> {
  const reply = await call(d, 'GET', '/v1/hello');
  if (reply.status !== 200) {
    throw errorOf(reply);
  }
  const body = reply.body as Record<string, unknown>;
  if (body.protocol !== PROTOCOL || body.app !== 'bt') {
    throw new ZbtError(
      'bad_protocol',
      `the endpoint speaks ${String(body.app)} protocol ${String(body.protocol)}, not bt ${PROTOCOL}`
    );
  }
  return body;
}

/** A file as the endpoint reports it (routes.std.ts `BtFileJson`). */
export type FileJson = Readonly<{
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

export type ListJson = Readonly<{
  group: string;
  members: number;
  files: ReadonlyArray<FileJson>;
}>;

export async function list(d: Discovery, group: string): Promise<ListJson> {
  const reply = await call(d, 'GET', groupPath(group));
  if (reply.status !== 200) {
    throw errorOf(reply);
  }
  return reply.body as ListJson;
}

export async function status(
  d: Discovery,
  group: string,
  id: string
): Promise<FileJson> {
  const reply = await call(d, 'GET', groupPath(group, 'files', id));
  if (reply.status !== 200) {
    throw errorOf(reply);
  }
  return reply.body as FileJson;
}

export type ShareResult =
  | Readonly<{ status: 'ok'; id: string; file: string; audience: number }>
  | Readonly<{ status: 'refused'; reason: string; message: string }>;

/**
 * Hands the file over piece by piece, then asks for the share. Resolves when
 * the user answered the desktop's dialog (and the publish finished).
 */
export async function share(
  d: Discovery,
  group: string,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  onPiece?: (index: number, total: number) => void
): Promise<ShareResult> {
  const created = await call(d, 'POST', groupPath(group, 'uploads'), {
    size: bytes.byteLength,
  });
  if (created.status !== 201) {
    throw errorOf(created);
  }
  const upload = field(created.body, 'upload');
  const pieceSize = field(created.body, 'pieceSize');
  const pieces = field(created.body, 'pieces');
  if (
    typeof upload !== 'string' ||
    typeof pieceSize !== 'number' ||
    typeof pieces !== 'number'
  ) {
    throw new ZbtError('bad_reply', 'the upload reply is malformed');
  }
  for (let i = 0; i < pieces; i += 1) {
    const slice = bytes.subarray(i * pieceSize, (i + 1) * pieceSize);
    // oxlint-disable-next-line no-await-in-loop
    const put = await call(
      d,
      'PUT',
      groupPath(group, 'uploads', upload, 'pieces', String(i)),
      {
        sha256: createHash('sha256').update(slice).digest('hex'),
        data: Buffer.from(slice).toString('base64'),
      }
    );
    if (put.status !== 200) {
      throw errorOf(put);
    }
    onPiece?.(i, pieces);
  }
  const shared = await call(
    d,
    'POST',
    groupPath(group, 'shares'),
    { upload, name },
    0
  );
  if (shared.status === 200 || shared.status === 409) {
    return shared.body as ShareResult;
  }
  throw errorOf(shared);
}

const DONE = new Set(['checked', 'failed']);

/** Polls one file until it is checked or failed (or `timeoutMs` passes). */
export async function waitDone(
  d: Discovery,
  group: string,
  id: string,
  timeoutMs: number,
  intervalMs = 500
): Promise<FileJson> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let last: FileJson | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop
      last = await status(d, group, id);
    } catch (error) {
      if (!(error instanceof ZbtError) || error.code !== 'not_found') {
        throw error;
      }
    }
    if (last !== undefined && DONE.has(last.state)) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new ZbtError(
        'timeout',
        `file ${id.slice(0, 8)} is ${last?.state ?? 'not there'} after ${timeoutMs} ms`
      );
    }
    // oxlint-disable-next-line no-await-in-loop
    await new Promise(resolve => {
      setTimeout(resolve, intervalMs);
    });
  }
}
