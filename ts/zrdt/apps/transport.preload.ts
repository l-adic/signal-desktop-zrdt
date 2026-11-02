// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The app transport in the desktop (zrdt docs/apps/BUILD_M1.md §B.9, §B.10;
// docs/zrdt/FORK_MAP.md): Signal's side of ./host.node.ts. It supplies the
// groups (members and the identity keys this device holds), the sends
// (Content 205 to the group, piece repair and channel catch-up requests,
// sealed replies), the CDN (./cdn.preload.ts) and the zrdt service, and it
// runs the local endpoint (./endpoint.node.ts) with the git routes.
//
// Hooks into the existing paths, kept to calls into this module:
// - MessageReceiver: Content 205 -> `handleZrdtAppMessage` (before the
//   envelope leaves the cache, the record and its opening are stored);
// - resend.preload.ts: a ZrdtServeRequest with `announcement` or `channel`
//   -> `handleAppsServeRequest`; a ZrdtServed for one of our app requests
//   -> `handleAppsServed`;
// - background.preload.ts: `startApps()` after the zrdt service starts,
//   when ZRDT_APPS=1.

import { ContentHint } from '@signalapp/libsignal-client';
import { join } from 'node:path';

import * as Bytes from '../../Bytes.std.ts';
import { createLogger } from '../../logging/log.std.ts';
import * as Errors from '../../types/errors.std.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import { messageSender } from '../../textsecure/SendMessage.preload.ts';
import { signalProtocolStore } from '../../SignalProtocolStore.preload.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { getSendOptions } from '../../util/getSendOptions.preload.ts';
import { sendContentMessageToGroup } from '../../util/sendToGroup.preload.ts';
import { handleMessageSend } from '../../util/handleMessageSend.preload.ts';
import { deriveGroupFields } from '../../groups.preload.ts';
import { isAciString } from '../../util/isAciString.std.ts';
import type { AciString } from '../../types/ServiceId.std.ts';
import type { ConversationModel } from '../../models/conversations.preload.ts';
import { drop } from '../../util/drop.std.ts';
import { findLengthDelimitedField } from '../wire.std.ts';
import { decodeServeEntries } from '../backends/codec.std.ts';
import { checkServedReply } from '../serveRequests.std.ts';
import { decodeServeHeader, keyTag, openServeReply } from '../seal.node.ts';
import { sendZrdtServed } from '../served.preload.ts';
import { appsBackend, zrdtService } from '../service.preload.ts';
import { loadOrFetchIdentityKey } from '../send.preload.ts';
import type { AppsApi } from './api.std.ts';
import {
  APP_GIT,
  CONTENT_ZRDT_APP,
  PIECE_EXP,
  toHex,
} from './appMessage.std.ts';
import { appOpenings } from './appOpenings.preload.ts';
import { appsCdn, downloadExact } from './cdn.preload.ts';
import type { Pointer } from './cdn.preload.ts';
import { isTamperVillain } from './demoHooks.std.ts';
import { AppsEndpoint } from './endpoint.node.ts';
import type { EndpointInfo } from './endpoint.node.ts';
import { gitRoutes } from './gitRoutes.std.ts';
import { AppsHost } from './host.node.ts';
import type {
  HostGroup,
  HostMember,
  RepairRequestMessage,
} from './host.node.ts';

const log = createLogger('zrdt/apps');

type ArrayBytes = Uint8Array<ArrayBuffer>;

// --- Signal's side ---------------------------------------------------------------

function memberName(aci: string): string {
  const c = window.ConversationController.get(aci);
  return c?.getTitle() ?? aci.slice(0, 8);
}

async function toHostGroup(
  conversation: ConversationModel
): Promise<HostGroup | undefined> {
  const groupIdB64 = conversation.get('groupId');
  const info = conversation.getGroupV2Info();
  if (
    groupIdB64 == null ||
    info === undefined ||
    !conversation.areWeAGroupMember()
  ) {
    return undefined;
  }
  const groupId = Bytes.fromBase64(groupIdB64);
  if (groupId.length !== 32) {
    return undefined;
  }
  const ourAci = itemStorage.user.getAci();
  const members = new Array<HostMember>();
  for (const { aci } of conversation.get('membersV2') ?? []) {
    if (!isAciString(aci)) {
      continue;
    }
    let key: ArrayBytes | undefined;
    if (aci === ourAci) {
      const ours = signalProtocolStore.getIdentityKeyPair(aci);
      key = ours ? new Uint8Array(ours.publicKey.serialize()) : undefined;
    } else {
      try {
        // oxlint-disable-next-line no-await-in-loop
        key = await loadOrFetchIdentityKey(aci, log);
      } catch (error) {
        log.warn(`no identity key for ${aci}: ${Errors.toLogFormat(error)}`);
      }
    }
    members.push(
      key === undefined
        ? { aci, name: memberName(aci) }
        : { aci, name: memberName(aci), key }
    );
  }
  return {
    conversationId: conversation.id,
    title: conversation.getTitle(),
    groupId,
    groupV2: Proto.GroupContextV2.encode({
      masterKey: info.masterKey,
      revision: info.revision,
      groupChange: null,
    }),
    members,
  };
}

async function allGroups(): Promise<Array<HostGroup>> {
  const out = new Array<HostGroup>();
  for (const c of window.ConversationController.getAll()) {
    if (c.get('groupVersion') !== 2) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const g = await toHostGroup(c);
    if (g) {
      out.push(g);
    }
  }
  return out;
}

/**
 * Sends Content 205 to the group's recipients by sender key, inside the
 * conversation's queue, with the send type the sendLog does not keep (T-M2).
 * The bytes are decoded and must encode back identically: what receivers
 * slice from the plaintext is exactly what this device committed.
 */
async function sendApp(
  conversationId: string,
  appMessage: ArrayBytes,
  recipients: ReadonlyArray<string>
): Promise<void> {
  const conversation = window.ConversationController.get(conversationId);
  if (!conversation) {
    throw new Error(`zrdt apps: no conversation ${conversationId}`);
  }
  const decoded = Proto.ZrdtAppMessage.decode(appMessage);
  if (!Bytes.areEqual(Proto.ZrdtAppMessage.encode(decoded), appMessage)) {
    throw new Error('zrdt apps: Content 205 does not encode back identically');
  }
  const contentMessage: Proto.Content.Params = {
    content: { zrdtApp: decoded },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  };
  const timestamp = Date.now();
  await conversation.queueJob('zrdt/apps/send', async () =>
    handleMessageSend(
      sendContentMessageToGroup({
        contentHint: ContentHint.Implicit,
        contentMessage,
        messageId: undefined,
        recipients: recipients.filter(isAciString),
        sendOptions: await getSendOptions(conversation.attributes),
        sendTarget: conversation.toSenderKeyTarget(),
        sendType: 'zrdtApp',
        story: false,
        timestamp,
        urgent: false,
      }),
      { messageIds: [], sendType: 'zrdtApp' }
    )
  );
}

async function sendIndividual(
  toAci: string,
  content: Proto.Content.Params['content'],
  what: string
): Promise<void> {
  const recipient = window.ConversationController.getOrCreate(toAci, 'private');
  const serviceId = recipient.getServiceId();
  if (!serviceId) {
    log.warn(`${what}: no service id for ${toAci}`);
    return;
  }
  await messageSender.sendIndividualProto({
    contentHint: ContentHint.Implicit,
    serviceId,
    options: await getSendOptions(recipient.attributes),
    proto: {
      content,
      pniSignatureMessage: null,
      senderKeyDistributionMessage: null,
    },
    timestamp: Date.now(),
    urgent: false,
  });
}

async function sendRepairRequest(
  toAci: string,
  request: RepairRequestMessage
): Promise<void> {
  await sendIndividual(
    toAci,
    {
      zrdtServeRequest: {
        groupId: request.groupId,
        requestId: request.requestId,
        digests: [...request.wanted],
        since: [...(request.since ?? [])],
        catchup: request.channel !== undefined,
        announcement: request.announcement ?? null,
        channel: request.channel ?? null,
      },
    },
    request.channel !== undefined
      ? 'ZrdtServeRequest (channel)'
      : 'ZrdtServeRequest (pieces)'
  );
}

// --- the host ------------------------------------------------------------------------

type P = Proto.AttachmentPointer | Pointer;

let host: AppsHost<P> | undefined;
let endpoint: AppsEndpoint | undefined;

function getHost(): AppsHost<P> {
  host ??= new AppsHost<P>({
    stores: zrdtService,
    apps: () => appsBackend(),
    cdn: appsCdn,
    openings: appOpenings(),
    env: process.env,
    pieceExp: PIECE_EXP,
    tamperServed: isTamperVillain,
    log: {
      info: message => log.info(message),
      warn: message => log.warn(message),
    },
    registerRoutes: (app, routes) => {
      if (endpoint === undefined) {
        throw new Error('zrdt apps: the endpoint is not running');
      }
      endpoint.registerRoutes(app, routes);
    },
    signal: {
      ourAci: () => itemStorage.user.getAci(),
      ourKey: () => {
        const aci = itemStorage.user.getAci();
        const pair = aci
          ? signalProtocolStore.getIdentityKeyPair(aci)
          : undefined;
        return pair ? new Uint8Array(pair.publicKey.serialize()) : undefined;
      },
      groups: () => allGroups(),
      group: async conversationId => {
        const c = window.ConversationController.get(conversationId);
        return c ? toHostGroup(c) : undefined;
      },
      memberName,
      sendApp,
      sendRepairRequest,
      sendRepairReply: async (toAci, groupId, reply, key) => {
        await sendZrdtServed({ groupId, reply, key });
        log.info(`sealed app reply sent to ${toAci}`);
      },
    },
  });
  return host;
}

/** The apps API for app code (the torrent manager, the dialogs). */
export function getAppsApi(): AppsApi {
  return getHost();
}

/** The endpoint's address and token files, once it runs (CI hooks, the harness). */
export function appsEndpointInfo(): EndpointInfo | undefined {
  return endpoint?.info();
}

/**
 * Starts the local endpoint with the git routes (ZRDT_APPS=1). The port is
 * ZRDT_APPS_PORT (0 or unset: one the OS picks).
 */
export async function startApps(): Promise<void> {
  if (process.env.ZRDT_APPS !== '1' || endpoint !== undefined) {
    return;
  }
  const port = Number(process.env.ZRDT_APPS_PORT ?? '0');
  endpoint = new AppsEndpoint({
    userData: window.SignalContext.getPath('userData'),
    port: Number.isSafeInteger(port) && port >= 0 ? port : 0,
    log: {
      info: message => log.info(message),
      warn: message => log.warn(message),
    },
  });
  endpoint.registerRoutes(
    APP_GIT,
    gitRoutes(getHost().gitDesk(), {
      pieceSize: 2 ** PIECE_EXP,
      maxStream: 64 * 2 ** PIECE_EXP,
      maxObjectsPerRequest: 256,
    })
  );
  try {
    const info = await endpoint.start();
    log.info(`apps endpoint: ${info.url ?? ''} ${info.socket ?? ''}`);
  } catch (error) {
    log.error('apps endpoint failed to start', Errors.toLogFormat(error));
    endpoint = undefined;
  }
}

// --- receive (MessageReceiver) --------------------------------------------------------

/**
 * A decrypted Content 205. The bytes as sent are sliced from the plaintext
 * (never re-encoded); the record and its opening are stored before this
 * returns, so the envelope may leave the cache; the fetch runs after. Never
 * throws.
 */
export async function handleZrdtAppMessage({
  senderAci,
  message,
  plaintext,
}: Readonly<{
  senderAci: string | undefined;
  message: Proto.ZrdtAppMessage;
  plaintext: ArrayBytes;
}>): Promise<void> {
  try {
    if (senderAci === undefined || !isAciString(senderAci)) {
      log.warn('an app message without an ACI sender; dropped');
      return;
    }
    const field = findLengthDelimitedField(plaintext, CONTENT_ZRDT_APP);
    if (typeof field !== 'object') {
      log.warn(`an app message whose field 205 is ${field}; dropped`);
      return;
    }
    const bytes = plaintext.slice(field.start, field.end);
    const masterKey = message.groupV2?.masterKey;
    if (!masterKey) {
      log.warn('an app message without a group; dropped');
      return;
    }
    const groupId = Bytes.toBase64(deriveGroupFields(masterKey).id);
    const conversation = window.ConversationController.get(groupId);
    if (!conversation) {
      log.warn('an app message for an unknown group; dropped');
      return;
    }
    await getHost().receive({
      conversationId: conversation.id,
      senderAci,
      bytes,
    });
  } catch (error) {
    log.error('handleZrdtAppMessage failed', Errors.toLogFormat(error));
  }
}

// --- SERVE requests and replies of the apps (resend.preload.ts) --------------------

/** Whether a ZrdtServeRequest is an app's (piece repair or channel catch-up). */
export function isAppsServeRequest(request: Proto.ZrdtServeRequest): boolean {
  return (
    request.announcement?.byteLength === 32 ||
    request.channel?.byteLength === 32
  );
}

/** A member's app SERVE request; answered in the background. */
export function handleAppsServeRequest(
  requesterAci: AciString,
  request: Proto.ZrdtServeRequest
): void {
  drop(
    (async () => {
      try {
        const { groupId, requestId } = request;
        if (!groupId || !requestId || requestId.byteLength !== 16) {
          return;
        }
        // The key we hold for the requester now: SERVE checks its tag, and
        // the reply is sealed to exactly this key.
        const key = await signalProtocolStore.loadIdentityKey(requesterAci);
        const n = await getHost().onRepairRequest(
          requesterAci,
          key ?? undefined,
          {
            groupId: new Uint8Array(groupId),
            requestId: new Uint8Array(requestId),
            ...(request.announcement?.byteLength === 32
              ? { announcement: new Uint8Array(request.announcement) }
              : {}),
            ...(request.channel?.byteLength === 32
              ? { channel: new Uint8Array(request.channel) }
              : {}),
            wanted: request.digests
              .filter(d => d.byteLength === 32)
              .map(d => new Uint8Array(d)),
            since: request.since
              .filter(d => d.byteLength === 32)
              .map(d => new Uint8Array(d)),
          }
        );
        log.info(
          `answered an app SERVE request from ${requesterAci}: ${n} entries`
        );
      } catch (error) {
        log.error('app SERVE request failed', Errors.toLogFormat(error));
      }
    })()
  );
}

/** Whether a sealed reply answers one of this device's app requests. */
export function isAppsServed(served: Proto.ZrdtServed): boolean {
  const header = served.header ? decodeServeHeader(served.header) : undefined;
  return (
    header !== undefined &&
    host !== undefined &&
    host.ownsRepairRequest(toHex(header.requestId))
  );
}

/**
 * A sealed reply to one of this device's app requests: JOIN §4.4's checks on
 * the host's book, the seal opened under our key (the sealed bytes inline,
 * or downloaded from `sealedOnCdn`), then the host takes the entries.
 */
export async function handleAppsServed(
  senderAci: AciString,
  served: Proto.ZrdtServed
): Promise<void> {
  const h = host;
  const { groupId, header, ephemeralKey } = served;
  if (h === undefined || !groupId || !header || !ephemeralKey) {
    return;
  }
  const parsed = decodeServeHeader(header);
  const ourAci = itemStorage.user.getCheckedAci();
  const ourKeys = signalProtocolStore.getIdentityKeyPair(ourAci);
  if (parsed === undefined || ourKeys === undefined) {
    return;
  }
  const requestId = toHex(parsed.requestId);
  const keyNow = await signalProtocolStore.loadIdentityKey(senderAci);
  const check = checkServedReply({
    book: h.repairBook(),
    now: Date.now(),
    headerAci: parsed.requesterAci,
    headerKeyTag: parsed.keyTag,
    headerRequestId: parsed.requestId,
    conversationId: h.repairBook().get(requestId)?.conversationId,
    ourAci,
    ourKeyTag: keyTag(ourKeys.publicKey.serialize()),
    senderAci,
    responderKeyNow: keyNow ? toHex(keyNow) : undefined,
  });
  if (!check.ok) {
    log.warn(`app reply from ${senderAci} dropped: ${check.reason}`);
    return;
  }
  let sealed: ArrayBytes | undefined = served.sealed
    ? new Uint8Array(served.sealed)
    : undefined;
  if (sealed === undefined && served.sealedOnCdn) {
    const size = served.sealedOnCdn.size ?? 0;
    const got = await downloadExact(served.sealedOnCdn, size);
    if (got.kind !== 'ok') {
      log.warn(`app reply from ${senderAci}: sealedOnCdn ${got.kind}`);
      return;
    }
    sealed = got.bytes;
  }
  if (sealed === undefined) {
    return;
  }
  const entriesBytes = openServeReply({
    group: new Uint8Array(groupId),
    headerBytes: new Uint8Array(header),
    ephemeralKey: new Uint8Array(ephemeralKey),
    sealed,
    ourPrivateKey: ourKeys.privateKey,
    ourPublicKey: ourKeys.publicKey,
  });
  const entries = entriesBytes ? decodeServeEntries(entriesBytes) : undefined;
  if (entries === undefined) {
    log.warn(`app reply from ${senderAci} does not open or parse`);
    return;
  }
  h.repairBook().complete(requestId);
  await h.onRepairReply(senderAci, requestId, entries);
}

// --- CI hooks (ts/zrdt/ci.preload.ts) --------------------------------------------------

/** The apps' state on this desktop, for the smoke (no pointers, no openings). */
export async function appsStatus(conversationId: string): Promise<unknown> {
  const h = getHost();
  return {
    available: h.available(),
    endpoint: appsEndpointInfo() ?? null,
    torrent: await h.announcements(conversationId, 'bt'),
    git: await h.announcements(conversationId, 'git-sha256'),
  };
}

/** The repair of an announcement, for the smoke. */
export function appsRepairStatus(digest: string): unknown {
  return getHost().repairStatus(digest) ?? null;
}

/** The app data dir of this desktop (for the harness). */
export function appsDataDir(): string {
  return join(window.SignalContext.getPath('userData'), 'zrdt-apps');
}
