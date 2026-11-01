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
  importStore: (
    conversationId: string,
    path?: string
  ) => Promise<ZrdtOpenOutcome['status'] | undefined>;
  keepWhatVerifies: (conversationId: string) => Promise<unknown>;
  getInternalResult: () => string | undefined;
};

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
    importStore: async (conversationId, path) =>
      (await actions().importConversation(conversationId, path))?.status,
    keepWhatVerifies: async conversationId => {
      await actions().keepWhatVerifies(conversationId);
      return zrdtState().byConversation[conversationId]?.salvage;
    },
    getInternalResult: () => zrdtState().internalResult,
  };
  setZrdtCIHooks(hooks);
}
