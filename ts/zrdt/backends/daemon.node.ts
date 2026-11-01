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
// TODO(zrdt): the op numbers and the body layout of every request and reply
// are fixed by core/Zrdt/Proto.lean (lane L3) and pinned by
// vectors/vectors.json. Until that lands, the ZrdtBackend methods below throw;
// only the transport (spawn, framing, fail-closed) is implemented and tested.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { createLogger } from '../../logging/log.std.ts';
import { ZrdtBackendError } from '../ZrdtBackend.std.ts';
import type {
  AcceptResult,
  BackendKind,
  Bytes,
  ChatKey,
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

const log = createLogger('zrdt/daemon');

/**
 * Frame op codes.
 *
 * TODO(zrdt): PROVISIONAL. These follow the order of the op table in
 * PLAN.md section 3.3; Proto.lean decides the real numbers.
 */
export enum Op {
  VERSION = 0x01,
  NEW = 0x02,
  OPEN = 0x03,
  SALVAGE = 0x04,
  COMMIT = 0x05,
  HASH = 0x06,
  ACCEPT = 0x07,
  HEADS = 0x08,
  HAS = 0x09,
  GET = 0x0a,
  REACH_SET = 0x0b,
  MERGE = 0x0c,
  CLASSIFY = 0x0d,
  ENCODE = 0x0e,
  CLOSE = 0x0f,
}

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
  op: Op;
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
  // The frame ops. TODO(zrdt): body encodings pending Proto.lean.
  // -------------------------------------------------------------------------

  #todo(op: Op): never {
    throw new Error(
      `TODO(zrdt): body encoding for ${Op[op]} is pending core/Zrdt/Proto.lean`
    );
  }

  async version(): Promise<VersionInfo> {
    return this.#todo(Op.VERSION);
  }

  async create(_chat: ChatKey, _group: Bytes): Promise<void> {
    return this.#todo(Op.NEW);
  }

  async open(
    _chat: ChatKey,
    _group: Bytes,
    _input: OpenInput
  ): Promise<OpenResult> {
    return this.#todo(Op.OPEN);
  }

  async salvage(
    _chat: ChatKey,
    _group: Bytes,
    _input: OpenInput
  ): Promise<SalvageResult> {
    return this.#todo(Op.SALVAGE);
  }

  async commit(
    _group: Bytes,
    _author: Bytes,
    _nonce: Bytes,
    _dataMessage: Bytes
  ): Promise<Bytes> {
    return this.#todo(Op.COMMIT);
  }

  async hash(_record: RecordParts): Promise<Digest> {
    return this.#todo(Op.HASH);
  }

  async accept(_chat: ChatKey, _record: RecordParts): Promise<AcceptResult> {
    return this.#todo(Op.ACCEPT);
  }

  async heads(_chat: ChatKey): Promise<Array<Digest>> {
    return this.#todo(Op.HEADS);
  }

  async has(_chat: ChatKey, _digest: Digest): Promise<boolean> {
    return this.#todo(Op.HAS);
  }

  async get(_chat: ChatKey, _digest: Digest): Promise<RecordParts | undefined> {
    return this.#todo(Op.GET);
  }

  async reachSet(
    _chat: ChatKey,
    _from: ReadonlyArray<Digest>
  ): Promise<Array<Digest>> {
    return this.#todo(Op.REACH_SET);
  }

  async merge(_chat: ChatKey, _blob: Bytes): Promise<OpenResult> {
    return this.#todo(Op.MERGE);
  }

  async classify(
    _chat: ChatKey,
    _facts: ReadonlyArray<ProvenanceFact>
  ): Promise<Array<RecordStatus>> {
    return this.#todo(Op.CLASSIFY);
  }

  async encode(_chat: ChatKey): Promise<Bytes> {
    return this.#todo(Op.ENCODE);
  }

  async close(_chat: ChatKey): Promise<void> {
    return this.#todo(Op.CLOSE);
  }
}
