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
//
// Catch-up (JOIN_PLAN §6.1, §6.5; decisions in catchUp.std.ts): a device with
// no store for a group it is a member of asks the adder, then two more
// members, for the whole view it was sent (SERVE in catch-up mode). The first
// reply decides the store: relative if it carries a boundary digest, closed
// otherwise. A store something else opened before that reply (a send, a live
// record) is relative until then, and closed again by a reply without a
// boundary digest (settleCatchUpStore). Every reply goes through
// ACCEPT_VIEW (receive.preload.ts, takeServedReply).

import { ContentHint } from '@signalapp/libsignal-client';

import * as Bytes from '../Bytes.std.ts';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import type { SignalService as Proto } from '../protobuf/index.std.ts';
import { DataReader, DataWriter } from '../sql/Client.preload.ts';
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
import type {
  ServeEntry,
  ServeHeld,
  ServeMode,
  ServeReply,
} from './ZrdtBackend.std.ts';
import { decodeServeEntries } from './backends/codec.std.ts';
import { ServeRequestBook, checkServedReply } from './serveRequests.std.ts';
import { isZrdtStrict, serveRequestFor } from './serveArgs.std.ts';
import { decodeServeHeader, keyTag, openServeReply } from './seal.node.ts';
import { sendZrdtServed } from './served.preload.ts';
import { zrdtEvents, zrdtService } from './service.preload.ts';
import { setGapState, takeServedReply, toHex } from './receive.preload.ts';
import type { ZrdtBytes, ZrdtServedEntrySummary } from './receive.preload.ts';
import { setZrdtGroupUpdateHook } from './groupHook.std.ts';
import type { ZrdtGroupUpdateType } from './groupHook.std.ts';
import {
  CATCH_UP_TIMEOUT_MS,
  catchUpSince,
  catchUpStoreMode,
  catchUpStoreStep,
  catchUpTargets,
  joinRemovedSince,
  needsCatchUp,
} from './catchUp.std.ts';

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
  mode: ServeMode = 'perDigest',
  since: ReadonlyArray<string> = []
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
            since: since.map(digest => Bytes.fromHex(digest)),
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
    // The group's strict setting and our own `since` for this account
    // (JOIN_PLAN §5, §6.5) come from the conversation (serveArgs.std.ts).
    const reply: ServeReply = await zrdtService.serve(
      conversationId,
      serveRequestFor({
        conversation: conversation.attributes,
        ownAci: uuidToBytes(ourAci),
        requesterAci,
        requesterAciBytes: uuidToBytes(requesterAci),
        key,
        requestId: new Uint8Array(requestId),
        since: digestsOf(request.since),
        mode,
        wanted,
        live: hostState.live,
        disown: hostState.disown,
        held,
      })
    );
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

/**
 * Strict mode for a group (JOIN_PLAN §5, user decision 3: off by default,
 * opt-in per group): this device's SERVE replies then carry content only in
 * author copies. Saved on the conversation; read by every later reply.
 */
export async function setZrdtStrict(
  conversationId: string,
  strict: boolean
): Promise<boolean> {
  const conversation = window.ConversationController.get(conversationId);
  if (!conversation) {
    throw new Error(`setZrdtStrict: no conversation ${conversationId}`);
  }
  conversation.set({ zrdtStrict: strict ? true : undefined });
  await DataWriter.updateConversation(conversation.attributes);
  log.info(
    `strict mode ${strict ? 'on' : 'off'} for ${conversation.idForLogging()}`
  );
  return isZrdtStrict(conversation.attributes);
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
  const { request } = check;
  log.info(
    `ZrdtServed from ${senderAci}: ${entries.length} entries ` +
      `(${request.mode}, request ${request.requestId.slice(0, 8)})`
  );
  const isCatchUp = request.mode === 'catchup';
  if (isCatchUp) {
    const state = catchUps.get(request.conversationId);
    if (state && state.answeredBy === undefined) {
      state.answeredBy = senderAci;
    }
    const target = window.ConversationController.get(request.conversationId);
    if (target && target.areWeAGroupMember() && target.hasMember(senderAci)) {
      await settleCatchUpStore(
        target,
        new Uint8Array(groupId),
        entries.map(entry => entry.kind)
      );
    }
  }
  const summary = await takeServedReply({
    conversationId: request.conversationId,
    groupId: new Uint8Array(groupId),
    responderAci: senderAci,
    entries,
    catchUp: isCatchUp,
  });
  noteServed({
    conversationId: request.conversationId,
    responderAci: senderAci,
    requestId: request.requestId,
    mode: request.mode,
    wanted: request.digests,
    entries: summary,
  });
  if (isCatchUp) {
    const state = catchUps.get(request.conversationId);
    if (state) {
      state.replies += 1;
    }
  }
}

// --- the served log, for the CI hooks -----------------------------------------------

/** One reply this device took (entries summarised: kinds and digests, no content). */
export type ZrdtServedLogItem = Readonly<{
  conversationId: string;
  responderAci: string;
  requestId: string;
  mode: ServeMode;
  wanted: ReadonlyArray<string>;
  entries: ReadonlyArray<ZrdtServedEntrySummary>;
  at: number;
}>;

const servedLog = new Array<ZrdtServedLogItem>();
const SERVED_LOG_MAX = 200;

function noteServed(item: Omit<ZrdtServedLogItem, 'at'>): void {
  servedLog.push({ ...item, at: Date.now() });
  if (servedLog.length > SERVED_LOG_MAX) {
    servedLog.splice(0, servedLog.length - SERVED_LOG_MAX);
  }
}

/** The replies this device took for a conversation, oldest first. */
export function getServedLog(conversationId: string): Array<ZrdtServedLogItem> {
  return servedLog.filter(item => item.conversationId === conversationId);
}

/**
 * Asks one member for the given digests (a per-digest SERVE request), now and
 * without the gap scheduler: the CI hooks use it to show that a pre-join
 * digest comes back as a boundary digest only.
 */
export async function requestDigestsFrom(
  conversationId: string,
  responderAci: string,
  digests: ReadonlyArray<string>
): Promise<void> {
  await sendServeRequest(
    conversationId,
    { kind: 'direct', aci: responderAci },
    digests,
    'perDigest'
  );
}

// --- catch-up (JOIN_PLAN §6.1, §6.5) ------------------------------------------------

type CatchUpState = {
  reason: string;
  startedAt: number;
  since: ReadonlyArray<string>;
  asked: Array<string>;
  // Authors of live records asked while no reply had come (once each).
  askedLive: Array<string>;
  answeredBy?: string;
  replies: number;
};

const catchUps = new Map<string, CatchUpState>();

/** The catch-up of a conversation, for the CI hooks and logs. */
export function getCatchUpState(
  conversationId: string
): Readonly<CatchUpState> | undefined {
  const state = catchUps.get(conversationId);
  return state
    ? { ...state, asked: [...state.asked], askedLive: [...state.askedLive] }
    : undefined;
}

function catchUpTimeoutMs(): number {
  const raw = Number(process.env.ZRDT_CATCHUP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : CATCH_UP_TIMEOUT_MS;
}

async function setCatchUpWait(
  conversation: ConversationModel,
  wait: { since: ReadonlyArray<string>; reAdd: boolean } | undefined
): Promise<void> {
  conversation.set({ zrdtCatchUp: wait });
  await DataWriter.updateConversation(conversation.attributes);
}

async function askForCatchUp(
  conversationId: string,
  state: CatchUpState,
  aci: string
): Promise<void> {
  state.asked.push(aci);
  await sendServeRequest(
    conversationId,
    { kind: 'direct', aci },
    [],
    'catchup',
    state.since
  );
}

/**
 * Starts a catch-up for `conversation` (once per conversation and run): a
 * catch-up request to the adder (or the first other member), and after a
 * timeout to two more members if nobody answered. `since` is the old store's
 * heads ∪ pending ∪ missing on a re-add, empty otherwise. With `relative`
 * (a re-add) a relative store is opened now; otherwise the first reply
 * decides the store (settleCatchUpStore), and until it comes a store opened
 * for the conversation is relative (serviceCore #ensure).
 */
export async function startCatchUp(
  conversation: ConversationModel,
  {
    reason,
    since = [],
    relative = false,
  }: Readonly<{
    reason: string;
    since?: ReadonlyArray<string>;
    relative?: boolean;
  }>
): Promise<void> {
  const conversationId = conversation.id;
  if (catchUps.has(conversationId)) {
    return;
  }
  const groupId = getGroupIdBytes(conversation);
  if (!groupId || !conversation.areWeAGroupMember()) {
    return;
  }
  const state: CatchUpState = {
    reason,
    startedAt: Date.now(),
    since: [...since],
    asked: [],
    askedLive: [],
    replies: 0,
  };
  catchUps.set(conversationId, state);
  // The wait is set before anything awaits, so a send or a live record that
  // comes right after already opens a relative store; it is kept on the
  // conversation, so a restart asks again.
  const wait = conversation.get('zrdtCatchUp');
  const persisted = setCatchUpWait(conversation, {
    since: state.since,
    reAdd: relative || wait?.reAdd === true,
  });
  try {
    await persisted;
    await zrdtService.init();
    if (!zrdtService.backendInfo().available) {
      catchUps.delete(conversationId);
      return;
    }
    let mode = 'no';
    if (relative) {
      mode = await zrdtService.startRelative(conversationId, groupId);
    } else if (await zrdtService.hasStore(conversationId)) {
      mode = (await zrdtService.isRelative(conversationId))
        ? 'relative'
        : 'closed';
    }
    const ourAci = itemStorage.user.getCheckedAci();
    const members = (conversation.get('membersV2') ?? []).map(m => m.aci);
    const targets = catchUpTargets({
      ourAci,
      adderAci: conversation.get('addedBy'),
      members,
    });
    log.info(
      `catch-up for ${conversation.idForLogging()} (${reason}; ${mode} store, ` +
        `since ${state.since.length}): asking ${targets.first ?? 'nobody'}, ` +
        `then ${targets.more.join(', ') || 'nobody'}`
    );
    if (!targets.first) {
      // A group of one: nobody to ask, and nothing to catch up on.
      await setCatchUpWait(conversation, undefined);
      return;
    }
    await askForCatchUp(conversationId, state, targets.first);
    setTimeout(() => {
      if (state.answeredBy !== undefined) {
        return;
      }
      log.info(
        `catch-up for ${conversation.idForLogging()}: no answer; asking ${
          targets.more.join(', ') || 'nobody'
        }`
      );
      drop(
        Promise.all(
          targets.more.map(aci => askForCatchUp(conversationId, state, aci))
        )
      );
    }, catchUpTimeoutMs());
  } catch (error) {
    log.error('catch-up failed to start', Errors.toLogFormat(error));
  }
}

/**
 * A live record from `authorAci` came while our catch-up waits for its first
 * reply. The author holds a store now, though it may have had none when it
 * was asked (in a new group nobody has one when the catch-ups start), so it
 * is asked too, once per catch-up.
 */
export function askLiveAuthorForCatchUp(
  conversationId: string,
  authorAci: string
): void {
  const state = catchUps.get(conversationId);
  if (
    !state ||
    state.answeredBy !== undefined ||
    state.askedLive.includes(authorAci) ||
    authorAci === itemStorage.user.getAci()
  ) {
    return;
  }
  state.askedLive.push(authorAci);
  log.info(
    `catch-up for ${conversationId}: no reply yet; asking ${authorAci}, ` +
      'who wrote live'
  );
  drop(askForCatchUp(conversationId, state, authorAci));
}

/**
 * Before a catch-up reply (or an export for this account, JOIN_PLAN §4.5) is
 * taken: the first one decides the store (§6.1, catchUpStoreStep). Without
 * a store it opens one, relative if the entries carry a boundary digest. A
 * store opened while the catch-up waited (relative: a send or a live record
 * came first) is closed again if they carry none, so a member from the
 * start (a founder's or an old member's new device) does not stay relative,
 * and a newcomer who wrote first keeps his relative store. Then the
 * catch-up no longer waits. A closed store never becomes relative.
 */
export async function settleCatchUpStore(
  conversation: ConversationModel,
  groupId: Uint8Array<ArrayBuffer>,
  entryKinds: ReadonlyArray<ServeEntry['kind']>
): Promise<void> {
  const conversationId = conversation.id;
  const wait = conversation.get('zrdtCatchUp');
  let store: 'none' | 'closed' | 'relative' = 'none';
  if (await zrdtService.hasStore(conversationId)) {
    store = (await zrdtService.isRelative(conversationId))
      ? 'relative'
      : 'closed';
  }
  const reply = catchUpStoreMode(entryKinds);
  const step = catchUpStoreStep({
    store,
    provisional: wait != null && !wait.reAdd,
    reply,
  });
  if (step === 'newRelative') {
    await zrdtService.startRelative(conversationId, groupId);
  }
  if (wait != null) {
    await setCatchUpWait(conversation, undefined);
  }
  if (step === 'newClosed' || step === 'close') {
    // A store opened meanwhile (the wait still held) is relative: close it.
    await zrdtService.ensureConversation(conversationId, groupId);
    if (await zrdtService.isRelative(conversationId)) {
      await zrdtService.closeRelative(conversationId);
    }
  }
  if (step !== 'keep' || wait != null) {
    log.info(
      `catch-up for ${conversation.idForLogging()}: first reply (${reply}); ` +
        `store ${store}: ${step}; ${
          (await zrdtService.isRelative(conversationId)) ? 'relative' : 'closed'
        } now`
    );
  }
}

/**
 * After the app started: catch up every group this device is a member of and
 * has no store for (JOIN_PLAN §6.1; no join revision is read).
 */
export async function zrdtCatchUpAtStartup(): Promise<void> {
  try {
    await zrdtService.init();
    const ourAci = itemStorage.user.getAci();
    if (!ourAci) {
      return;
    }
    for (const conversation of window.ConversationController.getAll()) {
      // A catch-up that waited for its first reply when the app stopped is
      // asked again, with its `since`.
      const wait = conversation.get('zrdtCatchUp');
      if (
        conversation.get('groupVersion') === 2 &&
        needsCatchUp({
          isMember: conversation.areWeAGroupMember(),
          // oxlint-disable-next-line no-await-in-loop
          hasStore: await zrdtService.hasStore(conversation.id),
          waiting: wait != null,
        })
      ) {
        // oxlint-disable-next-line no-await-in-loop
        await startCatchUp(conversation, {
          reason: wait ? 'startup, no reply before' : 'startup',
          since: wait?.since,
          relative: wait?.reAdd,
        });
      }
    }
  } catch (error) {
    log.error('catch-up at startup failed', Errors.toLogFormat(error));
  }
}

/**
 * After a group update was applied (groups.preload.ts, maybeUpdateGroup):
 * - members it removed: if the change came in a Signal message from the
 *   remover, record our heads for each as our own `since` for that account
 *   (JOIN_PLAN §6.5);
 * - a re-add of ours: `since` = the old store's heads ∪ pending ∪ missing,
 *   the old store is archived, and a catch-up starts into a new one;
 * - no store (a member whose device has none), or a catch-up still waiting
 *   for its first reply: a catch-up starts.
 */
async function zrdtAfterGroupUpdate({
  conversation,
  previousMemberAcis,
  wasMember,
  viaSignalMessage,
}: ZrdtGroupUpdateType): Promise<void> {
  try {
    if (conversation.get('groupVersion') !== 2) {
      return;
    }
    const ourAci = itemStorage.user.getAci();
    if (!ourAci) {
      return;
    }
    await zrdtService.init();
    if (!zrdtService.backendInfo().available) {
      return;
    }
    const conversationId = conversation.id;
    const current = new Set(
      (conversation.get('membersV2') ?? []).map(m => m.aci as string)
    );
    const hasStore = await zrdtService.hasStore(conversationId);
    const removed = previousMemberAcis.filter(
      aci => aci !== ourAci && !current.has(aci)
    );
    if (viaSignalMessage && removed.length > 0 && hasStore) {
      const heads = (await zrdtService.heads(conversationId)).map(d =>
        toHex(d)
      );
      const before = conversation.get('zrdtRemovedSince') ?? {};
      const next: Record<string, ReadonlyArray<string>> = { ...before };
      for (const aci of removed) {
        next[aci] = joinRemovedSince(before[aci], heads);
      }
      conversation.set({ zrdtRemovedSince: next });
      await DataWriter.updateConversation(conversation.attributes);
      log.info(
        `recorded our since (${heads.length} heads) for ${removed.length} ` +
          `removed member(s) of ${conversation.idForLogging()}`
      );
    }
    if (!conversation.areWeAGroupMember()) {
      return;
    }
    // A re-add: we were not in a member list we knew, and we are now.
    if (!wasMember && previousMemberAcis.length > 0 && hasStore) {
      const since = await sinceOfStore(conversationId);
      log.info(
        `re-added to ${conversation.idForLogging()}: archiving the old store ` +
          `(since ${since.length})`
      );
      await zrdtService.archive(conversationId);
      catchUps.delete(conversationId);
      await startCatchUp(conversation, {
        reason: 're-add',
        since,
        relative: true,
      });
      return;
    }
    const wait = conversation.get('zrdtCatchUp');
    if (needsCatchUp({ isMember: true, hasStore, waiting: wait != null })) {
      await startCatchUp(conversation, {
        reason: 'no store',
        since: wait?.since,
        relative: wait?.reAdd,
      });
    }
  } catch (error) {
    log.error('zrdtAfterGroupUpdate failed', Errors.toLogFormat(error));
  }
}

setZrdtGroupUpdateHook(zrdtAfterGroupUpdate);

/** The old store's heads ∪ its pending digests ∪ the digests missing in gap rows. */
async function sinceOfStore(conversationId: string): Promise<Array<string>> {
  const [heads, pending, gapIds] = await Promise.all([
    zrdtService.heads(conversationId),
    DataReader.getZrdtPending(conversationId),
    DataReader.getZrdtGapMessageIds(conversationId),
  ]);
  const missing = new Array<string>();
  for (const id of gapIds) {
    // oxlint-disable-next-line no-await-in-loop
    const row = await getMessageById(id);
    missing.push(...(row?.get('zrdtGap')?.missingDigests ?? []));
  }
  return catchUpSince({
    oldHeads: heads.map(d => toHex(d)),
    pending: pending.map(row => toHex(row.digest)),
    missing,
  });
}
