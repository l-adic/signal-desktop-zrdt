// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// zrdt: the send path, "freeze once" (zrdt docs/APP.md §4, AMENDMENTS A7).
//
// Called from sendNormalMessage inside the group's conversation.queueJob,
// after attachments are uploaded, for messages in scope (./scope.std.ts):
//
//   1. If message.zrdt exists (a retry), send its frozen Content bytes. Never
//      recompute links. If the store lacks the record (a crash before ACCEPT
//      finished, or a lost row), re-accept it from the frozen bytes first.
//   2. links = HEADS, nonce = 32 random bytes, disown = our disown set, and
//      the audience (JOIN_PLAN §3.2, §4.1): the enqueue snapshot's members
//      still in membersV2, plus us; seated (a key tag) only the enqueue
//      recipients we hold a key for. AUDIENCE gives the field-201 bytes.
//   3. Build the Content with DataMessage.zrdt = ZrdtMeta{links, nonce,
//      version, disown} and DataMessage.zrdtAudience, and encode it.
//   4. Persist message.zrdt = {links, nonce, contentBytes, digest: ''} FIRST.
//   5. COMMIT + ACCEPT (zrdtService.acceptOwn; it writes the store rows).
//   6. Persist digest, zrdtOpening, zrdtDigest and zrdtProvenance (live).
//   7. Send the frozen bytes, on this attempt and every later one.
//
// `message.zrdt.digest === ''` means "frozen, not yet accepted": the next
// attempt re-accepts the same bytes (ACCEPT is idempotent and the record is a
// function of the frozen bytes, so the digest does not change).
//
// Encodings (ts/types/Zrdt.std.ts): digests, links and nonce are lowercase
// hex; contentBytes and zrdtOpening are base64.

import { SignalService as Proto } from '../protobuf/index.std.ts';
import * as Bytes from '../Bytes.std.ts';
import { strictAssert } from '../util/assert.std.ts';
import * as Errors from '../types/errors.std.ts';
import { createLogger } from '../logging/log.std.ts';
import type { LoggerType } from '../types/Logging.std.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import type { ZrdtSendAttributesType } from '../types/Zrdt.std.ts';
import type {
  GroupMessageOptionsType,
  ZrdtMetaSendType,
} from '../textsecure/SendMessage.preload.ts';
import {
  ACI_BYTES,
  GROUP_ID_BYTES,
  IDENTITY_KEY_BYTES,
  NONCE_BYTES,
} from './ZrdtBackend.std.ts';
import type { AudienceMember } from './ZrdtBackend.std.ts';
import { getZrdtOutOfScopeReason, isZrdtRecordMessage } from './scope.std.ts';
import {
  aciHex,
  aciStringHex,
  audienceAcis,
  audienceOfDataMessage,
} from './audience.std.ts';
import { planAudience, snapshotFromSendState } from './audiencePlan.std.ts';
import type { AudienceSnapshot } from './audiencePlan.std.ts';
import { signalProtocolStore } from '../SignalProtocolStore.preload.ts';
import { getKeysForServiceId } from '../textsecure/getKeysForServiceId.preload.ts';
import {
  getKeysForServiceId as doGetKeysForServiceId,
  getKeysForServiceIdUnauth,
} from '../textsecure/WebAPI.preload.ts';
import { UnregisteredUserError } from '../textsecure/Errors.std.ts';
import { getSendOptions } from '../util/getSendOptions.preload.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { isAciString } from '../util/isAciString.std.ts';
import { zrdtService } from './service.preload.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import type { MessageModel } from '../models/messages.preload.ts';
import type { MessageSender } from '../textsecure/SendMessage.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { DataReader } from '../sql/Client.preload.ts';
import { uuidToBytes } from '../util/uuidToBytes.std.ts';
import { getMessageIdForLogging } from '../util/idForLogging.preload.ts';

const defaultLog = createLogger('zrdt/send');

/** ZrdtMeta.version this client writes (protocol 3, JOIN_PLAN §3.3). */
export const ZRDT_META_VERSION = 3;

// Outgoing messages scanned per conversation by reacceptUnstoredOutgoing.
// TODO(zrdt): a dedicated indexed query (outgoing messages with $.zrdt) instead
// of the last N messages.
const REACCEPT_SCAN_LIMIT = 500;

// Bytes from the service; copied into ArrayBuffer-backed arrays before use.
type AnyBytes = ArrayLike<number>;
type ArrayBytes = Uint8Array<ArrayBuffer>;

/** The part of ZrdtServiceType (./service.preload.ts) the send path uses. */
export type ZrdtSendServiceType = Readonly<{
  ensureConversation: (
    conversationId: string,
    groupId: ArrayBytes
  ) => Promise<void>;
  heads: (conversationId: string) => Promise<ReadonlyArray<AnyBytes>>;
  disownSet: (conversationId: string) => Promise<ReadonlyArray<AnyBytes>>;
  has: (conversationId: string, digest: ArrayBytes) => Promise<boolean>;
  acceptOwn: (
    conversationId: string,
    a: {
      groupId: ArrayBytes;
      authorAci: ArrayBytes;
      nonce: ArrayBytes;
      dataMessageBytes: ArrayBytes;
      links: Array<ArrayBytes>;
    }
  ) => Promise<{ digest: AnyBytes; record: AnyBytes; opening: AnyBytes }>;
  audience: (
    members: ReadonlyArray<AudienceMember>
  ) => Promise<ArrayBytes | 'tooLarge'>;
}>;

export type ZrdtMessageUpdateType = Partial<
  Pick<
    MessageAttributesType,
    'zrdt' | 'zrdtOpening' | 'zrdtDigest' | 'zrdtProvenance'
  >
>;

/** The outgoing message being frozen; adapts a MessageModel. */
export type ZrdtFreezableMessageType = Readonly<{
  idForLogging: string;
  getZrdt: () => ZrdtSendAttributesType | undefined;
  /** Sets the attributes and saves the message; resolves once it is saved. */
  update: (attributes: ZrdtMessageUpdateType) => Promise<void>;
}>;

export type FreezeZrdtSendOptionsType = Readonly<{
  conversationId: string;
  /** The group's 32-byte id. */
  groupId: ArrayBytes;
  /** Our 16-byte ACI: the record's author. */
  ourAci: ArrayBytes;
  message: ZrdtFreezableMessageType;
  /** Builds this send's Content with DataMessage.zrdt set (Message.toProto). */
  buildContent: (zrdt: ZrdtMetaSendType) => Promise<Proto.Content.Params>;
  /**
   * The members for AUDIENCE (JOIN_PLAN §4.1), read at freeze. Throws on a
   * transient key-fetch failure: no freeze, the job retries.
   */
  getAudienceMembers: () => Promise<ReadonlyArray<AudienceMember>>;
  service?: ZrdtSendServiceType;
  getRandomBytes?: (size: number) => ArrayBytes;
  log?: LoggerType;
}>;

function toArrayBytes(value: AnyBytes): ArrayBytes {
  return new Uint8Array(value);
}

function defaultGetRandomBytes(size: number): ArrayBytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

/** Content bytes → the DataMessage it carries, and that DataMessage's bytes. */
export function getFrozenDataMessage(contentBytes: ArrayBytes): {
  content: Proto.Content;
  dataMessage: Proto.DataMessage;
  dataMessageBytes: ArrayBytes;
} {
  const content = Proto.Content.decode(contentBytes);
  const dataMessage = content.content?.dataMessage;
  strictAssert(dataMessage, 'zrdt: frozen Content has no dataMessage');
  return {
    content,
    dataMessage,
    dataMessageBytes: Proto.DataMessage.encode(dataMessage),
  };
}

function getAcceptOwnArgs(
  frozen: ZrdtSendAttributesType,
  groupId: ArrayBytes,
  ourAci: ArrayBytes
): Parameters<ZrdtSendServiceType['acceptOwn']>[1] {
  const { dataMessageBytes } = getFrozenDataMessage(
    Bytes.fromBase64(frozen.contentBytes)
  );
  return {
    groupId,
    authorAci: ourAci,
    nonce: Bytes.fromHex(frozen.nonce),
    dataMessageBytes,
    links: frozen.links.map(link => Bytes.fromHex(link)),
  };
}

// ACCEPT the frozen record and save the digest and opening on the message.
async function acceptFrozen({
  conversationId,
  groupId,
  ourAci,
  message,
  frozen,
  service,
  log,
}: Readonly<{
  conversationId: string;
  groupId: ArrayBytes;
  ourAci: ArrayBytes;
  message: ZrdtFreezableMessageType;
  frozen: ZrdtSendAttributesType;
  service: ZrdtSendServiceType;
  log: LoggerType;
}>): Promise<ZrdtSendAttributesType> {
  // Throws unless ACCEPTED. Our own links always resolve, unless the store
  // was salvaged in between; then this attempt fails (fail closed).
  const accepted = await service.acceptOwn(
    conversationId,
    getAcceptOwnArgs(frozen, groupId, ourAci)
  );
  const digest = Bytes.toHex(toArrayBytes(accepted.digest));
  if (frozen.digest !== '' && frozen.digest !== digest) {
    // Cannot happen: the record is a function of the frozen bytes.
    log.error(
      `zrdt: ${message.idForLogging} re-accept gave digest ${digest}, ` +
        `frozen ${frozen.digest}; keeping the new one`
    );
  }
  const updated: ZrdtSendAttributesType = { ...frozen, digest };
  await message.update({
    zrdt: updated,
    zrdtOpening: Bytes.toBase64(toArrayBytes(accepted.opening)),
    zrdtDigest: digest,
    zrdtProvenance: { kind: 'live' },
  });
  return updated;
}

/**
 * Freeze once: returns the Content to send for this attempt. The first
 * attempt builds, accepts and persists it; every later attempt returns the
 * same bytes. Throws if zrdt cannot accept the record (the attempt fails and
 * the job retries; a group record never goes out unlinked).
 */
export async function freezeZrdtSend(
  options: FreezeZrdtSendOptionsType
): Promise<Proto.Content.Params> {
  const {
    conversationId,
    groupId,
    ourAci,
    message,
    buildContent,
    getAudienceMembers,
    service = zrdtService,
    getRandomBytes = defaultGetRandomBytes,
    log = defaultLog,
  } = options;
  strictAssert(groupId.byteLength === GROUP_ID_BYTES, 'zrdt: bad group id');
  strictAssert(ourAci.byteLength === ACI_BYTES, 'zrdt: bad ACI');
  const logId = `zrdt/freeze(${message.idForLogging})`;

  const existing = message.getZrdt();
  if (existing) {
    const contentBytes = Bytes.fromBase64(existing.contentBytes);
    const { content } = getFrozenDataMessage(contentBytes);
    if (!Bytes.areEqual(Proto.Content.encode(content), contentBytes)) {
      log.error(`${logId}: frozen Content does not re-encode byte for byte`);
    }
    const isStored =
      existing.digest !== '' &&
      (await service.has(conversationId, Bytes.fromHex(existing.digest)));
    if (!isStored) {
      log.warn(
        `${logId}: frozen record not in the store ` +
          `(digest '${existing.digest}'); re-accepting the frozen bytes`
      );
      await acceptFrozen({
        conversationId,
        groupId,
        ourAci,
        message,
        frozen: existing,
        service,
        log,
      });
    }
    log.info(`${logId}: sending the frozen bytes`);
    return content;
  }

  const links = (await service.heads(conversationId)).map(toArrayBytes);
  const nonce = getRandomBytes(NONCE_BYTES);
  strictAssert(nonce.byteLength === NONCE_BYTES, 'zrdt: bad nonce');
  const disown = (await service.disownSet(conversationId)).map(toArrayBytes);
  const audience = await service.audience(await getAudienceMembers());
  if (audience === 'tooLarge') {
    throw new Error('zrdt: more than 256 audience members');
  }

  const built = await buildContent({
    links,
    nonce,
    version: ZRDT_META_VERSION,
    disown,
    audience,
  });
  // Freeze the canonical encoding: what decode → encode gives, because every
  // attempt (and the sendLog, and the sync transcript) re-encodes the decoded
  // Content.
  const firstBytes = Proto.Content.encode(built);
  const { content, dataMessage } = getFrozenDataMessage(firstBytes);
  const contentBytes = Proto.Content.encode(content);
  if (!Bytes.areEqual(contentBytes, firstBytes)) {
    log.warn(`${logId}: Content changed on decode → encode; froze the second`);
  }
  strictAssert(dataMessage.zrdt, 'zrdt: built DataMessage has no zrdt');
  strictAssert(
    dataMessage.zrdtAudience != null &&
      Bytes.areEqual(dataMessage.zrdtAudience, audience),
    'zrdt: built DataMessage does not carry the audience'
  );
  // Receivers apply the same predicate to the DataMessage they decrypt; a
  // mismatch here means they would ignore ZrdtMeta and later messages that
  // link this one would show gaps.
  const outOfScope = getZrdtOutOfScopeReason({
    isGroupV2: true,
    isEdit: false,
    dataMessage,
  });
  if (outOfScope !== undefined) {
    log.error(`${logId}: built DataMessage is out of scope (${outOfScope})`);
  }

  const frozen: ZrdtSendAttributesType = {
    links: links.map(link => Bytes.toHex(link)),
    nonce: Bytes.toHex(nonce),
    digest: '',
    contentBytes: Bytes.toBase64(contentBytes),
  };
  // Persist first, accept second (APP.md §4 step 6).
  await message.update({ zrdt: frozen });
  const accepted = await acceptFrozen({
    conversationId,
    groupId,
    ourAci,
    message,
    frozen,
    service,
    log,
  });
  log.info(
    `${logId}: froze record ${accepted.digest.slice(0, 8)} ` +
      `with ${links.length} links, ${disown.length} disowned`
  );
  return Proto.Content.decode(contentBytes);
}

/** The send-side scope check for a group send from the NormalMessage job. */
export function isZrdtGroupSend({
  isGroupV2,
  editedMessageTimestamp,
  groupSendOptions,
}: Readonly<{
  isGroupV2: boolean;
  editedMessageTimestamp: number | undefined;
  groupSendOptions: GroupMessageOptionsType;
}>): boolean {
  return isZrdtRecordMessage({
    isGroupV2,
    isEdit:
      Boolean(editedMessageTimestamp) ||
      groupSendOptions.targetTimestampForEdit != null,
    dataMessage: {
      ...groupSendOptions,
      delete: groupSendOptions.deleteForEveryone,
    },
  });
}

// --- Startup re-accept (APP.md §4 step 8) ----------------------------------------

export type ZrdtOutgoingMessageType = Readonly<
  Pick<MessageAttributesType, 'id' | 'type' | 'zrdt'>
>;

/**
 * Re-accepts our sent records that the store lacks (lost rows, a store
 * rebuilt from fewer rows). Messages still frozen with digest '' are left to
 * their send job. One of our records can link another we lost, so this runs
 * passes until one re-accepts nothing (any message order works). Returns the
 * number re-accepted. Never throws.
 */
export async function reacceptOutgoingMessages({
  conversationId,
  groupId,
  ourAci,
  messages,
  service = zrdtService,
  log = defaultLog,
}: Readonly<{
  conversationId: string;
  groupId: ArrayBytes;
  ourAci: ArrayBytes;
  messages: ReadonlyArray<ZrdtOutgoingMessageType>;
  service?: ZrdtSendServiceType;
  log?: LoggerType;
}>): Promise<number> {
  let count = 0;
  let todo = messages.filter(
    message =>
      message.type === 'outgoing' &&
      message.zrdt != null &&
      message.zrdt.digest !== ''
  );
  const failures = new Map<string, unknown>();
  while (todo.length > 0) {
    const retry = new Array<ZrdtOutgoingMessageType>();
    let progress = false;
    for (const message of todo) {
      const { zrdt } = message;
      if (!zrdt) {
        continue;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop
        if (await service.has(conversationId, Bytes.fromHex(zrdt.digest))) {
          failures.delete(message.id);
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        const accepted = await service.acceptOwn(
          conversationId,
          getAcceptOwnArgs(zrdt, groupId, ourAci)
        );
        const digest = Bytes.toHex(toArrayBytes(accepted.digest));
        if (digest !== zrdt.digest) {
          log.error(
            `zrdt/reaccept: message ${message.id} gave ${digest}, ` +
              `expected ${zrdt.digest}`
          );
        }
        failures.delete(message.id);
        count += 1;
        progress = true;
      } catch (error) {
        // Maybe it links one of ours later in the list: try again next pass.
        failures.set(message.id, error);
        retry.push(message);
      }
    }
    todo = progress ? retry : [];
  }
  for (const [id, error] of failures) {
    // TODO(zrdt): a record whose links we lack for good (someone else's
    // record lost too) could go to zrdt_pending instead.
    log.error(`zrdt/reaccept: message ${id} failed`, Errors.toLogFormat(error));
  }
  if (count > 0) {
    log.info(`zrdt/reaccept(${conversationId}): re-accepted ${count}`);
  }
  return count;
}

// --- Glue for sendNormalMessage ---------------------------------------------------

function getGroupIdBytes(conversation: ConversationModel): ArrayBytes {
  const groupId = conversation.get('groupId');
  strictAssert(groupId, 'zrdt: GroupV2 conversation without groupId');
  return Bytes.fromBase64(groupId);
}

function getOurAciBytes(): ArrayBytes {
  return uuidToBytes(itemStorage.user.getCheckedAci());
}

// Conversations whose sent records were re-checked (or are being re-checked)
// this session.
const reacceptedConversations = new Map<string, Promise<void>>();

/**
 * APP.md §4 step 8: re-accept our sent messages whose digest is missing from
 * the store. Runs once per conversation per session: at startup for every
 * conversation with zrdt rows (reacceptZrdtOutgoingAtStartup), else before
 * the first zrdt send in that conversation; a send waits for a re-check
 * that is still running. A failed re-check runs again on the next send.
 * Never throws.
 */
function reacceptOutgoingForConversation(
  conversation: ConversationModel,
  log: LoggerType = defaultLog
): Promise<void> {
  const running = reacceptedConversations.get(conversation.id);
  if (running) {
    return running;
  }
  const promise = reacceptOutgoingOnce(conversation, log);
  reacceptedConversations.set(conversation.id, promise);
  return promise;
}

async function reacceptOutgoingOnce(
  conversation: ConversationModel,
  log: LoggerType
): Promise<void> {
  try {
    const groupId = getGroupIdBytes(conversation);
    await zrdtService.ensureConversation(conversation.id, groupId);
    const messages = await DataReader.getOlderMessagesByConversation({
      conversationId: conversation.id,
      includeStoryReplies: false,
      limit: REACCEPT_SCAN_LIMIT,
      storyId: undefined,
    });
    await reacceptOutgoingMessages({
      conversationId: conversation.id,
      groupId,
      ourAci: getOurAciBytes(),
      messages,
      log,
    });
  } catch (error) {
    reacceptedConversations.delete(conversation.id);
    log.error(
      `zrdt/reaccept(${conversation.idForLogging()}) failed`,
      Errors.toLogFormat(error)
    );
  }
}

/**
 * APP.md §4 step 8, at startup: after zrdtService.init() re-OPENed every
 * conversation from its rows, re-accept our sent messages the store lacks,
 * in every group conversation that has zrdt rows. Conversations without any
 * rows are re-checked lazily before their first send. Never throws.
 */
export async function reacceptZrdtOutgoingAtStartup(
  log: LoggerType = defaultLog
): Promise<void> {
  try {
    await zrdtService.init();
    if (!zrdtService.backendInfo().available) {
      log.warn('zrdt/reaccept: backend unavailable; skipped at startup');
      return;
    }
    if (itemStorage.user.getAci() == null) {
      return;
    }
    const ids = await DataReader.getZrdtConversationIds();
    for (const id of ids) {
      const conversation = window.ConversationController.get(id);
      if (!conversation?.get('groupId') || !conversation.areWeAGroupMember()) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await reacceptOutgoingForConversation(conversation, log);
    }
  } catch (error) {
    log.error('zrdt/reaccept at startup failed', Errors.toLogFormat(error));
  }
}

/** The ACIs (hex) listed in a frozen send's field 201. */
function getFrozenAudienceAcis(contentBytes: ArrayBytes): Set<string> {
  const { dataMessageBytes } = getFrozenDataMessage(contentBytes);
  const seats = audienceOfDataMessage(dataMessageBytes);
  strictAssert(seats, 'zrdt: frozen DataMessage has no audience');
  return audienceAcis(seats);
}

function sendStateAcis(message: MessageModel): Array<AciString> {
  const out = new Array<AciString>();
  const ourAci = itemStorage.user.getCheckedAci();
  for (const id of Object.keys(
    message.get('sendStateByConversationId') ?? {}
  )) {
    const aci = window.ConversationController.get(id)?.getAci();
    if (aci && aci !== ourAci) {
      out.push(aci);
    }
  }
  return out;
}

/**
 * The identity key we hold for `aci` (33 bytes). Without one, fetch the
 * prekey bundle first, as a send to that member would. Only a 404
 * (unregistered) gives none (the zero tag); any other failure throws, so the
 * attempt fails and the job retries (JOIN_PLAN §4.1).
 */
async function loadOrFetchIdentityKey(
  aci: AciString,
  log: LoggerType
): Promise<ArrayBytes | undefined> {
  const loaded = await signalProtocolStore.loadIdentityKey(aci);
  if (loaded) {
    strictAssert(
      loaded.byteLength === IDENTITY_KEY_BYTES,
      'zrdt: identity key is not 33 bytes'
    );
    return loaded;
  }
  try {
    const member = window.ConversationController.get(aci);
    const accessKey = member
      ? ((await getSendOptions(member.attributes)).sendMetadata?.[aci]
          ?.accessKey ?? null)
      : null;
    await getKeysForServiceId(
      aci,
      { getKeysForServiceId: doGetKeysForServiceId, getKeysForServiceIdUnauth },
      null,
      accessKey,
      null
    );
  } catch (error) {
    if (error instanceof UnregisteredUserError) {
      log.warn(`zrdt/audience: ${aci} is unregistered (404); zero tag`);
      return undefined;
    }
    throw error;
  }
  const fetched = await signalProtocolStore.loadIdentityKey(aci);
  if (!fetched || fetched.byteLength !== IDENTITY_KEY_BYTES) {
    throw new Error(`zrdt/audience: no identity key for ${aci}; will retry`);
  }
  return fetched;
}

/** The enqueue snapshot, or (a message without one) its send state. */
function getAudienceSnapshot(message: MessageModel): AudienceSnapshot {
  return (
    message.get('zrdtAudience') ?? snapshotFromSendState(sendStateAcis(message))
  );
}

/**
 * Everyone a record can ever be sent to: the recipients at enqueue (a
 * superset of its seats and of every attempt's recipients). The quote rule
 * checks them all.
 */
export function getZrdtEnqueueRecipients(
  message: MessageModel
): ReadonlyArray<string> {
  return getAudienceSnapshot(message).recipients;
}

/**
 * The members for AUDIENCE at freeze (JOIN_PLAN §4.1), or 'tooLarge' when
 * field 201 cannot hold them (the message then goes without zrdt).
 */
async function loadAudienceMembers(
  conversation: ConversationModel,
  message: MessageModel,
  log: LoggerType
): Promise<Array<AudienceMember> | 'tooLarge'> {
  const ourAci = itemStorage.user.getCheckedAci();
  const plan = planAudience({
    ourAci,
    snapshot: getAudienceSnapshot(message),
    currentMembers: (conversation.get('membersV2') ?? []).map(m => m.aci),
  });
  if (plan.tooLarge) {
    return 'tooLarge';
  }
  const ourKey = signalProtocolStore.getIdentityKeyPair(ourAci);
  strictAssert(ourKey, 'zrdt: no identity key pair of our own');
  const candidates = new Set(plan.seatCandidates.map(aciStringHex));
  const members = new Array<AudienceMember>();
  for (const aci of plan.members) {
    const aciBytes = uuidToBytes(aci);
    if (aciStringHex(aci) === aciStringHex(ourAci)) {
      members.push({
        aci: aciBytes,
        key: new Uint8Array(ourKey.publicKey.serialize()),
      });
    } else if (candidates.has(aciStringHex(aci)) && isAciString(aci)) {
      // oxlint-disable-next-line no-await-in-loop
      const key = await loadOrFetchIdentityKey(aci, log);
      members.push(key ? { aci: aciBytes, key } : { aci: aciBytes });
    } else {
      members.push({ aci: aciBytes });
    }
  }
  const seated = members.filter(m => m.key !== undefined).length;
  log.info(
    `zrdt/audience: ${members.length} members, ${seated} seated ` +
      `(${aciHex(uuidToBytes(ourAci)).slice(0, 8)} is the author)`
  );
  return members;
}

/**
 * The Content to send for an in-scope group message (isZrdtGroupSend), from
 * inside the conversation's queueJob: frozen once, the same bytes on every
 * attempt; and the ACIs (hex) of its audience, which bound the recipients of
 * every attempt. Undefined if the group is over the audience cap (256): the
 * message then is no record and goes the stock way.
 */
export async function getZrdtGroupSendContent({
  conversation,
  message,
  groupSendOptions,
  messaging,
  log,
}: Readonly<{
  conversation: ConversationModel;
  message: MessageModel;
  groupSendOptions: GroupMessageOptionsType;
  messaging: MessageSender;
  log: LoggerType;
}>): Promise<
  | { contentMessage: Proto.Content.Params; audienceAcis: Set<string> }
  | undefined
> {
  // Resumed send jobs can run before startup finished zrdtService.init();
  // init() is idempotent (T0), so wait for it: heads must come from the store
  // OPENed from SQL rows, never from an empty one.
  await zrdtService.init();
  // Fail closed (APP.md §2): no backend fails this attempt and the job
  // retries. A group record never goes out unlinked.
  const backend = zrdtService.backendInfo();
  if (!backend.available) {
    throw new Error(`zrdt unavailable (${backend.kind}); will retry`);
  }
  if (message.get('zrdt') == null) {
    const plan = planAudience({
      ourAci: itemStorage.user.getCheckedAci(),
      snapshot: getAudienceSnapshot(message),
      currentMembers: (conversation.get('membersV2') ?? []).map(m => m.aci),
    });
    if (plan.tooLarge) {
      log.warn('zrdt: more than 256 audience members; sending without zrdt');
      return undefined;
    }
  }
  const groupId = getGroupIdBytes(conversation);
  await zrdtService.ensureConversation(conversation.id, groupId);
  await reacceptOutgoingForConversation(conversation, log);
  const contentMessage = await freezeZrdtSend({
    conversationId: conversation.id,
    groupId,
    ourAci: getOurAciBytes(),
    message: {
      idForLogging: getMessageIdForLogging(message.attributes),
      getZrdt: () => message.get('zrdt'),
      update: async attributes => {
        message.set(attributes);
        await window.MessageCache.saveMessage(message.attributes);
      },
    },
    buildContent: zrdt =>
      messaging.getContentMessage(
        messaging.getAttrsFromGroupOptions({ ...groupSendOptions, zrdt })
      ),
    getAudienceMembers: async () => {
      const members = await loadAudienceMembers(conversation, message, log);
      if (members === 'tooLarge') {
        throw new Error('zrdt: more than 256 audience members');
      }
      return members;
    },
    log,
  });
  const frozen = message.get('zrdt');
  strictAssert(frozen, 'zrdt: no frozen send after freeze');
  return {
    contentMessage,
    audienceAcis: getFrozenAudienceAcis(Bytes.fromBase64(frozen.contentBytes)),
  };
}
