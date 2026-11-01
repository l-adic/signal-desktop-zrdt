// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Test hooks for the mock harness (lane T4): window.SignalCI.zrdt, installed
// only when window.SignalCI exists (mock/CI builds). Everything returns plain
// JSON (hex strings, no bytes) so playwright's evaluate() can carry it.

import { DataReader } from '../sql/Client.preload.ts';
import { setZrdtCIHooks } from '../CI.preload.ts';
import type { ZrdtOpenOutcome, ZrdtStatus } from './service.preload.ts';
import { zrdtService } from './service.preload.ts';
import { getZrdtMessageProps } from '../state/selectors/message.preload.ts';
import {
  actions as zrdtActions,
  runZrdtThunk,
  zrdtHex,
} from '../state/ducks/zrdt.preload.ts';
import { getConversationSelector } from '../state/selectors/conversations.dom.ts';
import { getUserACI } from '../state/selectors/user.std.ts';
import { labelText } from './ui/labels.std.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import * as Bytes from '../Bytes.std.ts';
import { SignalService as Proto } from '../protobuf/index.std.ts';
import {
  getCatchUpState,
  getServedLog,
  requestDigestsFrom,
} from './resend.preload.ts';
import type { ZrdtServedLogItem } from './resend.preload.ts';
import type { MessageModel } from '../models/messages.preload.ts';
import { enqueueReactionForSend } from '../reactions/enqueueReactionForSend.preload.ts';
import { sleep } from '../util/sleep.std.ts';

/** The message of `conversationId` sent at `sentAt`, from the cache or the DB. */
async function findSentAt(
  conversationId: string,
  sentAt: number
): Promise<MessageModel | undefined> {
  return window.MessageCache.findBySentAt(
    sentAt,
    (m: MessageModel) => m.attributes.conversationId === conversationId
  );
}

export type ZrdtCIMessageType = {
  id: string;
  conversationId: string;
  type: string;
  body?: string;
  sent_at: number;
  received_at: number;
  sourceServiceId?: string;
  zrdtDigest?: string;
  /** The opening (base64): nonce ‖ the committed DataMessage, field 201 in it. */
  zrdtOpening?: string;
  zrdtProvenance?: MessageAttributesType['zrdtProvenance'];
  zrdtStatus?: MessageAttributesType['zrdtStatus'];
  /** CLASSIFY status from the UI slice (fresher than the attribute). */
  classify?: ZrdtStatus;
  /** The label the UI shows ("relayed by Bob"), or null for none. */
  label: string | null;
  /** Imported and unconfirmed: only in the collapsed section. */
  hidden: boolean;
  zrdtGap?: MessageAttributesType['zrdtGap'];
};

export type ZrdtCIHooks = {
  backendInfo: () => { kind: string; version: string; available: boolean };
  /** Redux view of one conversation (statuses, disown, rejected, salvage, unconfirmed). */
  getConversationState: (conversationId: string) => unknown;
  refresh: (conversationId: string) => Promise<void>;
  /** Every loaded message of the conversation in timeline order, with zrdt fields. */
  getMessages: (conversationId: string) => Array<ZrdtCIMessageType>;
  /** DB lookup by sent_at (like SignalCI.getMessagesBySentAt), with zrdt fields. */
  getMessagesBySentAt: (sentAt: number) => Promise<Array<ZrdtCIMessageType>>;
  getGapRows: (conversationId: string) => Promise<Array<ZrdtCIMessageType>>;
  heads: (conversationId: string) => Promise<Array<string>>;
  /** Opens the compare screen and returns our compare code. */
  getCompareCode: (conversationId: string) => Promise<string | undefined>;
  /** Pastes a code into the open compare screen (opens it first if needed). */
  comparePaste: (conversationId: string, code: string) => Promise<unknown>;
  askCompare: () => Promise<void>;
  getCompareState: () => unknown;
  closeCompare: () => void;
  exportStore: (
    conversationId: string,
    path?: string
  ) => Promise<string | undefined>;
  /** The export for another member (SERVE for it, sealed to its key). */
  exportStoreFor: (
    conversationId: string,
    memberAci: string,
    path?: string
  ) => Promise<string | undefined>;
  importStore: (
    conversationId: string,
    path?: string
  ) => Promise<ZrdtOpenOutcome['status'] | undefined>;
  /** Strict mode for the group (JOIN_PLAN §5); returns the saved value. */
  setStrict: (conversationId: string, strict: boolean) => Promise<boolean>;
  /**
   * Reacts to the message sent at `targetSentAt` as the user would; returns
   * the reaction's timestamp (its send's), or undefined if no such message.
   */
  react: (
    conversationId: string,
    targetSentAt: number,
    emoji: string
  ) => Promise<number | undefined>;
  /** Pins the message sent at `targetSentAt`; returns the pin's timestamp. */
  pin: (
    conversationId: string,
    targetSentAt: number
  ) => Promise<number | undefined>;
  keepWhatVerifies: (conversationId: string) => Promise<unknown>;
  getInternalResult: () => string | undefined;
  /** The catch-up of a conversation (JOIN_PLAN §6.1), and whether its store is relative. */
  catchUpState: (conversationId: string) => Promise<{
    hasStore: boolean;
    relative: boolean;
    reason?: string;
    asked: Array<string>;
    answeredBy?: string;
    replies: number;
    since: number;
  }>;
  /** The SERVE replies this device took for the conversation (kinds and digests). */
  servedLog: (conversationId: string) => Array<ZrdtServedLogItem>;
  /** Sends a per-digest SERVE request to one member, now. */
  requestDigests: (
    conversationId: string,
    responderAci: string,
    digests: Array<string>
  ) => Promise<void>;
  /** The zrdt rows of a conversation: records, pending, boundary, provenance (hex). */
  tables: (conversationId: string) => Promise<{
    relative: boolean;
    records: Array<string>;
    pending: Array<string>;
    boundary: Array<{ digest: string; voucherAci: string }>;
    provenance: Array<{ digest: string; kind: string; byAci: string | null }>;
  }>;
  /** Every message row of the conversation in the database, with zrdt fields. */
  allMessages: (conversationId: string) => Promise<Array<ZrdtCIMessageType>>;
  /** The member ACIs of the conversation (membersV2), as this device sees them. */
  memberAcis: (conversationId: string) => Array<string>;
  /**
   * Every message row in the database (all conversations) whose body, quote
   * text or zrdt opening's body is exactly one of `texts`.
   */
  scanMessages: (texts: Array<string>) => Promise<{
    scanned: number;
    hits: Array<{ text: string; id: string; type: string; where: string }>;
  }>;
};

/** The body a zrdt opening (nonce ‖ DataMessage) commits, if it decodes. */
function openingBody(opening: string | undefined): string | undefined {
  if (opening == null) {
    return undefined;
  }
  try {
    const bytes = Bytes.fromBase64(opening);
    return Proto.DataMessage.decode(bytes.subarray(32)).body ?? undefined;
  } catch {
    return undefined;
  }
}

function toCIMessage(message: MessageAttributesType): ZrdtCIMessageType {
  const state = window.reduxStore.getState();
  const statuses =
    state.zrdt.byConversation[message.conversationId]?.statuses ?? undefined;
  const props = getZrdtMessageProps(message, {
    conversationSelector: getConversationSelector(state),
    ourAci: getUserACI(state),
    zrdtStatuses: statuses,
  });
  return {
    id: message.id,
    conversationId: message.conversationId,
    type: message.type,
    body: message.body,
    sent_at: message.sent_at,
    received_at: message.received_at,
    sourceServiceId: message.sourceServiceId,
    zrdtDigest: message.zrdtDigest,
    zrdtOpening: message.zrdtOpening,
    zrdtProvenance: message.zrdtProvenance,
    zrdtStatus: message.zrdtStatus,
    classify:
      message.zrdtDigest != null && statuses != null
        ? statuses[message.zrdtDigest]
        : undefined,
    label: props.zrdtLabel != null ? labelText(props.zrdtLabel) : null,
    hidden: props.zrdtHidden === true,
    zrdtGap: message.zrdtGap,
  };
}

export function installZrdtCIHooks(): void {
  if (window.SignalCI == null) {
    return;
  }
  // Thunks run directly so their promises come back typed.
  const actions = () => ({
    refreshConversation: (id: string) =>
      runZrdtThunk(zrdtActions.refreshConversation(id)),
    openCompare: (id: string) => runZrdtThunk(zrdtActions.openCompare(id)),
    comparePasted: (code: string) =>
      runZrdtThunk(zrdtActions.comparePasted(code)),
    askCompare: () => runZrdtThunk(zrdtActions.askCompare()),
    closeCompare: () => window.reduxStore.dispatch(zrdtActions.closeCompare()),
    exportConversation: (id: string, path?: string) =>
      runZrdtThunk(zrdtActions.exportConversation(id, path)),
    exportConversationFor: (id: string, aci: string, path?: string) =>
      runZrdtThunk(zrdtActions.exportConversationFor(id, aci, path)),
    setStrict: (id: string, strict: boolean) =>
      runZrdtThunk(zrdtActions.setStrict(id, strict)),
    importConversation: (id: string, path?: string) =>
      runZrdtThunk(zrdtActions.importConversation(id, path)),
    keepWhatVerifies: (id: string) =>
      runZrdtThunk(zrdtActions.keepWhatVerifies(id)),
  });
  const zrdtState = () => window.reduxStore.getState().zrdt;

  const hooks: ZrdtCIHooks = {
    backendInfo: () => {
      const fromState = zrdtState().backend;
      if (fromState != null) {
        return { ...fromState };
      }
      return zrdtService.backendInfo();
    },
    getConversationState: conversationId =>
      zrdtState().byConversation[conversationId],
    refresh: async conversationId => {
      await actions().refreshConversation(conversationId);
    },
    getMessages: conversationId => {
      const state = window.reduxStore.getState();
      const ids =
        state.conversations.messagesByConversation[conversationId]
          ?.messageIds ?? [];
      return ids
        .map(id => state.conversations.messagesLookup[id])
        .filter(m => m != null)
        .map(m => toCIMessage(m as MessageAttributesType));
    },
    getMessagesBySentAt: async sentAt => {
      const messages = await DataReader.getMessagesBySentAt(sentAt);
      return messages.map(toCIMessage);
    },
    getGapRows: async conversationId => {
      const ids = await DataReader.getZrdtGapMessageIds(conversationId);
      const out: Array<ZrdtCIMessageType> = [];
      for (const id of ids) {
        // oxlint-disable-next-line no-await-in-loop
        const message = await DataReader.getMessageById(id);
        if (message != null) {
          out.push(toCIMessage(message));
        }
      }
      return out;
    },
    heads: async conversationId =>
      (await zrdtService.heads(conversationId)).map(d => zrdtHex(d)),
    getCompareCode: async conversationId => {
      await actions().openCompare(conversationId);
      return zrdtState().compare?.ourCode;
    },
    comparePaste: async (conversationId, code) => {
      if (zrdtState().compare?.conversationId !== conversationId) {
        await actions().openCompare(conversationId);
      }
      await actions().comparePasted(code);
      return zrdtState().compare?.outcome;
    },
    askCompare: async () => {
      await actions().askCompare();
    },
    getCompareState: () => zrdtState().compare,
    closeCompare: () => {
      actions().closeCompare();
    },
    exportStore: async (conversationId, path) =>
      actions().exportConversation(conversationId, path),
    exportStoreFor: async (conversationId, memberAci, path) =>
      actions().exportConversationFor(conversationId, memberAci, path),
    importStore: async (conversationId, path) =>
      (await actions().importConversation(conversationId, path))?.status,
    setStrict: async (conversationId, strict) => {
      await actions().setStrict(conversationId, strict);
      return (
        window.ConversationController.get(conversationId)?.get('zrdtStrict') ===
        true
      );
    },
    keepWhatVerifies: async conversationId => {
      await actions().keepWhatVerifies(conversationId);
      return zrdtState().byConversation[conversationId]?.salvage;
    },
    getInternalResult: () => zrdtState().internalResult,
    catchUpState: async conversationId => {
      const state = getCatchUpState(conversationId);
      const [hasStore, relative] = await Promise.all([
        zrdtService.hasStore(conversationId),
        zrdtService.isRelative(conversationId),
      ]);
      return {
        hasStore,
        relative,
        reason: state?.reason,
        asked: [...(state?.asked ?? [])],
        answeredBy: state?.answeredBy,
        replies: state?.replies ?? 0,
        since: state?.since.length ?? 0,
      };
    },
    servedLog: conversationId => getServedLog(conversationId),
    react: async (conversationId, targetSentAt, emoji) => {
      const target = await findSentAt(conversationId, targetSentAt);
      if (!target) {
        return undefined;
      }
      await enqueueReactionForSend({
        emoji: emoji as Parameters<typeof enqueueReactionForSend>[0]['emoji'],
        messageId: target.id,
        remove: false,
      });
      const ourId = window.ConversationController.getOurConversationId();
      const ours = (target.get('reactions') ?? []).filter(
        r => r.fromId === ourId
      );
      return ours.length > 0
        ? Math.max(...ours.map(r => r.timestamp))
        : undefined;
    },
    pin: async (conversationId, targetSentAt) => {
      const target = await findSentAt(conversationId, targetSentAt);
      if (!target) {
        return undefined;
      }
      window.reduxActions.conversations.onPinnedMessageAdd(target.id, null);
      // The action saves the pin; wait for its row (pinnedAt is the send's
      // timestamp).
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop
        const pinned = (await DataReader.getAllPinnedMessages()).find(
          p => p.messageId === target.id
        );
        if (pinned) {
          return pinned.pinnedAt;
        }
        // oxlint-disable-next-line no-await-in-loop
        await sleep(100);
      }
      return undefined;
    },
    allMessages: async conversationId => {
      const all = await DataReader._getAllMessages();
      return all
        .filter(message => message.conversationId === conversationId)
        .map(toCIMessage);
    },
    memberAcis: conversationId =>
      (
        window.ConversationController.get(conversationId)?.get('membersV2') ??
        []
      ).map(member => member.aci),
    requestDigests: async (conversationId, responderAci, digests) =>
      requestDigestsFrom(conversationId, responderAci, digests),
    tables: async conversationId => {
      const [records, pending, boundary, provenance, relative] =
        await Promise.all([
          DataReader.getZrdtRecords(conversationId),
          DataReader.getZrdtPending(conversationId),
          DataReader.getZrdtBoundary(conversationId),
          DataReader.getZrdtProvenance(conversationId),
          zrdtService.isRelative(conversationId),
        ]);
      return {
        relative,
        records: records.map(row => zrdtHex(row.digest)),
        pending: pending.map(row => zrdtHex(row.digest)),
        boundary: boundary.map(row => ({
          digest: zrdtHex(row.digest),
          voucherAci: row.voucherAci,
        })),
        provenance: provenance.map(row => ({
          digest: zrdtHex(row.digest),
          kind: row.kind,
          byAci: row.byAci,
        })),
      };
    },
    scanMessages: async texts => {
      const all = await DataReader._getAllMessages();
      const hits = new Array<{
        text: string;
        id: string;
        type: string;
        where: string;
      }>();
      for (const message of all) {
        const places: Array<[string, string | undefined]> = [
          ['body', message.body],
          ['quote', message.quote?.text ?? undefined],
          ['opening', openingBody(message.zrdtOpening)],
        ];
        for (const text of texts) {
          for (const [where, value] of places) {
            if (value != null && value === text) {
              hits.push({ text, id: message.id, type: message.type, where });
            }
          }
        }
      }
      return { scanned: all.length, hits };
    },
  };
  setZrdtCIHooks(hooks);
}
