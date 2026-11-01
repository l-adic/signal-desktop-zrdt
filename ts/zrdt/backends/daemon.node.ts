// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable max-classes-per-file

// The zrdt Lean backend: spawns zrdtd ($ZRDT_DAEMON) and talks to it in
// frames on stdin and stdout (zrdt docs/PLAN.md section 3.3).
//
// A frame is `u32 BE length ‖ u8 tag ‖ body`, where the length counts the tag
// byte and the body. Requests carry an op as the tag; zrdtd answers each
// request with one frame, in request order. Reads can be short, so frames are
// reassembled from whatever chunks arrive.
//
// Fail closed: if zrdtd exits, cannot be started, closes a pipe or sends a
// frame the host cannot read, every pending call is rejected with an
// `unavailable` error, the backend is marked unavailable for good, and
// nothing is accepted until the host starts a new backend and re-opens every
// chat from its SQL rows.
//
// The body layout of every request and reply is in ./codec.std.ts, from
// core/Zrdt/Proto.lean, and pinned by vectors/vectors.json (rung 7 test:
// ts/test-node/zrdt/vectors_test.node.ts).
//
// Replies of the protocol 1 layout (zrdt e2b3160) have no record bytes in
// ACCEPT and no opening in COMMIT, and that zrdtd has no ACCEPT_RECORD. For
// those the host builds the canonical record encoding and the opening itself
// (the same bytes the stub produces), and runs ACCEPT_RECORD as COMMIT on the
// opening plus ACCEPT. TODO(zrdt T0): drop the fallbacks once every zrdtd in
// use speaks the lead's changes (build/t5-core).

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { createLogger } from '../../logging/log.std.ts';
import { ZrdtBackendError } from '../ZrdtBackend.std.ts';
import type {
  AcceptRecordResult,
  AcceptResult,
  BackendKind,
  Bytes,
  ChatKey,
  CommitResult,
  Digest,
  OpenInput,
  OpenResult,
  ProvenanceFact,
  RecordParts,
  RecordStatus,
  SalvageResult,
  VersionInfo,
  ZrdtBackend,
} from '../ZrdtBackend.std.ts';
import {
  Code,
  Op,
  ReplyError,
  concatBytes,
  decodeReply,
  encodeRequestBody,
} from './codec.std.ts';
import type { Request, ResultOf } from './codec.std.ts';
import {
  decodeRecord,
  encodeRecord,
  makeRecord,
  removeTopLevelFields,
} from './stub.node.ts';

export { Op } from './codec.std.ts';

const log = createLogger('zrdt/daemon');

/** The largest frame either side may send (tag and body), in bytes. */
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** One frame: a tag byte (an op, or a reply code) and a body. */
export type Frame = Readonly<{ tag: number; body: Bytes }>;

/** `u32 BE length ‖ u8 tag ‖ body`, with length = 1 + body length. */
export function encodeFrame(tag: number, body: Bytes): Bytes {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
    throw new RangeError(`zrdt frame tag out of range: ${tag}`);
  }
  if (1 + body.length > MAX_FRAME_BYTES) {
    throw new RangeError(`zrdt frame too large: ${body.length} bytes`);
  }
  const out = new Uint8Array(5 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1 + body.length, false);
  out[4] = tag;
  out.set(body, 5);
  return out;
}

/**
 * Reassembles frames from a byte stream that arrives in chunks of any size.
 * Throws a `protocol` error on a frame length of zero or above
 * MAX_FRAME_BYTES; after that the stream cannot be trusted.
 */
export class FrameReader {
  #chunks = new Array<Bytes>();
  #buffered = 0;
  #frameLength: number | undefined;

  /** Adds a chunk and returns every frame it completes, in order. */
  push(chunk: Bytes): Array<Frame> {
    if (chunk.length > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }
    const frames = new Array<Frame>();
    for (;;) {
      if (this.#frameLength === undefined) {
        if (this.#buffered < 4) {
          break;
        }
        const header = this.#take(4);
        const length = new DataView(header.buffer).getUint32(0, false);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new ZrdtBackendError('protocol', `bad frame length ${length}`);
        }
        this.#frameLength = length;
      }
      if (this.#buffered < this.#frameLength) {
        break;
      }
      const frame = this.#take(this.#frameLength);
      this.#frameLength = undefined;
      frames.push({ tag: frame[0] ?? 0, body: frame.subarray(1) });
    }
    return frames;
  }

  /** Bytes received but not yet part of a whole frame. */
  get buffered(): number {
    return this.#buffered;
  }

  /** Removes the first `n` buffered bytes (n <= buffered) and returns them. */
  #take(n: number): Bytes {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) {
        throw new Error('zrdt FrameReader: not enough bytes');
      }
      const used = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, used), filled);
      filled += used;
      if (used === chunk.length) {
        this.#chunks.shift();
      } else {
        this.#chunks[0] = chunk.subarray(used);
      }
    }
    this.#buffered -= n;
    return out;
  }
}

export type DaemonBackendOptions = Readonly<{
  /** The zrdtd binary; defaults to $ZRDT_DAEMON. */
  path?: string;
  /** Arguments for the binary. */
  args?: ReadonlyArray<string>;
  /** Extra environment; LEAN_ABORT_ON_PANIC=1 is always set. */
  env?: Readonly<Record<string, string | undefined>>;
}>;

type Pending = Readonly<{
  op: number;
  resolve: (frame: Frame) => void;
  reject: (error: ZrdtBackendError) => void;
}>;

/** The Lean backend: one zrdtd child process. */
export class DaemonBackend implements ZrdtBackend {
  readonly kind: BackendKind = 'lean';

  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader = new FrameReader();
  readonly #pending = new Array<Pending>();
  readonly #listeners = new Set<(error: ZrdtBackendError) => void>();
  #failure: ZrdtBackendError | undefined;

  constructor({ path, args = [], env = {} }: DaemonBackendOptions = {}) {
    const binary = path ?? process.env.ZRDT_DAEMON;
    if (binary === undefined || binary === '') {
      throw new ZrdtBackendError('unavailable', 'ZRDT_DAEMON is not set');
    }

    this.#child = spawn(binary, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, LEAN_ABORT_ON_PANIC: '1' },
    });

    this.#child.stdout.on('data', (chunk: Bytes) => this.#onData(chunk));
    this.#child.stderr.on('data', (chunk: Bytes) => {
      log.warn(`zrdtd: ${Buffer.from(chunk).toString('utf8').trimEnd()}`);
    });
    this.#child.on('error', error => {
      this.#fail(`zrdtd failed: ${error.message}`);
    });
    this.#child.on('exit', (code, signal) => {
      this.#fail(`zrdtd exited (code ${code}, signal ${signal})`);
    });
    this.#child.stdin.on('error', error => {
      this.#fail(`zrdtd stdin: ${error.message}`);
    });
    this.#child.stdout.on('end', () => {
      this.#fail('zrdtd closed stdout');
    });
  }

  isAvailable(): boolean {
    return this.#failure === undefined;
  }

  onUnavailable(listener: (error: ZrdtBackendError) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Stops zrdtd. Pending and later calls fail with `unavailable`. */
  dispose(): void {
    this.#fail('backend disposed');
  }

  /**
   * Sends one request frame and resolves with zrdtd's reply frame. Replies
   * come in request order, so the oldest pending call gets each reply.
   */
  call(op: Op, body: Bytes): Promise<Frame> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const frame = encodeFrame(op, body);
    return new Promise<Frame>((resolve, reject) => {
      this.#pending.push({ op, resolve, reject });
      this.#child.stdin.write(frame);
    });
  }

  /**
   * Sends a raw request payload (`op ‖ body`, possibly empty or malformed)
   * and resolves with the reply frame. For tests (rung 6 and 7 vectors).
   */
  callRaw(payload: Bytes): Promise<Frame> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const frame = new Uint8Array(4 + payload.length);
    new DataView(frame.buffer).setUint32(0, payload.length, false);
    frame.set(payload, 4);
    return new Promise<Frame>((resolve, reject) => {
      this.#pending.push({ op: payload[0] ?? 0, resolve, reject });
      this.#child.stdin.write(frame);
    });
  }

  #onData(chunk: Bytes): void {
    if (this.#failure !== undefined) {
      return;
    }
    let frames: Array<Frame>;
    try {
      frames = this.#reader.push(new Uint8Array(chunk));
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const frame of frames) {
      const pending = this.#pending.shift();
      if (pending === undefined) {
        this.#fail('zrdtd sent a reply nobody asked for');
        return;
      }
      pending.resolve(frame);
    }
  }

  #fail(reason: string): void {
    if (this.#failure !== undefined) {
      return;
    }
    const failure = new ZrdtBackendError('unavailable', reason);
    this.#failure = failure;
    log.error(`zrdt backend unavailable: ${reason}`);

    if (this.#child.exitCode == null && this.#child.signalCode == null) {
      this.#child.kill('SIGKILL');
    }
    for (const pending of this.#pending.splice(0)) {
      pending.reject(failure);
    }
    for (const listener of [...this.#listeners]) {
      this.#listeners.delete(listener);
      try {
        listener(failure);
      } catch (error) {
        log.error('zrdt onUnavailable listener threw', error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The frame ops (codec.std.ts).
  // -------------------------------------------------------------------------

  #acceptRecordOp: boolean | undefined;

  /** Sends a typed request and reads the typed reply. */
  async #request<O extends Op>(req: Request & { op: O }): Promise<ResultOf[O]> {
    const frame = await this.call(req.op, encodeRequestBody(req));
    let result: ResultOf[O] | undefined;
    try {
      result = decodeReply(req.op, frame.tag, frame.body);
    } catch (error) {
      if (!(error instanceof ReplyError)) {
        throw error;
      }
      switch (error.status) {
        case Code.NO_CHAT:
          throw new ZrdtBackendError('unknownChat', `${Op[req.op]}: no store`);
        case Code.CHAT_OPEN:
          throw new ZrdtBackendError('chatOpen', `${Op[req.op]}: chat open`);
        case Code.BAD_REQUEST:
          throw new ZrdtBackendError('badInput', `${Op[req.op]}: bad request`);
        case Code.UNKNOWN_OP:
          throw new ZrdtBackendError('protocol', `${Op[req.op]}: unknown op`);
        default:
          break;
      }
      // A status the op cannot reply: the stream cannot be trusted.
      this.#fail(error.message);
      throw new ZrdtBackendError('unavailable', error.message);
    }
    if (
      result === undefined &&
      !(req.op === Op.NEW || req.op === Op.CLOSE || req.op === Op.GET)
    ) {
      const message = `zrdtd sent an unreadable ${Op[req.op]} reply`;
      this.#fail(message);
      throw new ZrdtBackendError('unavailable', message);
    }
    return result as ResultOf[O];
  }

  async version(): Promise<VersionInfo> {
    return this.#request({ op: Op.VERSION });
  }

  async create(chat: ChatKey, group: Bytes): Promise<void> {
    await this.#request({ op: Op.NEW, chat, group });
  }

  async open(
    chat: ChatKey,
    group: Bytes,
    input: OpenInput
  ): Promise<OpenResult> {
    return this.#request({ op: Op.OPEN, chat, group, input });
  }

  async salvage(
    chat: ChatKey,
    group: Bytes,
    input: OpenInput
  ): Promise<SalvageResult> {
    return this.#request({ op: Op.SALVAGE, chat, group, input });
  }

  async commit(
    group: Bytes,
    author: Bytes,
    nonce: Bytes,
    dataMessage: Bytes
  ): Promise<CommitResult> {
    const result = await this.#request({
      op: Op.COMMIT,
      group,
      author,
      nonce,
      dataMessage,
    });
    if (result.kind === 'ok' && result.opening.length === 0) {
      // Protocol 1: no opening in the reply.
      const committed = removeTopLevelFields(dataMessage, new Set([15, 200]));
      if (committed === undefined) {
        return { kind: 'malformed' };
      }
      return { ...result, opening: concatBytes([nonce, committed]) };
    }
    return result;
  }

  async hash(record: RecordParts): Promise<Digest> {
    return this.#request({ op: Op.HASH, parts: record });
  }

  async accept(chat: ChatKey, record: RecordParts): Promise<AcceptResult> {
    const result = await this.#request({ op: Op.ACCEPT, chat, parts: record });
    if (result.kind === 'accepted' && result.record.length === 0) {
      // Protocol 1: no record bytes in the reply.
      return { ...result, record: encodeRecord(makeRecord(record)) };
    }
    return result;
  }

  async acceptRecord(
    chat: ChatKey,
    record: Bytes,
    opening?: Bytes
  ): Promise<AcceptRecordResult> {
    if (this.#acceptRecordOp !== false) {
      try {
        const result = await this.#request({
          op: Op.ACCEPT_RECORD,
          chat,
          record,
          opening,
        });
        this.#acceptRecordOp = true;
        return result;
      } catch (error) {
        if (
          !(error instanceof ZrdtBackendError) ||
          error.code !== 'protocol' ||
          this.#acceptRecordOp === true
        ) {
          throw error;
        }
        log.warn('zrdtd has no ACCEPT_RECORD; using COMMIT and ACCEPT');
        this.#acceptRecordOp = false;
      }
    }
    // Protocol 1: decode here, check the opening with COMMIT, then ACCEPT.
    const parts = decodeRecord(record);
    if (parts === undefined) {
      return { kind: 'malformed' };
    }
    if (opening !== undefined) {
      if (opening.length < 32) {
        return { kind: 'badOpening' };
      }
      const check = await this.commit(
        parts.group,
        parts.author,
        opening.subarray(0, 32),
        opening.subarray(32)
      );
      if (
        check.kind !== 'ok' ||
        Buffer.compare(Buffer.from(check.commit), Buffer.from(parts.commit)) !==
          0
      ) {
        return { kind: 'badOpening' };
      }
    }
    return this.accept(chat, parts);
  }

  async heads(chat: ChatKey): Promise<Array<Digest>> {
    return this.#request({ op: Op.HEADS, chat });
  }

  async has(chat: ChatKey, digest: Digest): Promise<boolean> {
    return this.#request({ op: Op.HAS, chat, digest });
  }

  async get(chat: ChatKey, digest: Digest): Promise<RecordParts | undefined> {
    return this.#request({ op: Op.GET, chat, digest });
  }

  async reachSet(
    chat: ChatKey,
    from: ReadonlyArray<Digest>
  ): Promise<Array<Digest>> {
    return this.#request({ op: Op.REACH_SET, chat, from });
  }

  async merge(chat: ChatKey, blob: Bytes): Promise<OpenResult> {
    return this.#request({ op: Op.MERGE, chat, blob });
  }

  async classify(
    chat: ChatKey,
    facts: ReadonlyArray<ProvenanceFact>
  ): Promise<Array<RecordStatus>> {
    return this.#request({ op: Op.CLASSIFY, chat, facts });
  }

  async encode(chat: ChatKey): Promise<Bytes> {
    return this.#request({ op: Op.ENCODE, chat });
  }

  async close(chat: ChatKey): Promise<void> {
    await this.#request({ op: Op.CLOSE, chat });
  }
}
