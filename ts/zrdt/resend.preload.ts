// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The resend protocol (APP.md §5 steps 3, 6, 7, 9, 11): ask for records by
// digest (1:1 to the referencing sender first, then to the group), answer
// such requests (sendLog re-send for our own messages, else ZrdtResend), and
// route ZrdtResend / ZrdtNotFound. Replies are always 1:1.

import { ContentHint } from '@signalapp/libsignal-client';

import * as Bytes from '../Bytes.std.ts';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import type { SignalService as Proto } from '../protobuf/index.std.ts';
import { DataReader, DataWriter } from '../sql/Client.preload.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import { messageSender } from '../textsecure/SendMessage.preload.ts';
import { conversationJobQueue } from '../jobs/conversationJobQueue.preload.ts';
import { getSendOptions } from '../util/getSendOptions.preload.ts';
import { drop } from '../util/drop.std.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import type { AciString } from '../types/ServiceId.std.ts';
import { isAciString } from '../util/isAciString.std.ts';
import { uuidToBytes } from '../util/uuidToBytes.std.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import type { HeldRecord, ResendTarget } from './resendLogic.std.ts';
import {
  ResendScheduler,
  planResendResponse,
  readResendOptions,
} from './resendLogic.std.ts';
import { zrdtEvents, zrdtService } from './service.preload.ts';
import { acceptRelayedRecord, setGapState, toHex } from './receive.preload.ts';
import type { ZrdtBytes } from './receive.preload.ts';

const log = createLogger('zrdt/resend');

// Own messages older than this are not looked up in the sendLog (Desktop
// prunes it after a day; APP.md §5 step 9).
const SEND_LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

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
      sendResendRequest(conversationId, target, digests),
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

// The UI's "Ask again" / "Ask for it" (gap row, compare screen). Asks now,
// 1:1 to `firstAskAci` if given (then the group after the timeout), else the
// group. Not deduped.
/** @knipignore shared contract; the UI lane (T3) calls it */
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
// so its app re-sends the original, which arrives live.
export async function requestAuthorCopy(
  conversationId: string,
  digest: string,
  authorAci: AciString
): Promise<void> {
  try {
    await sendResendRequest(
      conversationId,
      { kind: 'direct', aci: authorAci },
      [digest]
    );
  } catch (error) {
    log.warn('author fast path failed', Errors.toLogFormat(error));
  }
}

// --- sending --------------------------------------------------------------------------

function getGroupIdBytes(
  conversation: ConversationModel
): Uint8Array<ArrayBuffer> | undefined {
  const groupId = conversation.get('groupId');
  return groupId ? Bytes.fromBase64(groupId) : undefined;
}

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

async function sendResendRequest(
  conversationId: string,
  target: ResendTarget,
  digests: ReadonlyArray<string>
): Promise<void> {
  const conversation = window.ConversationController.get(conversationId);
  const groupId = conversation ? getGroupIdBytes(conversation) : undefined;
  if (!conversation || !groupId) {
    log.warn(`resend request: no group for ${conversationId}`);
    return;
  }
  const ourAci = itemStorage.user.getCheckedAci();
  const recipients =
    target.kind === 'direct'
      ? [target.aci]
      : conversation.getRecipients().filter(id => id !== ourAci);
  const content: Proto.Content.Params['content'] = {
    zrdtResendRequest: {
      groupId,
      digests: digests.map(digest => Bytes.fromHex(digest)),
    },
  };
  log.info(
    `resend request (${target.kind}) for ${digests.map(d => d.slice(0, 8)).join(',')}`
  );
  await Promise.all(
    recipients.map(async aci => {
      try {
        await sendControl(aci, content, 'ZrdtResendRequest');
      } catch (error) {
        log.warn(
          `ZrdtResendRequest to ${aci} failed`,
          Errors.toLogFormat(error)
        );
      }
    })
  );
}

// --- dispatch from MessageReceiver -------------------------------------------------

// Content 200-202. `senderAci` is the authenticated envelope sender.
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
    if ('zrdtResendRequest' in content && content.zrdtResendRequest) {
      // Answer in the background: replies are sends, and must not hold up
      // the receive queue.
      drop(onResendRequest(senderAci, content.zrdtResendRequest));
    } else if ('zrdtResend' in content && content.zrdtResend) {
      const { groupId, record, opening } = content.zrdtResend;
      if (!groupId || !record) {
        log.warn('ZrdtResend without groupId or record; dropped');
        return;
      }
      await acceptRelayedRecord({
        groupId,
        responderAci: senderAci,
        record,
        opening: opening && opening.byteLength > 0 ? opening : undefined,
      });
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

// --- responder (step 6) -------------------------------------------------------------

async function onResendRequest(
  requesterAci: AciString,
  request: Proto.ZrdtResendRequest
): Promise<void> {
  try {
    const { groupId } = request;
    const conversation = groupId
      ? window.ConversationController.get(Bytes.toBase64(groupId))
      : undefined;
    if (!conversation || !groupId || !conversation.areWeAGroupMember()) {
      log.warn('resend request for a group we are not in; ignored');
      return;
    }
    const conversationId = conversation.id;
    const ourAci = itemStorage.user.getCheckedAci();
    const digests = request.digests.map(toHex);
    log.info(
      `resend request from ${requesterAci}: ${digests.map(d => d.slice(0, 8)).join(',')}`
    );

    const held = new Map<string, HeldRecord>();
    const messageRows = await DataReader.getMessageIdsByZrdtDigest(
      conversationId,
      digests
    );
    for (const digest of new Set(digests)) {
      // oxlint-disable-next-line no-await-in-loop
      const stored = await zrdtService.get(
        conversationId,
        Bytes.fromHex(digest)
      );
      if (!stored) {
        continue;
      }
      const row = messageRows.find(r => r.digest === digest);
      // oxlint-disable-next-line no-await-in-loop
      const message = row ? await getMessageById(row.messageId) : undefined;
      const authorAci = Bytes.areEqual(
        new Uint8Array(stored.authorAci),
        uuidToBytes(ourAci)
      )
        ? ourAci
        : 'other';
      const sentAt = message?.get('sent_at');
      let inSendLog = false;
      if (
        authorAci === ourAci &&
        sentAt != null &&
        Date.now() - sentAt < SEND_LOG_WINDOW_MS
      ) {
        // oxlint-disable-next-line no-await-in-loop
        const sentProto = await DataWriter.getSentProtoByRecipient({
          now: Date.now(),
          recipientServiceId: requesterAci,
          timestamp: sentAt,
        });
        inSendLog = sentProto != null;
      }
      held.set(digest, {
        digest,
        record: new Uint8Array(stored.record),
        authorAci,
        message:
          message && sentAt != null
            ? { sentAt, opening: message.get('zrdtOpening') }
            : undefined,
        inSendLog,
      });
    }

    const plan = planResendResponse({
      digests,
      held,
      ourAci,
      requesterIsMember: conversation.hasMember(requesterAci),
      // TODO(zrdt): membership at send time (A9). The demo group is static.
      requesterWasMemberAtSend: () => conversation.hasMember(requesterAci),
    });

    for (const { digest, sentAt } of plan.savedProto) {
      // oxlint-disable-next-line no-await-in-loop
      const ok = await resendFromSendLog(conversation, requesterAci, sentAt);
      if (!ok) {
        const item = held.get(digest);
        if (item) {
          // oxlint-disable-next-line no-await-in-loop
          await sendRelay(conversation, requesterAci, item.record, undefined);
        }
      }
    }
    for (const { record, opening } of plan.relay) {
      // oxlint-disable-next-line no-await-in-loop
      await sendRelay(
        conversation,
        requesterAci,
        record,
        opening ? Bytes.fromBase64(opening) : undefined
      );
    }
    if (plan.notFound.length > 0) {
      await sendControl(
        requesterAci,
        {
          zrdtNotFound: {
            groupId,
            digests: plan.notFound.map(digest => Bytes.fromHex(digest)),
          },
        },
        'ZrdtNotFound'
      );
    }
  } catch (error) {
    log.error('answering resend request failed', Errors.toLogFormat(error));
  }
}

async function sendRelay(
  conversation: ConversationModel,
  requesterAci: AciString,
  record: Uint8Array<ArrayBuffer>,
  opening: Uint8Array<ArrayBuffer> | undefined
): Promise<void> {
  const groupId = getGroupIdBytes(conversation);
  if (!groupId) {
    return;
  }
  await sendControl(
    requesterAci,
    { zrdtResend: { groupId, record, opening: opening ?? null } },
    opening ? 'ZrdtResend' : 'ZrdtResend (structure only)'
  );
}

// Our own message: re-send the original bytes from the sendLog, as Desktop's
// retry path does (handleRetry.preload.ts:236-245). It arrives live.
async function resendFromSendLog(
  conversation: ConversationModel,
  requesterAci: AciString,
  sentAt: number
): Promise<boolean> {
  const sentProto = await DataWriter.getSentProtoByRecipient({
    now: Date.now(),
    recipientServiceId: requesterAci,
    timestamp: sentAt,
  });
  if (!sentProto) {
    return false;
  }
  const { contentHint, proto, timestamp, urgent } = sentProto;
  const recipientConversation = window.ConversationController.getOrCreate(
    requesterAci,
    'private'
  );
  await conversationJobQueue.add({
    type: 'SavedProto',
    conversationId: recipientConversation.id,
    contentHint,
    groupId: conversation.get('groupId'),
    protoBase64: Bytes.toBase64(proto),
    story: false,
    timestamp,
    urgent,
  });
  log.info(`re-sent own message ${sentAt} to ${requesterAci} from sendLog`);
  return true;
}
