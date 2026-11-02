// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The quote rule and the edit rule (zrdt docs/JOIN_PLAN.md section 8.3): the
// two stock paths that would carry older content to a newcomer.
//
// - Quotes. On the return value of uploadMessageQuote in sendNormalMessage,
//   on every attempt (sends, edits and manual retries alike): a quote of `p`
//   keeps its text, ranges and thumbnails only if every account that can
//   receive the quoting message's content is seated, by ACI, in `p`'s
//   committed audience (field 201 of `p`'s opening). Otherwise it is
//   stripped: no id, author, text, ranges or attachments, only `p`'s record
//   digest (Quote.zrdtRef). makeQuote and the local `quote` attribute (our
//   own UI) are left alone.
// - Edits, and every other message that points at a target (the target
//   rule): an edit, a reaction, a pin or unpin, a delete for everyone, a poll
//   vote or terminate names its target's author and sent timestamp, so it
//   goes only to the target's seats ∩ the current recipients when the target
//   has a committed audience (sendEditedMessage, Reactions, sendReaction,
//   createSendMessageJob for pins, sendDeleteForEveryoneMessage and its job,
//   Polls and sendPollTerminate). A newcomer never learns the author or time
//   of a message he was not sent. Polls are not records (scope.std.ts), so a
//   poll has no committed audience and its votes go the stock way: a vote on
//   a poll sent before an add reaches the newcomer (a known metadata gap).

import * as Bytes from '../Bytes.std.ts';
import type { LoggerType } from '../types/Logging.std.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import type { MessageModel } from '../models/messages.preload.ts';
import type { ReadonlyMessageAttributesType } from '../model-types.d.ts';
import type { OutgoingQuoteType } from '../textsecure/SendMessage.preload.ts';
import { isQuoteAMatch } from '../messages/quotes.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { isGroupV2, isMe } from '../util/whatTypeOfConversation.dom.ts';
import {
  aciStringHex,
  audienceOfDataMessage,
  seatedAcis,
} from './audience.std.ts';
import type { Seat } from './audience.std.ts';
import { editRecipients, mayKeepQuote } from './audiencePlan.std.ts';
import { getFrozenDataMessage } from './send.preload.ts';

const NONCE_BYTES = 32;

/**
 * The audience committed in a message we hold: from its opening, or, for
 * our own frozen send, its frozen Content. Undefined if it has none (not a
 * record, or its content was erased).
 */
export function getCommittedAudience(
  message: ReadonlyMessageAttributesType
): Array<Seat> | undefined {
  if (message.zrdtOpening != null) {
    const opening = Bytes.fromBase64(message.zrdtOpening);
    if (opening.byteLength > NONCE_BYTES) {
      return audienceOfDataMessage(opening.slice(NONCE_BYTES));
    }
    return undefined;
  }
  if (message.zrdt != null) {
    try {
      const { dataMessageBytes } = getFrozenDataMessage(
        Bytes.fromBase64(message.zrdt.contentBytes)
      );
      return audienceOfDataMessage(dataMessageBytes);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The quote with its content removed, pointing at `p` by record digest. */
function stripQuote(zrdtDigest: string | undefined): OutgoingQuoteType {
  return {
    isGiftBadge: false,
    attachments: [],
    ...(zrdtDigest ? { zrdtRef: Bytes.fromHex(zrdtDigest) } : {}),
  };
}

/**
 * The quote rule on the wire quote of this attempt. `recipients` are this
 * attempt's recipients; `extraReceivers` everyone else who can receive this
 * message's content (for a record: every recipient at enqueue, a superset of
 * its seats; we are always counted).
 */
export async function applyZrdtQuoteRule({
  quote,
  conversation,
  recipients,
  extraReceivers = [],
  findQuoted = findQuotedMessage,
  ourAci = itemStorage.user.getCheckedAci(),
  log,
}: Readonly<{
  quote: OutgoingQuoteType | undefined;
  conversation: Pick<ConversationModel, 'id' | 'attributes'>;
  recipients: ReadonlyArray<string>;
  extraReceivers?: ReadonlyArray<string>;
  findQuoted?: (
    conversationId: string,
    quote: OutgoingQuoteType
  ) => Promise<ReadonlyMessageAttributesType | undefined>;
  ourAci?: string;
  log: LoggerType;
}>): Promise<OutgoingQuoteType | undefined> {
  if (quote === undefined || !isGroupV2(conversation.attributes)) {
    return quote;
  }
  const quoted = await findQuoted(conversation.id, quote);
  const seats = quoted ? getCommittedAudience(quoted) : undefined;
  const receivers = [...recipients, ...extraReceivers, ourAci];
  if (mayKeepQuote(receivers, seats ? seatedAcis(seats) : undefined)) {
    return quote;
  }
  log.info(
    `zrdt quote rule: stripped the quote of ${quote.id ?? '?'} ` +
      `(${seats ? 'a receiver is not seated' : 'no audience known'})`
  );
  return stripQuote(quoted?.zrdtDigest);
}

async function findQuotedMessage(
  conversationId: string,
  quote: OutgoingQuoteType
): Promise<ReadonlyMessageAttributesType | undefined> {
  const { id, authorAci } = quote;
  if (id == null || authorAci == null) {
    return undefined;
  }
  const found: MessageModel | undefined =
    await window.MessageCache.findBySentAt(id, (message: MessageModel) =>
      isQuoteAMatch(message.attributes, conversationId, { id, authorAci })
    );
  return found?.attributes;
}

/**
 * The target rule: the recipients (service ids) of an edit of `target`, or of
 * any other message that points at it. A target without a committed
 * audience is not a record: stock recipients.
 */
export function getZrdtEditRecipients<T extends string>(
  target: ReadonlyMessageAttributesType,
  currentRecipients: ReadonlyArray<T>
): Array<T> {
  const seats = getCommittedAudience(target);
  return editRecipients(
    currentRecipients,
    seats ? seatedAcis(seats) : undefined
  );
}

/** A member conversation as the target rule sees it: ourselves, or an ACI. */
export type ZrdtTargetMemberType = 'me' | { aci: string } | undefined;

function memberOfConversationId(conversationId: string): ZrdtTargetMemberType {
  const conversation = window.ConversationController.get(conversationId);
  if (!conversation) {
    return undefined;
  }
  if (isMe(conversation.attributes)) {
    return 'me';
  }
  const aci = conversation.getAci();
  return aci ? { aci } : undefined;
}

/**
 * The target rule on conversation ids (reactions and poll votes keep their
 * per-recipient state by conversation id): `allowed` are the conversations
 * seated, by ACI, in `target`'s committed audience, and ourselves; `excluded`
 * the rest, which get nothing by design. A target without a committed
 * audience allows every one.
 */
export function splitZrdtTargetConversationIds(
  target: ReadonlyMessageAttributesType,
  conversationIds: Iterable<string>,
  memberOf: (
    conversationId: string
  ) => ZrdtTargetMemberType = memberOfConversationId
): { allowed: Array<string>; excluded: Array<string> } {
  const all = [...conversationIds];
  const seats = getCommittedAudience(target);
  if (seats === undefined) {
    return { allowed: all, excluded: [] };
  }
  const seated = seatedAcis(seats);
  const allowed = new Array<string>();
  const excluded = new Array<string>();
  for (const id of all) {
    const member = memberOf(id);
    if (
      member === 'me' ||
      (member !== undefined && seated.has(aciStringHex(member.aci)))
    ) {
      allowed.push(id);
    } else {
      excluded.push(id);
    }
  }
  return { allowed, excluded };
}
