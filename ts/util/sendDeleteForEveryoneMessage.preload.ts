// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConversationAttributesType } from '../model-types.d.ts';
import type { ConversationQueueJobData } from '../jobs/conversationJobQueue.preload.ts';
import * as Errors from '../types/errors.std.ts';
import { createLogger } from '../logging/log.std.ts';
import {
  conversationJobQueue,
  conversationQueueJobEnum,
} from '../jobs/conversationJobQueue.preload.ts';
import { applyDeleteForEveryone } from './deleteForEveryone.preload.ts';
import {
  getConversationIdForLogging,
  getMessageIdForLogging,
} from './idForLogging.preload.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import { getRecipientConversationIds } from './getRecipientConversationIds.dom.ts';
import { getRecipients } from './getRecipients.dom.ts';
import { repeat, zipObject } from './iterables.std.ts';
import { isOutgoing } from '../state/selectors/message.preload.ts';
import { canSendDeleteForEveryone } from './canDeleteForEveryone.preload.ts';
import { areWeAdmin } from './areWeAdmin.preload.ts';
import { isAciString } from './isAciString.std.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { strictAssert } from './assert.std.ts';
import {
  getZrdtEditRecipients,
  splitZrdtTargetConversationIds,
} from '../zrdt/quote.preload.ts';

const log = createLogger('sendDeleteForEveryoneMessage');

export async function sendDeleteForEveryoneMessage(
  conversationAttributes: ConversationAttributesType,
  options: {
    id: string;
    timestamp: number;
  }
): Promise<void> {
  const { timestamp: targetTimestamp, id: messageId } = options;
  const message = await getMessageById(messageId);
  if (!message) {
    throw new Error('sendDeleteForEveryoneMessage: Cannot find message!');
  }
  const idForLogging = getMessageIdForLogging(message.attributes);

  const ourAci = itemStorage.user.getCheckedAci();
  const { sourceServiceId } = message.attributes;
  const messageAuthorAci = isOutgoing(message.attributes)
    ? ourAci
    : sourceServiceId;

  strictAssert(
    isAciString(messageAuthorAci),
    'sendDeleteForEveryoneMessage: Needs message author ACI'
  );

  const result = canSendDeleteForEveryone({
    targetMessage: message.attributes,
    targetConversation: conversationAttributes,
    ourAci,
    isDeleterGroupAdmin: areWeAdmin(conversationAttributes),
  });

  if (!result.ok) {
    throw new Error(`Cannot send DOE: ${result.reason}`);
  }

  const { needsAdminDelete: isAdminDelete } = result;

  // zrdt target rule (JOIN_PLAN §8.3): a delete names its target's author
  // and sent timestamp, so it goes only to the target's seats. Decided now,
  // while the target still holds its opening (the delete erases it); the
  // job and its retries send to these recipients only.
  message.set({
    deletedForEveryoneSendStatus: zipObject(
      splitZrdtTargetConversationIds(
        message.attributes,
        getRecipientConversationIds(conversationAttributes)
      ).allowed,
      repeat(false)
    ),
  });

  const conversationIdForLogging = getConversationIdForLogging(
    conversationAttributes
  );

  log.info(
    `enqueuing DeleteForEveryone: ${idForLogging} ` +
      `in conversation ${conversationIdForLogging} (isAdminDelete=${isAdminDelete})`
  );

  try {
    const jobData: ConversationQueueJobData = {
      type: conversationQueueJobEnum.enum.DeleteForEveryone,
      conversationId: conversationAttributes.id,
      isAdminDelete,
      targetMessageId: messageId,
      recipients: getZrdtEditRecipients(
        message.attributes,
        getRecipients(conversationAttributes)
      ),
      revision: conversationAttributes.revision,
    };
    await conversationJobQueue.add(jobData, async jobToInsert => {
      log.info(
        `Deleting message ${idForLogging} ` +
          `in conversation ${conversationIdForLogging} with job ${jobToInsert.id}`
      );
      await window.MessageCache.saveMessage(message.attributes, {
        jobToInsert,
      });
    });
  } catch (error) {
    log.error(
      `Failed to queue delete for everyone for message ${idForLogging}`,
      Errors.toLogFormat(error)
    );
    throw error;
  }

  await applyDeleteForEveryone(message, {
    isAdminDelete,
    targetSentTimestamp: targetTimestamp,
    deleteServerTimestamp: Date.now(),
    deleteSentByAci: ourAci,
    targetConversationId:
      window.ConversationController.getOurConversationIdOrThrow(),
  });
}
