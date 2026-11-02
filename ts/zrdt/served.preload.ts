// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The only send path for a SERVE reply (zrdt docs/JOIN_PLAN.md sections 4.3,
// 8.2): `sendZrdtServed(conversation, reply, key)`. It checks that the key's
// tag is the one SERVE put in the reply header, takes the destination ACI
// from that header, seals the entries to that key (seal.node.ts), and sends
// them 1:1. A host bug that picks the wrong account or key therefore sends
// bytes nobody but the checked key's holder can open.
//
// Nothing else builds a ZrdtServed: ts/test-node/zrdt/servedLint_test.node.ts
// fails if `zrdtServed:` appears in any other source file. A zrdt request
// never triggers the sendLog re-send (it encrypts to whatever key is current).

import { ContentHint } from '@signalapp/libsignal-client';

import { createLogger } from '../logging/log.std.ts';
import type { SignalService as Proto } from '../protobuf/index.std.ts';
import { messageSender } from '../textsecure/SendMessage.preload.ts';
import { getSendOptions } from '../util/getSendOptions.preload.ts';
import { fromAciUuidBytes } from '../util/ServiceId.node.ts';
import type { ServeReply } from './ZrdtBackend.std.ts';
import { aciHex } from './audience.std.ts';
import { keyTag, sealServeReply } from './seal.node.ts';
import { MAX_INLINE_SEALED_BYTES } from './apps/appMessage.std.ts';
import { uploadFresh } from './apps/cdn.preload.ts';

const log = createLogger('zrdt/served');

type Bytes = Uint8Array<ArrayBuffer>;

/**
 * The Content of a sealed reply, for `send`, and its destination: both from
 * SERVE's reply header.
 * @testexport
 */
export function buildZrdtServedContent({
  groupId,
  reply,
  key,
}: Readonly<{
  groupId: Bytes;
  reply: ServeReply;
  key: Bytes;
}>): {
  destinationAci: Bytes;
  content: Proto.Content.Params['content'];
} {
  if (aciHex(keyTag(key)) !== aciHex(reply.header.keyTag)) {
    throw new Error('zrdt served: the key is not the one SERVE checked');
  }
  const { ephemeralKey, sealed } = sealServeReply({
    group: groupId,
    headerBytes: reply.headerBytes,
    entriesBytes: reply.entriesBytes,
    recipientKey: key,
  });
  return {
    destinationAci: reply.header.requesterAci,
    content: {
      zrdtServed: {
        groupId,
        header: reply.headerBytes,
        ephemeralKey,
        sealed,
        sealedOnCdn: null,
      },
    },
  };
}

/**
 * Seals SERVE's reply to `key` (the identity key passed to SERVE) and sends
 * it 1:1 to the ACI in the reply header.
 */
export async function sendZrdtServed({
  groupId,
  reply,
  key,
}: Readonly<{
  groupId: Bytes;
  reply: ServeReply;
  key: Bytes;
}>): Promise<void> {
  const built = buildZrdtServedContent({
    groupId,
    reply,
    key,
  });
  const { destinationAci } = built;
  let { content } = built;
  // zrdt apps (BUILD_M1 §B.9): a sealed reply over 48 KiB (every 1 MiB piece)
  // goes as a CDN attachment holding exactly the sealed bytes.
  const inline =
    content && 'zrdtServed' in content ? content.zrdtServed : undefined;
  if (inline?.sealed && inline.sealed.byteLength > MAX_INLINE_SEALED_BYTES) {
    const pointer = await uploadFresh(new Uint8Array(inline.sealed));
    content = {
      zrdtServed: { ...inline, sealed: null, sealedOnCdn: pointer },
    };
  }
  const aci = fromAciUuidBytes(destinationAci);
  if (aci === undefined) {
    throw new Error('zrdt served: the header holds no ACI');
  }
  const recipient = window.ConversationController.getOrCreate(aci, 'private');
  const sendOptions = await getSendOptions(recipient.attributes);
  await messageSender.sendIndividualProto({
    contentHint: ContentHint.Implicit,
    serviceId: aci,
    options: sendOptions,
    proto: {
      content,
      pniSignatureMessage: null,
      senderKeyDistributionMessage: null,
    },
    timestamp: Date.now(),
    urgent: false,
  });
  log.info(
    `sealed reply with ${reply.entries.length} entries sent to ${aci} ` +
      `(request ${aciHex(reply.header.requestId).slice(0, 8)})`
  );
}
