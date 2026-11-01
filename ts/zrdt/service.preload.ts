// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// PLACEHOLDER (lane T3). Lane T0 owns this module; on merge, take T0's file
// and drop this one. It only declares the shared contract so the UI lane
// typechecks before T0 lands. Every call except init/backendInfo throws.
// Bytes are `Uint8Array<ArrayBuffer>`: the repo's lint rules forbid both a
// bare `Uint8Array` and `Uint8Array<ArrayBufferLike>`. The UI accepts either.
/* oxlint-disable signal-desktop/enforce-file-suffix */

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
      digest: Uint8Array<ArrayBuffer>;
      record: Uint8Array<ArrayBuffer>;
      opening?: Uint8Array<ArrayBuffer>;
    }
  | { status: 'missing'; digests: Array<Uint8Array<ArrayBuffer>> }
  | { status: 'collision'; digest: Uint8Array<ArrayBuffer> }
  | { status: 'wrongChat' }
  | { status: 'tooLarge' }
  | { status: 'malformed' }
  | { status: 'badOpening' };
export type ZrdtOpenOutcome =
  | { status: 'ok' }
  | {
      status: 'unverifiable';
      unverifiable: Array<Uint8Array<ArrayBuffer>>;
      missing: Array<Uint8Array<ArrayBuffer>>;
    }
  | { status: 'malformed' | 'tooLarge' | 'wrongChat' }
  | { status: 'collision'; digest: Uint8Array<ArrayBuffer> };
export type ZrdtServiceType = {
  init(): Promise<void>;
  backendInfo(): {
    kind: 'lean' | 'stub';
    version: string;
    available: boolean;
  };
  ensureConversation(
    conversationId: string,
    groupId: Uint8Array<ArrayBuffer>
  ): Promise<void>;
  heads(conversationId: string): Promise<Array<Uint8Array<ArrayBuffer>>>;
  disownSet(conversationId: string): Promise<Array<Uint8Array<ArrayBuffer>>>;
  acceptOwn(
    conversationId: string,
    a: {
      groupId: Uint8Array<ArrayBuffer>;
      authorAci: Uint8Array<ArrayBuffer>;
      nonce: Uint8Array<ArrayBuffer>;
      dataMessageBytes: Uint8Array<ArrayBuffer>;
      links: Array<Uint8Array<ArrayBuffer>>;
    }
  ): Promise<{
    digest: Uint8Array<ArrayBuffer>;
    record: Uint8Array<ArrayBuffer>;
    opening: Uint8Array<ArrayBuffer>;
  }>;
  acceptIncoming(
    conversationId: string,
    a: {
      groupId: Uint8Array<ArrayBuffer>;
      authorAci: Uint8Array<ArrayBuffer>;
      nonce: Uint8Array<ArrayBuffer>;
      dataMessageBytes: Uint8Array<ArrayBuffer>;
      links: Array<Uint8Array<ArrayBuffer>>;
      provenance: ZrdtProvenance;
    }
  ): Promise<ZrdtAcceptOutcome>;
  acceptRecord(
    conversationId: string,
    a: {
      record: Uint8Array<ArrayBuffer>;
      opening?: Uint8Array<ArrayBuffer>;
      provenance: ZrdtProvenance;
    }
  ): Promise<ZrdtAcceptOutcome>;
  has(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>
  ): Promise<boolean>;
  get(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>
  ): Promise<
    | {
        record: Uint8Array<ArrayBuffer>;
        authorAci: Uint8Array<ArrayBuffer>;
        links: Array<Uint8Array<ArrayBuffer>>;
        commit: Uint8Array<ArrayBuffer>;
      }
    | undefined
  >;
  reachSet(
    conversationId: string,
    from: Array<Uint8Array<ArrayBuffer>>
  ): Promise<Array<Uint8Array<ArrayBuffer>>>;
  classify(conversationId: string): Promise<Map<string, ZrdtStatus>>;
  markDisowned(
    conversationId: string,
    digest: Uint8Array<ArrayBuffer>,
    byAci: string
  ): Promise<void>;
  exportBlob(conversationId: string): Promise<Uint8Array<ArrayBuffer>>;
  importBlob(
    conversationId: string,
    blob: Uint8Array<ArrayBuffer>
  ): Promise<ZrdtOpenOutcome>;
  salvageBlob(
    conversationId: string,
    blob: Uint8Array<ArrayBuffer>
  ): Promise<
    | {
        dropped: Array<Uint8Array<ArrayBuffer>>;
        missing: Array<Uint8Array<ArrayBuffer>>;
      }
    | ZrdtOpenOutcome
  >;
};

function notYet(): never {
  throw new Error('zrdt service: placeholder (lane T0 not merged)');
}

export const zrdtEvents = new EventEmitter();

export const zrdtService: ZrdtServiceType = {
  init: async () => undefined,
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
