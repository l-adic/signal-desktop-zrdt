// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// PROTOTYPE (lane apps-map, docs/zrdt/FORK_MAP.md §8): not M1 code. It proves
// the riskiest fork plumbing for zrdt apps on the mock server, outside the
// chat message pipeline:
//
//   - send: fresh-key CDN uploads (no reuse cache), then one app-tagged
//     Content 205 (ZrdtAppMessage, laid out like a DataMessage) to the group
//     by sender key, with send type 'zrdtApp' (kept out of the sendLog);
//   - receive: MessageReceiver hands Content 205 here; the bytes as sent are
//     sliced from the plaintext (field 205), checked to round-trip, and each
//     piece is downloaded and decrypted in memory (no timeline row, no
//     attachment job, no auto-download rule);
//   - the local endpoint: an HTTP server in this preload on a Unix socket in
//     userData (0600) and, optionally, on 127.0.0.1:<port>, guarded by a
//     bearer token in a 0600 file, so a CLI can drive this desktop.
//
// No zrdt record is made here: no COMMIT, no ACCEPT, no audience.

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { ContentHint } from '@signalapp/libsignal-client';

import * as Bytes from '../../Bytes.std.ts';
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
import { sendContentMessageToGroup } from '../../util/sendToGroup.preload.ts';
import { getSendOptions } from '../../util/getSendOptions.preload.ts';
import { deriveGroupFields } from '../../groups.preload.ts';
import { isAciString } from '../../util/isAciString.std.ts';
import { drop } from '../../util/drop.std.ts';
import { findLengthDelimitedField } from '../wire.std.ts';

const log = createLogger('zrdt/apps/probe');

type ArrayBytes = Uint8Array<ArrayBuffer>;

/** Content field number of ZrdtAppMessage. */
const CONTENT_ZRDT_APP = 205;

function sha256Hex(data: Uint8Array<ArrayBuffer>): string {
  return createHash('sha256').update(data).digest('hex');
}

// --- send ---------------------------------------------------------------------

export type AppProbeSendArgs = Readonly<{
  /** The group's id (base64), as in SignalCI.getConversationId. */
  groupId: string;
  app: string;
  channel: string;
  body: string;
  /** One CDN piece per entry, base64. */
  piecesBase64: ReadonlyArray<string>;
}>;

export type AppProbeSendResult = Readonly<{
  timestamp: number;
  recipients: number;
  contentBytes: number;
  appMessageBytes: number;
  pieces: ReadonlyArray<{
    cdnKey: string;
    cdnNumber: number;
    size: number;
    ciphertextSize: number;
    sha256: string;
    uploadMs: number;
  }>;
  sendMs: number;
  successfulServiceIds: number;
  failedServiceIds: number;
}>;

export async function appProbeSend(
  args: AppProbeSendArgs
): Promise<AppProbeSendResult> {
  const conversation = window.ConversationController.get(args.groupId);
  if (!conversation) {
    throw new Error(`appProbeSend: no conversation for ${args.groupId}`);
  }
  const groupV2 = conversation.getGroupV2Info();
  if (!groupV2) {
    throw new Error('appProbeSend: not a GroupV2 conversation');
  }

  // 1. Fresh-key uploads: a new 64-byte key and a new CDN object per piece,
  //    never Desktop's 3-day reuse (uploadAttachment's reuse path).
  const pieces: Array<Proto.AttachmentPointer.Params> = [];
  const report: Array<AppProbeSendResult['pieces'][number]> = [];
  for (const b64 of args.piecesBase64) {
    const data = Bytes.fromBase64(b64);
    const keys = getRandomBytes(64);
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop
    const { cdnKey, cdnNumber, encrypted } = await encryptAndUploadAttachment({
      keys,
      needIncrementalMac: false,
      plaintext: { data },
      uploadType: 'standard',
    });
    const uploadTimestamp = Date.now();
    pieces.push({
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
      uploadTimestamp: BigInt(uploadTimestamp),
      cdnNumber,
      audioWaveform: null,
      audioDurationSeconds: null,
    });
    report.push({
      cdnKey,
      cdnNumber,
      size: data.byteLength,
      ciphertextSize: encrypted.ciphertextSize,
      sha256: sha256Hex(data),
      uploadMs: uploadTimestamp - started,
    });
  }

  // 2. The app message. In M1 the committed part (201, 210-216) comes from
  //    zrdtd's APP_MESSAGE and field 200 from the freeze; here it is built
  //    directly.
  const appMessage: Proto.ZrdtAppMessage.Params = {
    groupV2: {
      masterKey: groupV2.masterKey,
      revision: groupV2.revision,
      groupChange: null,
    },
    zrdt: null,
    zrdtAudience: null,
    app: args.app,
    channel: args.channel,
    body: Bytes.fromString(args.body),
    descriptor: null,
    pointers: { pieces },
  };
  const contentMessage: Proto.Content.Params = {
    content: { zrdtApp: appMessage },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  };
  const contentBytes = Proto.Content.encode(contentMessage).byteLength;
  const appMessageBytes = Proto.ZrdtAppMessage.encode(appMessage).byteLength;

  // 3. One sender-key send to the group, inside the conversation queue (as
  //    sendNormalMessage does), to the current members but us.
  const timestamp = Date.now();
  const recipients = groupV2.members;
  const started = Date.now();
  const result = await conversation.queueJob('zrdt/appProbeSend', async () =>
    sendContentMessageToGroup({
      contentHint: ContentHint.Implicit,
      contentMessage,
      messageId: undefined,
      recipients,
      sendOptions: await getSendOptions(conversation.attributes),
      sendTarget: conversation.toSenderKeyTarget(),
      sendType: 'zrdtApp',
      story: false,
      timestamp,
      urgent: false,
    })
  );
  const sendMs = Date.now() - started;
  log.info(
    `sent app=${args.app} channel=${args.channel} at ${timestamp}: ` +
      `${pieces.length} pieces, Content ${contentBytes} B, ` +
      `${result.successfulServiceIds?.length ?? 0} ok, ` +
      `${result.failoverServiceIds?.length ?? 0} failover`
  );
  return {
    timestamp,
    recipients: recipients.length,
    contentBytes,
    appMessageBytes,
    pieces: report,
    sendMs,
    successfulServiceIds: result.successfulServiceIds?.length ?? 0,
    failedServiceIds: result.errors?.length ?? 0,
  };
}

// --- receive -----------------------------------------------------------------

export type AppProbePieceResult = Readonly<{
  cdnKey: string;
  cdnNumber: number;
  size: number;
  ok: boolean;
  sha256?: string;
  error?: string;
  downloadMs: number;
}>;

export type AppProbeReceived = {
  at: number;
  timestamp: number;
  senderAci: string;
  senderDevice: number;
  groupId: string | undefined;
  isMember: boolean;
  app: string;
  channel: string;
  body: string;
  /** Field 205 sliced from the plaintext: the bytes as sent. */
  appMessageBytes: number;
  /** decode → encode gives the bytes as sent (needed for COMMIT/freeze). */
  roundTrip: boolean;
  pieces: Array<AppProbePieceResult>;
  done: boolean;
};

const received = new Array<AppProbeReceived>();
// The pointers of each received message, kept for refetch (bearer tokens:
// in memory only).
const pointersOf = new Map<number, ReadonlyArray<Proto.AttachmentPointer>>();

class CollectSink extends Writable {
  readonly chunks = new Array<Buffer<ArrayBuffer>>();

  override _write(
    chunk: Buffer<ArrayBuffer>,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(chunk);
    callback();
  }
}

/** Downloads one piece straight from the CDN and decrypts it in memory. */
async function fetchPiece(
  pointer: Proto.AttachmentPointer
): Promise<AppProbePieceResult> {
  const started = Date.now();
  const cdnKey =
    pointer.attachmentIdentifier?.cdnKey ??
    String(pointer.attachmentIdentifier?.cdnId ?? '');
  const cdnNumber = pointer.cdnNumber ?? 0;
  const size = pointer.size ?? 0;
  try {
    if (!pointer.key || !pointer.digest) {
      throw new Error('pointer without key or digest');
    }
    const ciphertextStream = await getAttachment({
      cdnKey,
      cdnNumber,
      options: { disableRetries: true, timeout: 30_000 },
    });
    const { aesKey, macKey } = splitKeys(pointer.key);
    const sink = new CollectSink();
    await decryptAttachmentV2ToSink(
      {
        idForLogging: `appProbe/${cdnKey.slice(0, 8)}`,
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
    const plaintext = Buffer.concat(sink.chunks);
    return {
      cdnKey,
      cdnNumber,
      size,
      ok: plaintext.byteLength === size,
      sha256: sha256Hex(plaintext),
      downloadMs: Date.now() - started,
    };
  } catch (error) {
    return {
      cdnKey,
      cdnNumber,
      size,
      ok: false,
      error: Errors.toLogFormat(error).split('\n')[0],
      downloadMs: Date.now() - started,
    };
  }
}

// Never throws (fetchPiece catches).
async function fetchAll(entry: AppProbeReceived): Promise<void> {
  const pointers = pointersOf.get(entry.timestamp) ?? [];
  // oxlint-disable-next-line no-param-reassign
  entry.pieces = [];
  for (const pointer of pointers) {
    // oxlint-disable-next-line no-await-in-loop
    entry.pieces.push(await fetchPiece(pointer));
  }
  // oxlint-disable-next-line no-param-reassign
  entry.done = true;
  log.info(
    `fetched ${entry.pieces.filter(p => p.ok).length}/${pointers.length} ` +
      `pieces of ${entry.timestamp}`
  );
}

/**
 * Called by MessageReceiver for a decrypted Content 205, with the plaintext.
 * Never throws: the envelope is removed from the cache by the caller.
 */
export async function handleZrdtAppMessage({
  senderAci,
  senderDevice,
  timestamp,
  message,
  plaintext,
}: Readonly<{
  senderAci: string | undefined;
  senderDevice: number | undefined;
  timestamp: number;
  message: Proto.ZrdtAppMessage;
  plaintext: ArrayBytes;
}>): Promise<void> {
  try {
    const field = findLengthDelimitedField(plaintext, CONTENT_ZRDT_APP);
    const asSent =
      typeof field === 'object'
        ? plaintext.slice(field.start, field.end)
        : undefined;
    const reencoded = Proto.ZrdtAppMessage.encode(message);
    const masterKey = message.groupV2?.masterKey;
    const groupId = masterKey
      ? Bytes.toBase64(deriveGroupFields(masterKey).id)
      : undefined;
    const conversation = groupId
      ? window.ConversationController.get(groupId)
      : undefined;
    const isMember = Boolean(
      conversation &&
      senderAci &&
      isAciString(senderAci) &&
      conversation.areWeAGroupMember() &&
      conversation.hasMember(senderAci)
    );
    const entry: AppProbeReceived = {
      at: Date.now(),
      timestamp,
      senderAci: senderAci ?? '',
      senderDevice: senderDevice ?? 0,
      groupId,
      isMember,
      app: message.app ?? '',
      channel: message.channel ?? '',
      body: message.body ? Bytes.toString(message.body) : '',
      appMessageBytes: asSent?.byteLength ?? -1,
      roundTrip: asSent != null && Bytes.areEqual(asSent, reencoded),
      pieces: [],
      done: false,
    };
    received.push(entry);
    log.info(
      `received app=${entry.app} channel=${entry.channel} from ${senderAci}` +
        `.${senderDevice}: member=${isMember} roundTrip=${entry.roundTrip}`
    );
    if (!isMember) {
      return;
    }
    pointersOf.set(timestamp, message.pointers?.pieces ?? []);
    // Not awaited: the receive queue must not wait for the CDN.
    drop(fetchAll(entry));
  } catch (error) {
    log.error('handleZrdtAppMessage failed', Errors.toLogFormat(error));
  }
}

export function appProbeReceived(): Array<AppProbeReceived> {
  return received.map(entry => ({ ...entry, pieces: [...entry.pieces] }));
}

/** Downloads the pieces of a received message again (after a CDN change). */
export async function appProbeRefetch(
  timestamp: number
): Promise<Array<AppProbePieceResult>> {
  const pointers = pointersOf.get(timestamp);
  if (!pointers) {
    throw new Error(`appProbeRefetch: nothing received at ${timestamp}`);
  }
  const out = new Array<AppProbePieceResult>();
  for (const pointer of pointers) {
    // oxlint-disable-next-line no-await-in-loop
    out.push(await fetchPiece(pointer));
  }
  return out;
}

// --- the local endpoint -----------------------------------------------------------

export type AppProbeListenArgs = Readonly<{
  /** Also listen on 127.0.0.1:port (0 picks one); omit for the socket only. */
  port?: number;
}>;

export type AppProbeListenResult = Readonly<{
  socketPath: string;
  tokenPath: string;
  port: number | undefined;
}>;

let listening: Promise<AppProbeListenResult> | undefined;

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks = new Array<Buffer<ArrayBuffer>>();
  for await (const chunk of req) {
    chunks.push(chunk as Buffer<ArrayBuffer>);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}

function makeHandler(token: string): http.RequestListener {
  return (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    // A browser page can reach 127.0.0.1 (CSRF, DNS rebinding): demand the
    // token, refuse any Origin header and any Host but loopback.
    const host = req.headers.host ?? '';
    if (req.headers.origin != null) {
      reply(403, { error: 'no browser requests' });
      return;
    }
    if (host !== '' && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      reply(403, { error: 'bad host' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      reply(401, { error: 'bad token' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const answer = async (): Promise<unknown> => {
      if (route === 'GET /received') {
        return appProbeReceived();
      }
      if (route === 'POST /send') {
        return appProbeSend((await readJson(req)) as AppProbeSendArgs);
      }
      if (route === 'POST /refetch') {
        const { timestamp } = (await readJson(req)) as { timestamp: number };
        return appProbeRefetch(timestamp);
      }
      if (route === 'GET /whoami') {
        return { pid: process.pid, type: process.type ?? 'unknown' };
      }
      throw Object.assign(new Error(`no route ${route}`), { status: 404 });
    };
    drop(
      (async () => {
        try {
          reply(200, await answer());
        } catch (error) {
          const { status, message } = error as Error & { status?: number };
          reply(status ?? 500, { error: message });
        }
      })()
    );
  };
}

async function listen(
  server: http.Server,
  target: string | number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (typeof target === 'string') {
      server.listen(target, () => resolve());
    } else {
      server.listen(target, '127.0.0.1', () => resolve());
    }
  });
}

/**
 * Starts the endpoint: `<userData>/zrdt-apps.sock` (0600) and optionally a
 * loopback TCP port; the token goes to `<userData>/zrdt-apps-probe.token`
 * (0600). Idempotent.
 */
export function appProbeListen(
  args: AppProbeListenArgs = {}
): Promise<AppProbeListenResult> {
  listening ??= (async () => {
    const userData = window.SignalContext.getPath('userData');
    const socketPath = join(userData, 'zrdt-apps.sock');
    const tokenPath = join(userData, 'zrdt-apps-probe.token');
    const token = Bytes.toHex(getRandomBytes(32));
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    const handler = makeHandler(token);

    // A socket file left by a crash refuses the bind.
    await rm(socketPath, { force: true });
    const unixServer = http.createServer(handler);
    await listen(unixServer, socketPath);
    await chmod(socketPath, 0o600);

    let port: number | undefined;
    if (args.port != null) {
      const tcpServer = http.createServer(handler);
      await listen(tcpServer, args.port);
      port = (tcpServer.address() as AddressInfo).port;
    }
    log.info(
      `endpoint on ${socketPath}` + (port != null ? ` and :${port}` : '')
    );
    return { socketPath, tokenPath, port };
  })();
  return listening;
}
