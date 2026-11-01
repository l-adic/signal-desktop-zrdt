// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// A stripped quote on receive (zrdt docs/JOIN_PLAN.md section 8.3): it
// carries no id, author or content, only the quoted record's digest
// (Quote.zrdtRef). A fork receiver that holds that record refills the quote
// from its own copy, as Desktop does for every quote (copyQuote.preload.ts);
// one that does not (a newcomer) shows "original not found". Every other
// quote goes the stock way.

import { createLogger } from '../logging/log.std.ts';
import type { QuotedMessageType } from '../model-types.d.ts';
import type { ProcessedQuote } from '../textsecure/Types.d.ts';
import { DataReader } from '../sql/Client.preload.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import { copyFromQuotedMessage } from '../messages/copyQuote.preload.ts';
import { getSourceServiceId } from '../messages/sources.preload.ts';
import { isAciString } from '../util/isAciString.std.ts';
import { toHex } from './receive.preload.ts';

const log = createLogger('zrdt/receiveQuote');

/** The quote to store for a received quote (stripped or not). */
export async function zrdtCopyQuote(
  quote: ProcessedQuote,
  conversationId: string
): Promise<QuotedMessageType> {
  const { zrdtRef, ...rest } = quote;
  if (zrdtRef === undefined) {
    return copyFromQuotedMessage(rest, conversationId);
  }
  const hex = toHex(zrdtRef);
  const rows = await DataReader.getMessageIdsByZrdtDigest(conversationId, [
    hex,
  ]);
  for (const { messageId } of rows) {
    // oxlint-disable-next-line no-await-in-loop
    const original = await getMessageById(messageId);
    const authorAci = original
      ? getSourceServiceId(original.attributes)
      : undefined;
    const sentAt = original?.get('sent_at');
    if (sentAt != null && authorAci != null && isAciString(authorAci)) {
      log.info(`stripped quote of ${hex.slice(0, 8)}: refilled from our copy`);
      return copyFromQuotedMessage(
        { ...rest, id: sentAt, authorAci },
        conversationId
      );
    }
  }
  log.info(`stripped quote of ${hex.slice(0, 8)}: original not found`);
  return {
    id: null,
    attachments: [],
    isGiftBadge: false,
    isViewOnce: false,
    referencedMessageNotFound: true,
  };
}
