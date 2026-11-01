// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

/* oxlint-disable */
// PLACEHOLDER (lane T2): the shared service contract, so the receive path
// compiles before lane T0 lands. T0 owns this file; on merge take T0's
// version. Every method throws until then.

import { EventEmitter } from 'node:events';

export type ZrdtStatus =
  | { kind: 'confirmedByAuthor' }
  | { kind: 'heldBy'; aci: string }
  | { kind: 'unconfirmed' }
  | { kind: 'notConfirmedByAuthor' };
export type ZrdtProvenance =
  | { kind: 'live' }
  | { kind: 'relayed'; byAci: string }
  | { kind: 'imported' };
export type ZrdtAcceptOutcome =
  | {
      status: 'accepted';
      digest: Uint8Array;
      record: Uint8Array;
      opening?: Uint8Array;
    }
  | { status: 'missing'; digests: Array<Uint8Array> }
  | { status: 'collision'; digest: Uint8Array }
  | { status: 'wrongChat' }
  | { status: 'tooLarge' }
  | { status: 'malformed' }
  | { status: 'badOpening' };
export type ZrdtOpenOutcome =
  | { status: 'ok' }
  | {
      status: 'unverifiable';
      unverifiable: Array<Uint8Array>;
      missing: Array<Uint8Array>;
    }
  | { status: 'malformed' | 'tooLarge' | 'wrongChat' }
  | { status: 'collision'; digest: Uint8Array };
export interface ZrdtServiceType {
  init(): Promise<void>;
  backendInfo(): {
    kind: 'lean' | 'stub';
    version: string;
    available: boolean;
  };
  ensureConversation(
    conversationId: string,
    groupId: Uint8Array
  ): Promise<void>;
  heads(conversationId: string): Promise<Array<Uint8Array>>;
  disownSet(conversationId: string): Promise<Array<Uint8Array>>;
  acceptOwn(
    conversationId: string,
    a: {
      groupId: Uint8Array;
      authorAci: Uint8Array;
      nonce: Uint8Array;
      dataMessageBytes: Uint8Array;
      links: Array<Uint8Array>;
    }
  ): Promise<{ digest: Uint8Array; record: Uint8Array; opening: Uint8Array }>;
  acceptIncoming(
    conversationId: string,
    a: {
      groupId: Uint8Array;
      authorAci: Uint8Array;
      nonce: Uint8Array;
      dataMessageBytes: Uint8Array;
      links: Array<Uint8Array>;
      provenance: ZrdtProvenance;
    }
  ): Promise<ZrdtAcceptOutcome>;
  acceptRecord(
    conversationId: string,
    a: { record: Uint8Array; opening?: Uint8Array; provenance: ZrdtProvenance }
  ): Promise<ZrdtAcceptOutcome>;
  has(conversationId: string, digest: Uint8Array): Promise<boolean>;
  get(
    conversationId: string,
    digest: Uint8Array
  ): Promise<
    | {
        record: Uint8Array;
        authorAci: Uint8Array;
        links: Array<Uint8Array>;
        commit: Uint8Array;
      }
    | undefined
  >;
  reachSet(
    conversationId: string,
    from: Array<Uint8Array>
  ): Promise<Array<Uint8Array>>;
  classify(conversationId: string): Promise<Map<string, ZrdtStatus>>;
  markDisowned(
    conversationId: string,
    digest: Uint8Array,
    byAci: string
  ): Promise<void>;
  exportBlob(conversationId: string): Promise<Uint8Array>;
  importBlob(
    conversationId: string,
    blob: Uint8Array
  ): Promise<ZrdtOpenOutcome>;
  salvageBlob(
    conversationId: string,
    blob: Uint8Array
  ): Promise<
    { dropped: Array<Uint8Array>; missing: Array<Uint8Array> } | ZrdtOpenOutcome
  >;
}

function notYet(): never {
  throw new Error('zrdt service: placeholder (lane T0 not merged)');
}

export const zrdtService: ZrdtServiceType = {
  init: async () => notYet(),
  backendInfo: () => ({
    kind: 'stub',
    version: 'placeholder',
    available: false,
  }),
  ensureConversation: async () => notYet(),
  heads: async () => notYet(),
  disownSet: async () => notYet(),
  acceptOwn: async () => notYet(),
  acceptIncoming: async () => notYet(),
  acceptRecord: async () => notYet(),
  has: async () => notYet(),
  get: async () => notYet(),
  reachSet: async () => notYet(),
  classify: async () => notYet(),
  markDisowned: async () => notYet(),
  exportBlob: async () => notYet(),
  importBlob: async () => notYet(),
  salvageBlob: async () => notYet(),
};

export const zrdtEvents: EventEmitter = new EventEmitter();
