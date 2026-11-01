// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// doctor.ts: the "tampered copy" of demo beats 4 and 5 (APP.md §9,
// RESTORE_PLAN.md §6). It edits an exported zrdt store.
//
//   remove   (beat 4) drop ONE linked, non-head record from the store blob and
//            fix the count. OPEN of the result fails: the records that link
//            the removed one cannot be accepted, and `missing` names it.
//   append   (beat 5) add two fake records attributed to `--author` (Bob) on
//            top of the genuine head. zrdtd builds them: OPEN the blob under a
//            scratch chat key, ACCEPT two records whose links are the current
//            heads (random commits), ENCODE. The result passes OPEN; only live
//            messages expose the fakes.
//
// Run from the repository root:
//   node --import tsx demo/doctor.ts remove <export> [<out>] [--digest <hex>]
//   node --import tsx demo/doctor.ts append <export> [<out>] --author <aci>
//        [--count 2] [--daemon <zrdtd>]
//   node --import tsx demo/doctor.ts show <export>
// <out> defaults to <export> with ".doctored" before the extension.
//
// Store blob: "zrdtS2" ‖ group(32) ‖ u32 count ‖ (u32 len ‖ record)*, sorted
// by digest. Record: "zrdt2" ‖ group(32) ‖ commit(32) ‖ u32 nlinks ‖
// links(32 each) ‖ author(16). Digest = SHA-256 of the record bytes.
// (docs/PLAN.md §3.4.)
//
// The export file: lane T3 writes the raw store blob
// (<profile>/zrdt-export-<conversation id>.bin). A container that holds a
// blob (RESTORE_PLAN.md §5 adds a content section later) also works: the blob
// is found by its magic; see `locateBlob`.
// The app's export is a JSON dump with a content section (RESTORE_PLAN.md §3);
// `remove` drops the removed record's content entry too.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BLOB_MAGIC = Buffer.from('zrdtS2', 'ascii');
export const RECORD_MAGIC = Buffer.from('zrdt2', 'ascii');
// Every byte buffer here owns its memory (Signal's enforce-array-buffer rule).
export type Bytes = Buffer<ArrayBuffer>;

const DIGEST = 32;
const ACI = 16;
const MAX_COUNT = 2 ** 24;

// --- Blob framing --------------------------------------------------------------

export type StoreBlob = Readonly<{
  group: Bytes;
  // Encoded records, in file order.
  records: ReadonlyArray<Bytes>;
}>;

/** Parses a store blob's framing. `bytes` must be exactly one blob. */
export function parseBlob(bytes: Uint8Array<ArrayBuffer>): StoreBlob {
  const { blob, length } = parseBlobPrefix(Buffer.from(bytes), 0);
  if (length !== bytes.length) {
    throw new Error(
      `${bytes.length - length} bytes after the store blob's last record`
    );
  }
  return blob;
}

/** Parses the store blob that starts at `offset`; returns it and its length. */
export function parseBlobPrefix(
  buf: Bytes,
  offset: number
): { blob: StoreBlob; length: number } {
  let at = offset;
  const need = (n: number, what: string) => {
    if (at + n > buf.length) {
      throw new Error(`the store blob is cut short in ${what}`);
    }
  };
  need(BLOB_MAGIC.length + DIGEST + 4, 'its header');
  if (!buf.subarray(at, at + BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
    throw new Error('not a zrdt store blob (no "zrdtS2" magic)');
  }
  at += BLOB_MAGIC.length;
  const group = Buffer.from(buf.subarray(at, at + DIGEST));
  at += DIGEST;
  const count = buf.readUInt32BE(at);
  at += 4;
  if (count >= MAX_COUNT) {
    throw new Error(`count ${count} is beyond zrdt's limit`);
  }
  const records: Array<Bytes> = [];
  for (let i = 0; i < count; i += 1) {
    need(4, `the length of record ${i}`);
    const len = buf.readUInt32BE(at);
    at += 4;
    need(len, `record ${i}`);
    records.push(Buffer.from(buf.subarray(at, at + len)));
    at += len;
  }
  return { blob: { group, records }, length: at - offset };
}

/** Encodes a store blob; records are written in the given order. */
export function encodeBlob(blob: StoreBlob): Bytes {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(blob.records.length);
  const parts: Array<Bytes> = [BLOB_MAGIC, blob.group, head];
  for (const r of blob.records) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(r.length);
    parts.push(len, r);
  }
  return Buffer.concat(parts);
}

// --- Records -----------------------------------------------------------------

export type RecordParts = Readonly<{
  group: Bytes;
  commit: Bytes;
  links: ReadonlyArray<Bytes>;
  author: Bytes;
}>;

/** Decodes one record (no canonicity checks; zrdtd does those). */
export function parseRecord(rec: Bytes): RecordParts {
  let at = 0;
  const need = (n: number) => {
    if (at + n > rec.length) {
      throw new Error('a record is cut short');
    }
  };
  need(RECORD_MAGIC.length);
  if (!rec.subarray(0, RECORD_MAGIC.length).equals(RECORD_MAGIC)) {
    throw new Error('a record lacks the "zrdt2" magic');
  }
  at += RECORD_MAGIC.length;
  need(DIGEST * 2 + 4);
  const group = rec.subarray(at, at + DIGEST);
  at += DIGEST;
  const commit = rec.subarray(at, at + DIGEST);
  at += DIGEST;
  const n = rec.readUInt32BE(at);
  at += 4;
  need(n * DIGEST + ACI);
  const links: Array<Bytes> = [];
  for (let i = 0; i < n; i += 1) {
    links.push(rec.subarray(at, at + DIGEST));
    at += DIGEST;
  }
  const author = rec.subarray(at, at + ACI);
  at += ACI;
  if (at !== rec.length) {
    throw new Error('a record has bytes after its author');
  }
  return { group, commit, links, author };
}

/** Encodes a record; links are sorted and deduplicated. */
export function encodeRecord(parts: RecordParts): Bytes {
  const links = sortDigests(parts.links);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(links.length);
  return Buffer.concat([
    RECORD_MAGIC,
    parts.group,
    parts.commit,
    n,
    ...links,
    parts.author,
  ]);
}

export function sortDigests(ds: ReadonlyArray<Bytes>): Array<Bytes> {
  const out: Array<Bytes> = [];
  for (const d of [...ds].sort(Buffer.compare)) {
    if (!out.at(-1)?.equals(d)) {
      out.push(d);
    }
  }
  return out;
}

export function digestOf(rec: Bytes): Bytes {
  return createHash('sha256').update(rec).digest();
}

export function hex(b: Uint8Array<ArrayBuffer>): string {
  return Buffer.from(b).toString('hex');
}

/** The UI's short tag for a digest, e.g. "·9ac1" (ts/zrdt/ui/words.std.ts). */
export function tag(digest: Uint8Array<ArrayBuffer> | string): string {
  const h = typeof digest === 'string' ? digest : hex(digest);
  return `·${h.slice(0, 4)}`;
}

/** Digest, parts and who links it, for every record of a blob. */
export type Analysed = Readonly<{
  digest: string;
  record: Bytes;
  parts: RecordParts;
  linkedBy: ReadonlyArray<string>;
}>;

export function analyse(blob: StoreBlob): Array<Analysed> {
  const items = blob.records.map(record => ({
    digest: hex(digestOf(record)),
    record,
    parts: parseRecord(record),
    linkedBy: [] as Array<string>,
  }));
  const byDigest = new Map(items.map(i => [i.digest, i]));
  for (const i of items) {
    for (const l of i.parts.links) {
      byDigest.get(hex(l))?.linkedBy.push(i.digest);
    }
  }
  return items;
}

/** Digests of the records that link `digest`, directly or indirectly. */
export function descendants(
  items: ReadonlyArray<Analysed>,
  digest: string
): Set<string> {
  const byDigest = new Map(items.map(i => [i.digest, i]));
  const out = new Set<string>();
  const todo = [digest];
  for (let d = todo.pop(); d !== undefined; d = todo.pop()) {
    for (const by of byDigest.get(d)?.linkedBy ?? []) {
      if (!out.has(by)) {
        out.add(by);
        todo.push(by);
      }
    }
  }
  return out;
}

export type RemoveResult = Readonly<{
  blob: StoreBlob;
  removed: string;
  linkedBy: ReadonlyArray<string>;
  // Records OPEN can no longer accept (they reach the removed one).
  unverifiable: ReadonlyArray<string>;
}>;

/**
 * Removes one linked, non-head record. By default: a record that a head links
 * (so "Keep what verifies" keeps as much as possible), the smallest digest
 * among them. `prefix` picks a record by digest prefix instead.
 *
 * Example: a chain r1 <- r2 <- r3 (r3 the head) loses r2; OPEN then reports
 * r3 unverifiable and r2 missing.
 */
export function removeLinkedRecord(
  blob: StoreBlob,
  prefix?: string
): RemoveResult {
  const items = analyse(blob);
  const linked = items.filter(i => i.linkedBy.length > 0);
  let victim: Analysed | undefined;
  if (prefix !== undefined) {
    const p = prefix.replace(/^·/, '').toLowerCase();
    const found = items.filter(i => i.digest.startsWith(p));
    if (found.length !== 1) {
      throw new Error(
        `--digest ${prefix} matches ${found.length} records, not 1`
      );
    }
    [victim] = found;
    if (victim && victim.linkedBy.length === 0) {
      throw new Error(
        `${tag(victim.digest)} is a head; removing it would still pass OPEN`
      );
    }
  } else {
    const heads = new Set(
      items.filter(i => i.linkedBy.length === 0).map(i => i.digest)
    );
    const nearHead = linked.filter(i => i.linkedBy.some(by => heads.has(by)));
    [victim] = (nearHead.length > 0 ? nearHead : linked).sort((a, b) =>
      a.digest.localeCompare(b.digest)
    );
  }
  if (!victim) {
    throw new Error(
      'no record is linked by another one (the store needs at least two ' +
        'messages, one replying after the other)'
    );
  }
  const removed = victim.digest;
  return {
    blob: {
      group: blob.group,
      records: blob.records.filter(r => hex(digestOf(r)) !== removed),
    },
    removed,
    linkedBy: victim.linkedBy,
    unverifiable: [...descendants(items, removed)].sort(),
  };
}

// --- The export file -----------------------------------------------------------

/**
 * Where the store blob sits in an export file, and how to put a new one back.
 * Handles: a raw blob; a JSON file with the blob as a base64 string anywhere
 * in it; a binary container holding the blob (and fixing a u32 BE length
 * right before it, if there is one that matches).
 */
export type Located = Readonly<{
  blob: Bytes;
  kind: 'raw' | 'json' | 'binary';
  replace: (next: Bytes) => Bytes;
}>;

export function locateBlob(file: Bytes): Located {
  if (file.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
    const { length } = parseBlobPrefix(file, 0);
    if (length === file.length) {
      return { blob: file, kind: 'raw', replace: next => next };
    }
  }
  const text = file.toString('utf8').trimStart();
  if (text.startsWith('{')) {
    const doc = JSON.parse(text) as unknown;
    const b64Magic = BLOB_MAGIC.toString('base64').slice(0, 8); // "enJkdFMy"
    const paths: Array<Array<string | number>> = [];
    const walk = (v: unknown, at: Array<string | number>) => {
      if (typeof v === 'string' && v.startsWith(b64Magic)) {
        paths.push(at);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, [...at, i]));
      } else if (v != null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          walk(x, [...at, k]);
        }
      }
    };
    walk(doc, []);
    const [where] = paths;
    const last = where?.at(-1);
    if (paths.length !== 1 || where === undefined || last === undefined) {
      throw new Error(
        `the JSON export holds ${paths.length} store blobs, not 1`
      );
    }
    const get = (root: unknown): Record<string | number, unknown> => {
      let node = root as Record<string | number, unknown>;
      for (const k of where.slice(0, -1)) {
        node = node[k] as Record<string | number, unknown>;
      }
      return node;
    };
    const blob = Buffer.from(get(doc)[last] as string, 'base64');
    parseBlob(blob);
    return {
      blob,
      kind: 'json',
      replace: next => {
        get(doc)[last] = next.toString('base64');
        return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      },
    };
  }
  const at = file.indexOf(BLOB_MAGIC);
  if (at < 0) {
    throw new Error('no zrdt store blob in this file');
  }
  const { length } = parseBlobPrefix(file, at);
  const blob = Buffer.from(file.subarray(at, at + length));
  return {
    blob,
    kind: 'binary',
    replace: next => {
      const before = Buffer.from(file.subarray(0, at));
      if (at >= 4 && before.readUInt32BE(at - 4) === length) {
        before.writeUInt32BE(next.length, at - 4);
      }
      return Buffer.concat([before, next, file.subarray(at + length)]);
    },
  };
}

// --- zrdtd client ----------------------------------------------------------------

export const Op = {
  OPEN: 0x03,
  ACCEPT: 0x07,
  HEADS: 0x08,
  ENCODE: 0x0e,
  CLOSE: 0x0f,
} as const;

export const Status = {
  OK: 0x00,
  MISSING: 0x01,
  COLLISION: 0x02,
  WRONG_CHAT: 0x03,
  TOO_LARGE: 0x04,
  MALFORMED: 0x05,
  UNVERIFIABLE: 0x06,
} as const;

const STATUS_NAMES: Record<number, string> = {
  0x00: 'OK',
  0x01: 'MISSING',
  0x02: 'COLLISION',
  0x03: 'WRONG_CHAT',
  0x04: 'TOO_LARGE',
  0x05: 'MALFORMED',
  0x06: 'UNVERIFIABLE',
  0x07: 'NOT_FOUND',
  0x08: 'BAD_OPENING',
  0x80: 'BAD_REQUEST',
  0x81: 'UNKNOWN_OP',
  0x82: 'NO_CHAT',
  0x83: 'CHAT_OPEN',
};

export function statusName(status: number): string {
  return STATUS_NAMES[status] ?? `0x${status.toString(16)}`;
}

export function u32(n: number): Bytes {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export function str(s: string): Bytes {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(b.length), b]);
}

export function lenBytes(b: Uint8Array<ArrayBuffer>): Bytes {
  return Buffer.concat([u32(b.length), b]);
}

export function digests(ds: ReadonlyArray<Uint8Array<ArrayBuffer>>): Bytes {
  return Buffer.concat([u32(ds.length), ...ds]);
}

export function readDigests(body: Bytes, offset = 0): Array<Bytes> {
  const n = body.readUInt32BE(offset);
  const out: Array<Bytes> = [];
  for (let i = 0; i < n; i += 1) {
    const at = offset + 4 + i * DIGEST;
    out.push(Buffer.from(body.subarray(at, at + DIGEST)));
  }
  return out;
}

export type Reply = Readonly<{ status: number; body: Bytes }>;

/** A minimal zrdtd client: one request at a time, replies in order. */
export class Zrdtd {
  readonly #child: ChildProcessWithoutNullStreams;
  #buf = Buffer.alloc(0);
  readonly #waiting: Array<{
    resolve: (r: Reply) => void;
    reject: (e: Error) => void;
  }> = [];
  #exited: Error | undefined;
  #stderr = '';

  constructor(binary: string) {
    this.#child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LEAN_ABORT_ON_PANIC: '1' },
    });
    this.#child.stdout.on('data', (chunk: Bytes) => {
      this.#buf = Buffer.concat([this.#buf, chunk]);
      this.#drain();
    });
    this.#child.stderr.on('data', (chunk: Bytes) => {
      this.#stderr += chunk.toString('utf8');
    });
    const fail = (error: Error) => {
      this.#exited = error;
      for (const w of this.#waiting.splice(0)) {
        w.reject(error);
      }
    };
    this.#child.on('error', fail);
    this.#child.on('exit', code =>
      fail(new Error(`zrdtd exited (${code}): ${this.#stderr.trim()}`))
    );
  }

  #drain(): void {
    while (this.#buf.length >= 4) {
      const len = this.#buf.readUInt32BE(0);
      if (this.#buf.length < 4 + len) {
        return;
      }
      const payload = this.#buf.subarray(4, 4 + len);
      this.#buf = this.#buf.subarray(4 + len);
      const w = this.#waiting.shift();
      w?.resolve({
        status: payload[0] ?? 0xff,
        body: Buffer.from(payload.subarray(1)),
      });
    }
  }

  call(op: number, body: Bytes): Promise<Reply> {
    if (this.#exited) {
      return Promise.reject(this.#exited);
    }
    const payload = Buffer.concat([Buffer.from([op]), body]);
    return new Promise<Reply>((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
      this.#child.stdin.write(Buffer.concat([u32(payload.length), payload]));
    });
  }

  async open(chat: string, group: Bytes, blob: Bytes): Promise<Reply> {
    return this.call(
      Op.OPEN,
      Buffer.concat([str(chat), group, Buffer.from([0]), lenBytes(blob)])
    );
  }

  async heads(chat: string): Promise<Array<Bytes>> {
    const r = await this.call(Op.HEADS, str(chat));
    expectOk('HEADS', r);
    return readDigests(r.body);
  }

  async accept(chat: string, parts: RecordParts): Promise<Bytes> {
    const r = await this.call(
      Op.ACCEPT,
      Buffer.concat([
        str(chat),
        parts.group,
        parts.commit,
        digests(parts.links),
        parts.author,
      ])
    );
    expectOk('ACCEPT', r);
    // The digest comes first (later protocol versions append the record).
    return Buffer.from(r.body.subarray(0, DIGEST));
  }

  async encode(chat: string): Promise<Bytes> {
    const r = await this.call(Op.ENCODE, str(chat));
    expectOk('ENCODE', r);
    const n = r.body.readUInt32BE(0);
    return Buffer.from(r.body.subarray(4, 4 + n));
  }

  async closeChat(chat: string): Promise<void> {
    await this.call(Op.CLOSE, str(chat));
  }

  async close(): Promise<void> {
    if (this.#exited) {
      return;
    }
    const exited = new Promise<void>(resolve =>
      this.#child.once('exit', () => resolve())
    );
    this.#child.stdin.end();
    await exited;
  }
}

function expectOk(op: string, r: Reply): void {
  if (r.status !== Status.OK) {
    throw new Error(`zrdtd ${op} replied ${statusName(r.status)}`);
  }
}

/** Describes an OPEN reply, e.g. "UNVERIFIABLE: 2 unverifiable, missing ·9ac1". */
export function describeOpen(r: Reply): string {
  if (r.status === Status.UNVERIFIABLE) {
    const unverifiable = readDigests(r.body);
    const missing = readDigests(r.body, 4 + unverifiable.length * DIGEST);
    return (
      `UNVERIFIABLE: ${unverifiable.length} unverifiable ` +
      `[${unverifiable.map(tag).join(' ')}], missing [${missing.map(tag).join(' ')}]`
    );
  }
  return statusName(r.status);
}

/** Parses an ACI ("4f3c…-…") or 32 hex digits into its 16 bytes. */
export function aciBytes(aci: string): Bytes {
  const h = aci.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) {
    throw new Error(`"${aci}" is not an ACI`);
  }
  return Buffer.from(h, 'hex');
}

export function defaultDaemon(): string {
  return (
    process.env.ZRDT_DAEMON ??
    path.resolve(
      __dirname,
      '..',
      'zrdt',
      'core',
      '.lake',
      'build',
      'bin',
      'zrdtd'
    )
  );
}

export type AppendResult = Readonly<{
  blob: Bytes;
  fakes: ReadonlyArray<string>;
  // The genuine heads the first fake links.
  heads: ReadonlyArray<string>;
}>;

/**
 * Appends `count` fake records by `author` on top of the blob's heads, through
 * zrdtd. Each fake links the current heads; its commit is random (it opens to
 * nothing). Checks that the result passes OPEN.
 */
export async function appendFakes(
  blobBytes: Bytes,
  author: Bytes,
  {
    count = 2,
    daemon = defaultDaemon(),
  }: { count?: number; daemon?: string } = {}
): Promise<AppendResult> {
  const { group } = parseBlob(blobBytes);
  const zrdtd = new Zrdtd(daemon);
  const chat = `doctor-${randomBytes(6).toString('hex')}`;
  try {
    const opened = await zrdtd.open(chat, group, blobBytes);
    if (opened.status !== Status.OK) {
      throw new Error(
        `the export does not pass OPEN (${describeOpen(opened)}); ` +
          'append needs a genuine store'
      );
    }
    const genuineHeads = await zrdtd.heads(chat);
    const fakes: Array<string> = [];
    for (let i = 0; i < count; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const links = await zrdtd.heads(chat);
      // oxlint-disable-next-line no-await-in-loop
      const d = await zrdtd.accept(chat, {
        group,
        commit: randomBytes(DIGEST),
        links,
        author,
      });
      fakes.push(hex(d));
    }
    const blob = await zrdtd.encode(chat);
    await zrdtd.closeChat(chat);

    const check = `${chat}-check`;
    const reopened = await zrdtd.open(check, group, blob);
    if (reopened.status !== Status.OK) {
      throw new Error(
        `the doctored store does not pass OPEN (${describeOpen(reopened)})`
      );
    }
    await zrdtd.closeChat(check);
    return { blob, fakes, heads: genuineHeads.map(hex) };
  } finally {
    await zrdtd.close();
  }
}

/** Runs OPEN on a blob in a scratch chat; returns the reply described. */
export async function checkOpen(
  blobBytes: Bytes,
  daemon = defaultDaemon()
): Promise<string> {
  const { group } = parseBlob(blobBytes);
  const zrdtd = new Zrdtd(daemon);
  try {
    const chat = `doctor-check-${randomBytes(6).toString('hex')}`;
    const r = await zrdtd.open(chat, group, blobBytes);
    await zrdtd.closeChat(chat);
    return describeOpen(r);
  } finally {
    await zrdtd.close();
  }
}

// --- File-level operations (also used by the panel) ----------------------------

export function doctoredPath(file: string): string {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.doctored${ext}`;
}

/**
 * A JSON dump (`{"blob": …, "content": {<hex digest>: …}}`, the app's export):
 * drops the removed record's content entry too, so the file has no opening
 * for a record it does not hold.
 */
export function dropContentEntry(json: Bytes, digest: string): Bytes {
  const doc = JSON.parse(json.toString('utf8')) as {
    content?: Record<string, unknown>;
  };
  if (doc.content == null || !Object.hasOwn(doc.content, digest)) {
    return json;
  }
  delete doc.content[digest];
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
}

/** Beat 4 on a file. Returns a summary for the presenter. */
export async function doctorRemove(
  file: string,
  out = doctoredPath(file),
  prefix?: string
): Promise<string> {
  const located = locateBlob(await fs.readFile(file));
  const result = removeLinkedRecord(parseBlob(located.blob), prefix);
  let next = located.replace(encodeBlob(result.blob));
  if (located.kind === 'json') {
    next = dropContentEntry(next, result.removed);
  }
  await fs.writeFile(out, next);
  return (
    `removed ${tag(result.removed)} (${result.removed}), linked by ` +
    `${result.linkedBy.map(tag).join(' ')}; ` +
    `${result.unverifiable.length} record(s) now unverifiable; ` +
    `wrote ${out} (${located.kind})`
  );
}

/** Beat 5 on a file. Returns a summary for the presenter. */
export async function doctorAppend(
  file: string,
  authorAci: string,
  out = doctoredPath(file),
  options: { count?: number; daemon?: string } = {}
): Promise<string> {
  const located = locateBlob(await fs.readFile(file));
  const result = await appendFakes(located.blob, aciBytes(authorAci), options);
  await fs.writeFile(out, located.replace(result.blob));
  return (
    `appended ${result.fakes.map(tag).join(' ')} by ${authorAci} on top of ` +
    `${result.heads.map(tag).join(' ')}; passes OPEN; wrote ${out} ` +
    `(${located.kind})`
  );
}

// --- CLI ---------------------------------------------------------------------------

function usage(): never {
  // oxlint-disable-next-line no-console
  console.error(
    'usage:\n' +
      '  doctor.ts remove <export> [<out>] [--digest <hex prefix>]\n' +
      '  doctor.ts append <export> [<out>] --author <aci> [--count 2] [--daemon <zrdtd>]\n' +
      '  doctor.ts show <export> [--daemon <zrdtd>]'
  );
  process.exit(2);
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: Array<string> = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (a.startsWith('--')) {
      flags[a.slice(2)] = rest[i + 1] ?? usage();
      i += 1;
    } else {
      positional.push(a);
    }
  }
  const [file, out] = positional;
  if (!file) {
    usage();
  }
  let summary: string;
  switch (cmd) {
    case 'remove':
      summary = await doctorRemove(file, out, flags.digest);
      break;
    case 'append':
      if (!flags.author) {
        usage();
      }
      summary = await doctorAppend(file, flags.author, out, {
        count: flags.count ? Number(flags.count) : undefined,
        daemon: flags.daemon,
      });
      break;
    case 'show': {
      const located = locateBlob(await fs.readFile(file));
      const items = analyse(parseBlob(located.blob));
      const lines = items.map(
        i =>
          `${tag(i.digest)} ${i.digest} links=[${i.parts.links.map(tag).join(' ')}] ` +
          `author=${hex(i.parts.author)}${i.linkedBy.length === 0 ? ' HEAD' : ''}`
      );
      let open = '(zrdtd not run)';
      try {
        open = await checkOpen(located.blob, flags.daemon);
      } catch (error) {
        open = `(zrdtd failed: ${String(error)})`;
      }
      summary = `${located.kind} export, ${items.length} records\n${lines.join('\n')}\nOPEN: ${open}`;
      break;
    }
    default:
      usage();
  }
  // oxlint-disable-next-line no-console
  console.log(summary);
}

async function runCli(): Promise<void> {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    // oxlint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (require.main === module) {
  void runCli();
}
