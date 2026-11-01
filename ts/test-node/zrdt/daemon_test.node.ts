// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { ZrdtBackendError } from '../../zrdt/ZrdtBackend.std.ts';
import type { Bytes } from '../../zrdt/ZrdtBackend.std.ts';
import {
  DaemonBackend,
  FrameReader,
  MAX_FRAME_BYTES,
  Op,
  encodeFrame,
} from '../../zrdt/backends/daemon.node.ts';
import type { Frame } from '../../zrdt/backends/daemon.node.ts';

function ascii(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

function asText(bytes: Bytes): string {
  return Buffer.from(bytes).toString('latin1');
}

/**
 * A stand-in for zrdtd, run with this process's own binary. It reads frames
 * and answers by the request body:
 * - "env": the value of LEAN_ABORT_ON_PANIC;
 * - "exit": exits with code 3 without answering;
 * - "hang": never answers;
 * - "badlength": sends a frame header with length 0;
 * - "twice": answers twice;
 * - anything else: echoes the frame.
 * Each answer is written in two parts, 30 ms apart, so the host sees short
 * reads. Answers go out one after another, as zrdtd's do.
 */
const FAKE_DAEMON = `
let buffer = Buffer.alloc(0);
let queue = Promise.resolve();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function reply(tag, body) {
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out[4] = tag;
  body.copy(out, 5);
  queue = queue.then(async () => {
    process.stdout.write(out.subarray(0, 3));
    await pause(30);
    process.stdout.write(out.subarray(3));
  });
}
function handle(tag, body) {
  const command = body.toString('latin1');
  if (command === 'env') {
    reply(tag, Buffer.from(String(process.env.LEAN_ABORT_ON_PANIC)));
  } else if (command === 'exit') {
    process.exit(3);
  } else if (command === 'hang') {
    // no answer
  } else if (command === 'badlength') {
    process.stdout.write(Buffer.from([0, 0, 0, 0]));
  } else if (command === 'twice') {
    reply(tag, body);
    setTimeout(() => reply(tag, body), 60);
  } else {
    reply(tag, body);
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.length < 4 + length) {
      break;
    }
    const tag = buffer[4];
    const body = Buffer.from(buffer.subarray(5, 4 + length));
    buffer = buffer.subarray(4 + length);
    handle(tag, body);
  }
});
`;

function fakeDaemon(): DaemonBackend {
  return new DaemonBackend({
    path: process.execPath,
    args: ['-e', FAKE_DAEMON],
    // Under electron-mocha, process.execPath is Electron.
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
}

describe('zrdt daemon backend', () => {
  describe('frames', () => {
    it('encodes u32 BE length ‖ u8 tag ‖ body, the length counting tag and body', () => {
      assert.deepEqual(
        encodeFrame(Op.ACCEPT, ascii('ab')),
        new Uint8Array([0, 0, 0, 3, Op.ACCEPT, 0x61, 0x62])
      );
      assert.deepEqual(
        encodeFrame(Op.VERSION, new Uint8Array(0)),
        new Uint8Array([0, 0, 0, 1, Op.VERSION])
      );
      assert.throws(() => encodeFrame(256, new Uint8Array(0)), RangeError);
    });

    it('reassembles frames from chunks of every size', () => {
      const frames: Array<Frame> = [
        { tag: 1, body: ascii('hello') },
        { tag: 2, body: new Uint8Array(0) },
        { tag: 3, body: new Uint8Array(1000).fill(7) },
      ];
      const stream = new Uint8Array(
        Buffer.concat(frames.map(f => encodeFrame(f.tag, f.body)))
      );
      for (let stride = 1; stride <= stream.length; stride += 1) {
        const reader = new FrameReader();
        const out = new Array<Frame>();
        for (let offset = 0; offset < stream.length; offset += stride) {
          out.push(...reader.push(stream.slice(offset, offset + stride)));
        }
        assert.deepEqual(out, frames, `stride ${stride}`);
        assert.strictEqual(reader.buffered, 0);
      }
    });

    it('refuses a frame length of zero or above the limit', () => {
      assert.throws(
        () => new FrameReader().push(new Uint8Array([0, 0, 0, 0])),
        ZrdtBackendError,
        /bad frame length 0/
      );
      const tooBig = new Uint8Array(4);
      new DataView(tooBig.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
      assert.throws(() => new FrameReader().push(tooBig), /bad frame length/);
    });
  });

  describe('process', () => {
    let backend: DaemonBackend | undefined;

    afterEach(() => {
      backend?.dispose();
      backend = undefined;
    });

    it('answers calls in order, across short reads', async () => {
      backend = fakeDaemon();
      assert.strictEqual(backend.kind, 'lean');
      const replies = await Promise.all([
        backend.call(Op.HASH, ascii('one')),
        backend.call(Op.HEADS, ascii('two')),
        backend.call(Op.HAS, new Uint8Array(0)),
      ]);
      assert.deepEqual(
        replies.map(r => [r.tag, asText(r.body)]),
        [
          [Op.HASH, 'one'],
          [Op.HEADS, 'two'],
          [Op.HAS, ''],
        ]
      );
      assert.isTrue(backend.isAvailable());
    });

    it('runs zrdtd with LEAN_ABORT_ON_PANIC=1', async () => {
      backend = fakeDaemon();
      const reply = await backend.call(Op.VERSION, ascii('env'));
      assert.strictEqual(asText(reply.body), '1');
    });

    it('fails closed when zrdtd exits', async () => {
      backend = fakeDaemon();
      const failures = new Array<ZrdtBackendError>();
      backend.onUnavailable(error => failures.push(error));

      const hanging = backend.call(Op.ACCEPT, ascii('hang'));
      const exiting = backend.call(Op.ACCEPT, ascii('exit'));
      await assert.isRejected(hanging, /zrdt unavailable/);
      await assert.isRejected(exiting, /zrdt unavailable/);

      assert.isFalse(backend.isAvailable());
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0]?.code, 'unavailable');
      await assert.isRejected(
        backend.call(Op.HEADS, new Uint8Array(0)),
        /unavailable/
      );
    });

    it('fails closed when zrdtd is killed', async () => {
      backend = fakeDaemon();
      await backend.call(Op.HEADS, ascii('warm-up'));
      const pending = backend.call(Op.ACCEPT, ascii('hang'));
      backend.dispose();
      await assert.isRejected(pending, /unavailable/);
      assert.isFalse(backend.isAvailable());
    });

    it('fails closed on a frame it cannot read', async () => {
      backend = fakeDaemon();
      await assert.isRejected(
        backend.call(Op.HEADS, ascii('badlength')),
        /bad frame length 0/
      );
      assert.isFalse(backend.isAvailable());
    });

    it('fails closed on a reply nobody asked for', async () => {
      backend = fakeDaemon();
      const failed = new Promise<ZrdtBackendError>(resolve => {
        backend?.onUnavailable(resolve);
      });
      await backend.call(Op.HEADS, ascii('twice'));
      const error = await failed;
      assert.match(error.message, /nobody asked for/);
      assert.isFalse(backend.isAvailable());
    });

    it('fails closed when the binary cannot be started', async () => {
      backend = new DaemonBackend({ path: '/nonexistent/zrdtd' });
      await assert.isRejected(
        backend.call(Op.VERSION, new Uint8Array(0)),
        /unavailable/
      );
      assert.isFalse(backend.isAvailable());
    });

    it('needs ZRDT_DAEMON or a path', () => {
      const saved = process.env.ZRDT_DAEMON;
      delete process.env.ZRDT_DAEMON;
      try {
        assert.throws(() => new DaemonBackend(), /ZRDT_DAEMON is not set/);
      } finally {
        if (saved !== undefined) {
          process.env.ZRDT_DAEMON = saved;
        }
      }
    });

    it('does not encode op bodies yet (pending Proto.lean)', async () => {
      backend = fakeDaemon();
      await assert.isRejected(backend.version(), /TODO\(zrdt\)/);
    });
  });
});
