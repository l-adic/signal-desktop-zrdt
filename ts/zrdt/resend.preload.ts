// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The resend protocol, through SERVE (zrdt docs/JOIN_PLAN.md sections 4.3,
// 4.4, 5, 10): ask for records by digest (1:1 to the referencing sender
// first, then to the group) with a ZrdtServeRequest; answer such requests
// with SERVE's reply, sealed to the key SERVE checked (served.preload.ts);
// take a sealed reply only if it passes the §4.4 checks
// (serveRequests.std.ts). Replies are always 1:1.
//
// The old paths are gone: no unsealed ZrdtResend, no ZrdtResendRequest, and
// a zrdt request never triggers the sendLog re-send (it would encrypt to
// whatever key is current then). Signal's own DecryptionErrorMessage retry
// stays as stock.

import { ContentHint } from '@signalapp/libsignal-client';

import * as Bytes from '../Bytes.std.ts';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import type { SignalService as Proto } from '../protobuf/index.std.ts';
import { DataReader } from '../sql/Client.preload.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import { messageSender } from '../textsecure/SendMessage.preload.ts';
import { signalProtocolStore } from '../SignalProtocolStore.preload.ts';
import { getSendOptions } from '../util/getSendOptions.preload.ts';
import { drop } from '../util/drop.std.ts';
import { sleep } from '../util/sleep.std.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { isAciString } from '../util/isAciString.std.ts';
import { uuidToBytes } from '../util/uuidToBytes.std.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import type { ResendTarget } from './resendLogic.std.ts';
import { ResendScheduler, readResendOptions } from './resendLogic.std.ts';
import {
  DIGEST_BYTES,
  REQUEST_ID_BYTES,
  SERVE_HEADER_BYTES,
} from './ZrdtBackend.std.ts';
import type { ServeHeld, ServeMode, ServeReply } from './ZrdtBackend.std.ts';
import { decodeServeEntries } from './backends/codec.std.ts';
import { ServeRequestBook, checkServedReply } from './serveRequests.std.ts';
import { decodeServeHeader, keyTag, openServeReply } from './seal.node.ts';
import { sendZrdtServed } from './served.preload.ts';
import { zrdtEvents, zrdtService } from './service.preload.ts';
import { acceptRelayedRecord, setGapState, toHex } from './receive.preload.ts';
import type { ZrdtBytes } from './receive.preload.ts';

const log = createLogger('zrdt/resend');

// zrdtEvents: (conversationId, hexDigests, 'requested' | 'still-missing').
// The compare screen uses it for "Asked; no answer." (no gap row there).
/** @knipignore used by the UI lane (T3) */
export const ZRDT_RESEND_STATE_EVENT = 'resendState';

export const zrdtResendScheduler = new ResendScheduler(
  {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      setTimeout(fn, ms);
    },
    has: (conversationId, digest) =>
      zrdtService.has(conversationId, Bytes.fromHex(digest)),
    sendRequest: (conversationId, target, digests) =>
      sendServeRequest(conversationId, target, digests),
    setGapState: async (conversationId, digests, state) => {
      zrdtEvents.emit(
        ZRDT_RESEND_STATE_EVENT,
        conversationId,
        [...digests],
        state
      );
      await setGapState(conversationId, digests, state);
    },
    onError: error => log.error('resend scheduler', Errors.toLogFormat(error)),
  },
  readResendOptions(process.env)
);

// The requests this device sent and has not completed (JOIN_PLAN §4.4).
const serveRequests = new ServeRequestBook();

// The UI's "Ask again" / "Ask for it" (gap row, compare screen). Asks now,
// 1:1 to `firstAskAci` if given (then the group after the timeout), else the
// group. Not deduped.
export async function requestMissing(
  conversationId: string,
  digests: Array<ZrdtBytes>,
  firstAskAci?: string
): Promise<void> {
  const ourAci = itemStorage.user.getCheckedAci();
  const first = firstAskAci && firstAskAci !== ourAci ? firstAskAci : undefined;
  await zrdtResendScheduler.ask(conversationId, digests.map(toHex), first, {
    force: true,
  });
}

// Author fast path (step 9): we hold the record (relayed); ask its author 1:1
// so its SERVE reply carries an author copy, which arrives live. Waits
// ZRDT_AUTHOR_FASTPATH_DELAY_MS first (0 in the app; the demo sets 3000 so
// the message reads "relayed by Bob" for a while before "confirmed by
// Alice"), and skips the ask if the live copy came meanwhile.
export async function requestAuthorCopy(
  conversationId: string,
  digest: string,
  authorAci: AciString
): Promise<void> {
  try {
    const delayMs = zrdtResendScheduler.options.authorFastPathDelayMs;
    if (delayMs > 0) {
      log.info(
        `author fast path for ${digest.slice(0, 8)}: asking in ${delayMs} ms`
      );
      await sleep(delayMs);
      if (await isLiveRecord(conversationId, digest)) {
        log.info(
          `author fast path for ${digest.slice(0, 8)}: live copy came; not asking`
        );
        return;
      }
    }
    log.info(`author fast path: asking ${authorAci} for ${digest.slice(0, 8)}`);
    await sendServeRequest(conversationId, { kind: 'direct', aci: authorAci }, [
      digest,
    ]);
  } catch (error) {
    log.warn('author fast path failed', Errors.toLogFormat(error));
  }
}

async function isLiveRecord(
  conversationId: string,
  digest: string
): Promise<boolean> {
  const rows = await DataReader.getZrdtProvenance(conversationId);
  return rows.some(row => row.kind === 'live' && toHex(row.digest) === digest);
}

// --- sending ------------------------------------------------------------------

function getGroupIdBytes(
  conversation: ConversationModel
): Uint8Array<ArrayBuffer> | undefined {
  const groupId = conversation.get('groupId');
  return groupId ? Bytes.fromBase64(groupId) : undefined;
}

// A ZrdtServeRequest or ZrdtNotFound, 1:1. (A ZrdtServed goes only through
// sendZrdtServed.)
async function sendControl(
  recipientAci: string,
  content: Proto.Content.Params['content'],
  what: string
): Promise<void> {
  const recipient = window.ConversationController.getOrCreate(
    recipientAci,
    'private'
  );
  const serviceId = recipient.getServiceId();
  if (!serviceId) {
    log.warn(`${what}: no service id for ${recipientAci}`);
    return;
  }
  const sendOptions = await getSendOptions(recipient.attributes);
  await messageSender.sendIndividualProto({
    contentHint: ContentHint.Implicit,
    serviceId,
    options: sendOptions,
    proto: {
      content,
      pniSignatureMessage: null,
      senderKeyDistributionMessage: null,
    },
    timestamp: Date.now(),
    urgent: false,
  });
  log.info(`${what} sent to ${recipientAci}`);
}

async function loadIdentityKeyHex(aci: string): Promise<string | undefined> {
  if (!isAciString(aci)) {
    return undefined;
  }
  const key = await signalProtocolStore.loadIdentityKey(aci);
  return key ? Bytes.toHex(key) : undefined;
}

// One request per member asked, each with its own request id, and the
// member's identity key at that time (§4.4: a reply is taken only if that
// key has not changed).
async function sendServeRequest(
  conversationId: string,
  target: ResendTarget,
  digests: ReadonlyArray<string>,
  mode: ServeMode = 'perDigest'
): Promise<void> {
  const conversation = window.ConversationController.get(conversationId);
  const groupId = conversation ? getGroupIdBytes(conversation) : undefined;
  if (!conversation || !groupId) {
    log.warn(`serve request: no group for ${conversationId}`);
    return;
  }
  const ourAci = itemStorage.user.getCheckedAci();
  const recipients =
    target.kind === 'direct'
      ? [target.aci]
      : conversation.getRecipients().filter(id => id !== ourAci);
  log.info(
    `serve request (${target.kind}, ${mode}) for ${digests
      .map(d => d.slice(0, 8))
      .join(',')}`
  );
  await Promise.all(
    recipients.map(async aci => {
      try {
        const requestId = globalThis.crypto.getRandomValues(
          new Uint8Array(REQUEST_ID_BYTES)
        );
        const keyBefore = await loadIdentityKeyHex(aci);
        const content: Proto.Content.Params['content'] = {
          zrdtServeRequest: {
            groupId,
            requestId,
            digests:
              mode === 'perDigest'
                ? digests.map(digest => Bytes.fromHex(digest))
                : [],
            since: [],
            catchup: mode === 'catchup',
          },
        };
        serveRequests.add({
          requestId: Bytes.toHex(requestId),
          conversationId,
          responderAci: aci,
          responderKey: keyBefore,
          mode,
          digests: mode === 'perDigest' ? [...digests] : [],
          sentAt: Date.now(),
        });
        await sendControl(aci, content, 'ZrdtServeRequest');
        if (keyBefore === undefined) {
          // First contact: the send fetched the key (TOFU, as Signal).
          const keyAfter = await loadIdentityKeyHex(aci);
          serveRequests.add({
            requestId: Bytes.toHex(requestId),
            conversationId,
            responderAci: aci,
            responderKey: keyAfter,
            mode,
            digests: mode === 'perDigest' ? [...digests] : [],
            sentAt: Date.now(),
          });
        }
      } catch (error) {
        log.warn(
          `ZrdtServeRequest to ${aci} failed`,
          Errors.toLogFormat(error)
        );
      }
    })
  );
}

// --- dispatch from MessageReceiver ------------------------------------------------

// Content 202-204. `senderAci` is the authenticated envelope sender.
export async function handleZrdtControlMessage({
  senderAci,
  content,
}: Readonly<{
  senderAci: string | undefined;
  content: NonNullable<Proto.Content['content']>;
}>): Promise<void> {
  if (!senderAci || !isAciString(senderAci)) {
    log.warn('control message without an ACI sender; dropped');
    return;
  }
  try {
    if ('zrdtServeRequest' in content && content.zrdtServeRequest) {
      // Answer in the background: replies are sends, and must not hold up
      // the receive queue.
      drop(onServeRequest(senderAci, content.zrdtServeRequest));
    } else if ('zrdtServed' in content && content.zrdtServed) {
      await onServed(senderAci, content.zrdtServed);
    } else if ('zrdtNotFound' in content && content.zrdtNotFound) {
      const { groupId, digests } = content.zrdtNotFound;
      const conversation = groupId
        ? window.ConversationController.get(Bytes.toBase64(groupId))
        : undefined;
      if (conversation) {
        log.info(`ZrdtNotFound from ${senderAci}: ${digests.length}`);
        await zrdtResendScheduler.onNotFound(
          conversation.id,
          senderAci,
          digests.map(toHex)
        );
      }
    }
  } catch (error) {
    log.error('control message failed', Errors.toLogFormat(error));
  }
}

// --- responder (JOIN_PLAN §4.3) ---------------------------------------------------

/** The openings this device holds for the given digests (all if undefined). */
export async function loadHeldOpenings(
  conversationId: string,
  digests: ReadonlyArray<string> | undefined
): Promise<Array<ServeHeld>> {
  const wanted =
    digests ??
    (await DataReader.getZrdtRecords(conversationId)).map(row =>
      toHex(row.digest)
    );
  const rows = await DataReader.getMessageIdsByZrdtDigest(
    conversationId,
    wanted
  );
  const held = new Array<ServeHeld>();
  for (const { digest, messageId } of rows) {
    // oxlint-disable-next-line no-await-in-loop
    const message = await getMessageById(messageId);
    const opening = message?.get('zrdtOpening');
    if (opening != null && message?.get('deletedForEveryone') !== true) {
      held.push({
        digest: Bytes.fromHex(digest),
        opening: Bytes.fromBase64(opening),
      });
    }
  }
  return held;
}

/** This device's `live` digests and its disown set (A8 host state). */
export async function loadServeHostState(conversationId: string): Promise<{
  live: Array<Uint8Array<ArrayBuffer>>;
  disown: Array<Uint8Array<ArrayBuffer>>;
}> {
  const ourAci = itemStorage.user.getCheckedAci();
  const [provenance, notOurs] = await Promise.all([
    DataReader.getZrdtProvenance(conversationId),
    zrdtService.disownSet(conversationId),
  ]);
  const live = provenance
    .filter(row => row.kind === 'live')
    .map(row => new Uint8Array(row.digest));
  const disown = [
    ...notOurs.map(digest => new Uint8Array(digest)),
    ...provenance
      .filter(row => row.disownedBy === ourAci)
      .map(row => new Uint8Array(row.digest)),
  ];
  return { live, disown };
}

/** 32-byte values only (digests in a request). */
function digestsOf(
  list: ReadonlyArray<Uint8Array<ArrayBuffer>>
): Array<Uint8Array<ArrayBuffer>> {
  return list
    .filter(d => d.byteLength === DIGEST_BYTES)
    .map(d => new Uint8Array(d));
}

async function onServeRequest(
  requesterAci: AciString,
  request: Proto.ZrdtServeRequest
): Promise<void> {
  try {
    const { groupId, requestId } = request;
    const conversation = groupId
      ? window.ConversationController.get(Bytes.toBase64(groupId))
      : undefined;
    if (!conversation || !groupId || !conversation.areWeAGroupMember()) {
      log.warn('serve request for a group we are not in; ignored');
      return;
    }
    // Host check, defence in depth: a current member in our view.
    if (!conversation.hasMember(requesterAci)) {
      log.warn(`serve request from ${requesterAci}, not a member; ignored`);
      return;
    }
    if (!requestId || requestId.byteLength !== REQUEST_ID_BYTES) {
      log.warn('serve request without a 16-byte request id; ignored');
      return;
    }
    // The identity key we hold for the requester now: SERVE checks its tag,
    // and the reply is sealed to exactly this key.
    const key = await signalProtocolStore.loadIdentityKey(requesterAci);
    if (!key) {
      log.warn(`serve request from ${requesterAci}: no identity key; ignored`);
      return;
    }
    const conversationId = conversation.id;
    const mode: ServeMode = request.catchup ? 'catchup' : 'perDigest';
    const wanted = mode === 'perDigest' ? digestsOf(request.digests) : [];
    log.info(
      `serve request (${mode}) from ${requesterAci}: ${wanted
        .map(d => toHex(d).slice(0, 8))
        .join(',')}`
    );
    const ourAci = itemStorage.user.getCheckedAci();
    const [held, hostState] = await Promise.all([
      loadHeldOpenings(
        conversationId,
        mode === 'perDigest' ? wanted.map(d => toHex(d)) : undefined
      ),
      loadServeHostState(conversationId),
    ]);
    const reply: ServeReply = await zrdtService.serve(conversationId, {
      ownAci: uuidToBytes(ourAci),
      requesterAci: uuidToBytes(requesterAci),
      key,
      requestId: new Uint8Array(requestId),
      since: digestsOf(request.since),
      mode,
      wanted,
      forExport: false,
      strict: conversation.get('zrdtStrict') === true,
      live: hostState.live,
      disown: hostState.disown,
      held,
    });
    await sendZrdtServed({ groupId: new Uint8Array(groupId), reply, key });

    // Wanted digests that got no record (not stored here, or a bare digest):
    // not found here (not decisive; the requester asks the group).
    const bare = new Set(
      reply.entries.flatMap(entry =>
        entry.kind === 'boundary' ? [toHex(entry.digest)] : []
      )
    );
    const notFound = new Array<Uint8Array<ArrayBuffer>>();
    for (const digest of wanted) {
      if (
        bare.has(toHex(digest)) ||
        // oxlint-disable-next-line no-await-in-loop
        !(await zrdtService.has(conversationId, digest))
      ) {
        notFound.push(digest);
      }
    }
    if (notFound.length > 0) {
      await sendControl(
        requesterAci,
        { zrdtNotFound: { groupId, digests: notFound } },
        'ZrdtNotFound'
      );
    }
  } catch (error) {
    log.error('answering serve request failed', Errors.toLogFormat(error));
  }
}

// --- requester (JOIN_PLAN §4.4) ---------------------------------------------------

async function onServed(
  senderAci: AciString,
  served: Proto.ZrdtServed
): Promise<void> {
  const { groupId, header, ephemeralKey, sealed } = served;
  if (
    !groupId ||
    !header ||
    !ephemeralKey ||
    !sealed ||
    header.byteLength !== SERVE_HEADER_BYTES
  ) {
    log.warn('ZrdtServed without its fields; dropped');
    return;
  }
  const parsed = decodeServeHeader(header);
  if (!parsed) {
    return;
  }
  const ourAci = itemStorage.user.getCheckedAci();
  const ourKeys = signalProtocolStore.getIdentityKeyPair(ourAci);
  if (!ourKeys) {
    log.warn('ZrdtServed: no identity key pair of our own; dropped');
    return;
  }
  const conversation = window.ConversationController.get(
    Bytes.toBase64(new Uint8Array(groupId))
  );
  const check = checkServedReply({
    book: serveRequests,
    now: Date.now(),
    headerAci: parsed.requesterAci,
    headerKeyTag: parsed.keyTag,
    headerRequestId: parsed.requestId,
    conversationId: conversation?.id,
    ourAci,
    ourKeyTag: keyTag(ourKeys.publicKey.serialize()),
    senderAci,
    responderKeyNow: await loadIdentityKeyHex(senderAci),
  });
  if (!check.ok) {
    log.warn(`ZrdtServed from ${senderAci} dropped: ${check.reason}`);
    return;
  }
  const entriesBytes = openServeReply({
    group: groupId,
    headerBytes: header,
    ephemeralKey,
    sealed,
    ourPrivateKey: ourKeys.privateKey,
    ourPublicKey: ourKeys.publicKey,
  });
  if (!entriesBytes) {
    log.warn(`ZrdtServed from ${senderAci} does not open under our key`);
    return;
  }
  const entries = decodeServeEntries(entriesBytes);
  if (!entries) {
    log.warn(`ZrdtServed from ${senderAci}: entries do not parse`);
    return;
  }
  serveRequests.complete(check.request.requestId);
  log.info(
    `ZrdtServed from ${senderAci}: ${entries.length} entries ` +
      `(request ${check.request.requestId.slice(0, 8)})`
  );
  for (const entry of entries) {
    if (entry.kind === 'boundary') {
      // Phase 1: a closed store takes no boundary digests (JOIN_PLAN §6.2).
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    await acceptRelayedRecord({
      groupId: new Uint8Array(groupId),
      responderAci: senderAci,
      record: entry.record,
      opening: entry.kind === 'addressed' ? entry.opening : undefined,
      authorCopy: entry.kind === 'addressed' && entry.authorCopy,
    });
  }
}
