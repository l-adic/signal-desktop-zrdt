// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Pieces on Signal's CDN (zrdt docs/apps/BUILD_M1.md §B.9; docs/zrdt/
// FORK_MAP.md §4). Uploads go straight to `encryptAndUploadAttachment` with a
// fresh 64-byte key each, never through `uploadAttachment`, whose cache
// reuses a CDN object for 3 days. Downloads go straight to `getAttachment`
// and `decryptAttachmentV2ToSink`, in memory, capped at the ciphertext size
// of the size the descriptor gives (the direct path has no cap of its own).
//
// Pointers are bearer tokens: they are never logged (only an 8-character
// prefix of the CDN key), never sent to the endpoint, and live only inside
// openings (field 216 is committed).

import { Writable } from 'node:stream';

import { createLogger } from '../../logging/log.std.ts';
import * as Errors from '../../types/errors.std.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import { getRandomBytes } from '../../Crypto.node.ts';
import { encryptAndUploadAttachment } from '../../util/uploadAttachment.preload.ts';
import { getAttachment } from '../../textsecure/WebAPI.preload.ts';
import {
  decryptAttachmentV2ToSink,
  splitKeys,
} from '../../AttachmentCrypto.node.ts';
import { HTTPError } from '../../types/HTTPError.std.ts';
import type { Downloaded, HostCdn } from './host.node.ts';
import type { PointerShape } from './pieces.std.ts';

const log = createLogger('zrdt/apps/cdn');

type Bytes = Uint8Array<ArrayBuffer>;

export type Pointer = Proto.AttachmentPointer.Params;

/** Uploads `data` with a fresh key; the pointer for field 216 or `sealedOnCdn`. */
export async function uploadFresh(data: Bytes): Promise<Pointer> {
  const keys = getRandomBytes(64);
  const { cdnKey, cdnNumber, encrypted } = await encryptAndUploadAttachment({
    keys,
    needIncrementalMac: false,
    plaintext: { data },
    uploadType: 'standard',
  });
  return {
    attachmentIdentifier: { cdnKey },
    clientUuid: null,
    contentType: 'application/octet-stream',
    key: keys,
    size: data.byteLength,
    thumbnail: null,
    digest: encrypted.digest,
    incrementalMac: null,
    chunkSize: null,
    fileName: null,
    flags: null,
    width: null,
    height: null,
    caption: null,
    blurHash: null,
    uploadTimestamp: BigInt(Date.now()),
    cdnNumber,
    audioWaveform: null,
    audioDurationSeconds: null,
  };
}

class CappedSink extends Writable {
  readonly chunks = new Array<Buffer<ArrayBuffer>>();
  #size = 0;
  readonly #cap: number;

  constructor(cap: number) {
    super();
    this.#cap = cap;
  }

  override _write(
    chunk: Buffer<ArrayBuffer>,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.#size += chunk.length;
    if (this.#size > this.#cap) {
      callback(new Error('zrdt apps: a piece is larger than announced'));
      return;
    }
    this.chunks.push(chunk);
    callback();
  }
}

function cdnKeyOf(pointer: Proto.AttachmentPointer | Pointer): string {
  const id = pointer.attachmentIdentifier;
  if (id && 'cdnKey' in id && id.cdnKey) {
    return id.cdnKey;
  }
  if (id && 'cdnId' in id && id.cdnId != null) {
    return String(id.cdnId);
  }
  return '';
}

/**
 * Downloads one object and decrypts it in memory: exactly `size` plaintext
 * bytes, or why not (404: missing; a bad MAC or digest: bad).
 */
export async function downloadExact(
  pointer: Proto.AttachmentPointer | Pointer,
  size: number
): Promise<Downloaded> {
  const cdnKey = cdnKeyOf(pointer);
  try {
    if (!pointer.key || !pointer.digest || cdnKey === '') {
      return { kind: 'missing' };
    }
    const ciphertextStream = await getAttachment({
      cdnKey,
      cdnNumber: pointer.cdnNumber ?? 0,
      options: { disableRetries: true, timeout: 30_000 },
    });
    const { aesKey, macKey } = splitKeys(pointer.key);
    const sink = new CappedSink(size);
    await decryptAttachmentV2ToSink(
      {
        idForLogging: `zrdtApps/${cdnKey.slice(0, 8)}`,
        size,
        ciphertextStream,
        type: 'standard',
        theirIncrementalMac: undefined,
        theirChunkSize: undefined,
        integrityCheck: { type: 'encrypted', digest: pointer.digest },
        aesKey,
        macKey,
      },
      sink
    );
    const bytes = new Uint8Array(Buffer.concat(sink.chunks));
    if (bytes.length !== size) {
      return { kind: 'bad', message: `${bytes.length} bytes, not ${size}` };
    }
    return { kind: 'ok', bytes };
  } catch (error) {
    if (error instanceof HTTPError && error.code === 404) {
      return { kind: 'missing' };
    }
    const message = Errors.toLogFormat(error).split('\n')[0] ?? 'error';
    log.warn(`download of ${cdnKey.slice(0, 8)} failed: ${message}`);
    if (/mac|digest|integrity/i.test(message)) {
      return { kind: 'bad', message };
    }
    return { kind: 'error', message };
  }
}

function shapeOf(p: Proto.AttachmentPointer): PointerShape {
  const size = p.size ?? undefined;
  return {
    size,
    complete:
      cdnKeyOf(p) !== '' &&
      p.key?.byteLength === 64 &&
      p.digest?.byteLength === 32,
  };
}

/** The CDN as the app host uses it. */
export const appsCdn: HostCdn<Proto.AttachmentPointer | Pointer> = {
  upload: uploadFresh,
  encodePointers: pointers =>
    Proto.ZrdtPointers.encode({
      pieces: [...pointers],
    }),
  decodePointers: bytes => {
    try {
      const decoded = Proto.ZrdtPointers.decode(bytes);
      return decoded.pieces.map(pointer => ({
        pointer,
        shape: shapeOf(pointer),
      }));
    } catch {
      return undefined;
    }
  },
  download: (pointer, size) => downloadExact(pointer, size),
};
