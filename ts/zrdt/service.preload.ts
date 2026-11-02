// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The zrdt service: the one entry point the send path, the receive path, the
// resend path and the UI use (shared contract, lane T0). The logic is in
// ./serviceCore.node.ts; this file wires it to Signal: the SQL layer
// (DataReader, DataWriter), the conversation's group id and our ACI.
//
// Events on `zrdtEvents`:
// - 'backend' (info: { kind, version, available }): the backend changed,
//   e.g. zrdtd exited (available: false; show the unavailable banner);
// - 'accepted' (conversationId, hexDigest): a record row was written;
// - 'classify' (conversationId): statuses may have changed; call classify();
// - 'rejected' (conversationId, outcome): extra, a conversation's rows did
//   not OPEN at start (show the rejected banner; see rejectionOf()).
// - 'boundary' (conversationId, hexDigests): a relative store took new
//   boundary digests (JOIN_PLAN §6.2).

import type { EventEmitter } from 'node:events';

import { fromBase64, fromHex, toHex } from '../Bytes.std.ts';
import { DataReader, DataWriter } from '../sql/Client.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import {
  createZrdtBackend,
  intendedBackendKind,
} from './backendFactory.node.ts';
import { ZrdtServiceCore } from './serviceCore.node.ts';
import type { ZrdtAppsBackend } from './ZrdtBackend.std.ts';
import { groupIdOfAppKey, isAppStoreKey } from './apps/channels.std.ts';
import { appOpenings } from './apps/appOpenings.preload.ts';
import type { ZrdtOpenOutcome, ZrdtServiceType } from './serviceCore.node.ts';

export type {
  ZrdtAcceptOutcome,
  ZrdtBackendInfo,
  ZrdtOpenOutcome,
  ZrdtProvenance,
  ZrdtServiceType,
  ZrdtStatus,
  ZrdtViewItem,
  ZrdtViewOutcome,
} from './serviceCore.node.ts';

function groupIdOf(
  conversationId: string
): Uint8Array<ArrayBuffer> | undefined {
  // zrdt apps: a channel store's key carries its group, the channel id.
  if (isAppStoreKey(conversationId)) {
    return groupIdOfAppKey(conversationId);
  }
  const groupId =
    window.ConversationController?.get(conversationId)?.get('groupId');
  if (groupId == null) {
    return undefined;
  }
  const bytes = fromBase64(groupId);
  return bytes.length === 32 ? bytes : undefined;
}

const core = new ZrdtServiceCore({
  createBackend: () => createZrdtBackend(),
  intendedKind: () => intendedBackendKind(),
  storage: {
    getZrdtConversationIds: () => DataReader.getZrdtConversationIds(),
    getZrdtRecords: id => DataReader.getZrdtRecords(id),
    insertZrdtRecords: rows => DataWriter.insertZrdtRecords(rows),
    deleteZrdtRecords: (id, digests) =>
      DataWriter.deleteZrdtRecords(id, digests),
    getZrdtPending: id => DataReader.getZrdtPending(id),
    insertZrdtPending: row => DataWriter.insertZrdtPending(row),
    deleteZrdtPending: (id, digests) =>
      DataWriter.deleteZrdtPending(id, digests),
    getZrdtProvenance: id => DataReader.getZrdtProvenance(id),
    upsertZrdtProvenance: (rows, options) =>
      DataWriter.upsertZrdtProvenance(rows, options),
    markZrdtDisowned: (id, digests, by) =>
      DataWriter.markZrdtDisowned(id, digests, by),
    getZrdtStoreMode: id => DataReader.getZrdtStoreMode(id),
    setZrdtStoreMode: (id, mode) => DataWriter.setZrdtStoreMode(id, mode),
    getZrdtBoundary: id => DataReader.getZrdtBoundary(id),
    insertZrdtBoundary: rows => DataWriter.insertZrdtBoundary(rows),
    archiveZrdtConversation: (id, archiveId) =>
      DataWriter.archiveZrdtConversation(id, archiveId),
  },
  groupIdOf,
  ourAci: () => itemStorage.user.getAci(),
  heldOpenings: async (conversationId, digests) => {
    if (isAppStoreKey(conversationId)) {
      // zrdt apps: openings live in the app opening store, not message rows.
      const all = await appOpenings().all(conversationId);
      if (digests === undefined) {
        return all;
      }
      const want = new Set(digests.map(d => toHex(d)));
      return all.filter(h => want.has(toHex(h.digest)));
    }
    const wanted =
      digests ??
      (await DataReader.getZrdtRecords(conversationId)).map(row => row.digest);
    const ids = await DataReader.getMessageIdsByZrdtDigest(
      conversationId,
      wanted.map(digest => toHex(digest))
    );
    const held = new Array<{
      digest: Uint8Array<ArrayBuffer>;
      opening: Uint8Array<ArrayBuffer>;
    }>();
    for (const { digest, messageId } of ids) {
      // oxlint-disable-next-line no-await-in-loop
      const message = await DataReader.getMessageById(messageId);
      if (message?.zrdtOpening != null) {
        held.push({
          digest: fromHex(digest),
          opening: fromBase64(message.zrdtOpening),
        });
      }
    }
    return held;
  },
  // Set by resend.preload.ts while a catch-up waits for its first reply.
  awaitingCatchUp: conversationId =>
    window.ConversationController?.get(conversationId)?.get('zrdtCatchUp') !=
    null,
});

export const zrdtService: ZrdtServiceType = core;

/** zrdt apps: the protocol-5 ops while zrdtd speaks protocol 5, else undefined. */
export function appsBackend(): ZrdtAppsBackend | undefined {
  return core.appsBackend();
}

export const zrdtEvents: EventEmitter = core.events;

/** Extra: the OPEN outcome of a conversation rejected at start, if any. */
export function rejectionOf(
  conversationId: string
): ZrdtOpenOutcome | undefined {
  return core.rejection(conversationId);
}

/** Extra: start a new backend after zrdtd exited, and re-OPEN every chat. */
export function restartZrdt(): Promise<void> {
  return core.restart();
}

/** Extra: "Keep what verifies" from the conversation's own rows. */
export function salvageStored(
  conversationId: string
): ReturnType<ZrdtServiceCore['salvageStored']> {
  return core.salvageStored(conversationId);
}
