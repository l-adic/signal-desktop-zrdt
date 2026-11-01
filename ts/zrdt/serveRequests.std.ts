// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The requester's side of SERVE (zrdt docs/JOIN_PLAN.md section 4.4): the
// requests this device sent, and the checks a sealed reply must pass before
// anything in it reaches zrdtd. Pure; resend.preload.ts supplies Signal state.
//
// A reply is taken only if all of these hold, and dropped otherwise:
// - its header names this account's ACI and the tag of this account's
//   identity key (and it opens under that key: checked by the caller);
// - its request id is one this device sent and has not completed (other
//   devices of the account receive the reply too, and drop it);
// - it came from the member the request went to;
// - that member's identity key has not changed since the request was sent.

import type { ServeMode } from './ZrdtBackend.std.ts';
import { aciHex, aciStringHex } from './audience.std.ts';

/** How long a request waits for its reply (a late reply is dropped). */
export const SERVE_REQUEST_TTL_MS = 15 * 60 * 1000;

export type OutstandingServeRequest = Readonly<{
  /** 16 bytes, hex. */
  requestId: string;
  conversationId: string;
  /** The member asked, an ACI string. */
  responderAci: string;
  /** The responder's identity key when the request was sent (hex), if known. */
  responderKey: string | undefined;
  mode: ServeMode;
  /** The wanted digests (hex); empty for a catch-up. */
  digests: ReadonlyArray<string>;
  sentAt: number;
}>;

export type ServedReplyCheck =
  | Readonly<{ ok: true; request: OutstandingServeRequest }>
  | Readonly<{
      ok: false;
      reason:
        | 'notForUs'
        | 'notOurKey'
        | 'unsolicited'
        | 'wrongResponder'
        | 'wrongChat'
        | 'responderKeyChanged';
    }>;

/** The requests this device sent and has not completed. In memory only. */
export class ServeRequestBook {
  readonly #byId = new Map<string, OutstandingServeRequest>();

  add(request: OutstandingServeRequest): void {
    this.#byId.set(request.requestId, request);
  }

  get(requestId: string): OutstandingServeRequest | undefined {
    return this.#byId.get(requestId);
  }

  /** The request is answered: a second reply to it is dropped. */
  complete(requestId: string): void {
    this.#byId.delete(requestId);
  }

  /** Drops requests older than the TTL. */
  expire(now: number, ttlMs: number = SERVE_REQUEST_TTL_MS): void {
    for (const [id, request] of this.#byId) {
      if (now - request.sentAt > ttlMs) {
        this.#byId.delete(id);
      }
    }
  }

  get size(): number {
    return this.#byId.size;
  }
}

function sameHex(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>
): boolean {
  return aciHex(a) === aciHex(b);
}

/**
 * The §4.4 checks on a reply's header and origin, before it is opened.
 * `ourKeyTag` is the tag of this account's identity key; `responderKeyNow`
 * the key this device holds for the sender now (hex), if any.
 */
export function checkServedReply({
  book,
  now,
  headerAci,
  headerKeyTag,
  headerRequestId,
  conversationId,
  ourAci,
  ourKeyTag,
  senderAci,
  responderKeyNow,
}: Readonly<{
  book: ServeRequestBook;
  now: number;
  headerAci: Uint8Array<ArrayBuffer>;
  headerKeyTag: Uint8Array<ArrayBuffer>;
  headerRequestId: Uint8Array<ArrayBuffer>;
  conversationId: string | undefined;
  ourAci: string;
  ourKeyTag: Uint8Array<ArrayBuffer>;
  senderAci: string;
  responderKeyNow: string | undefined;
}>): ServedReplyCheck {
  if (aciHex(headerAci) !== aciStringHex(ourAci)) {
    return { ok: false, reason: 'notForUs' };
  }
  if (!sameHex(headerKeyTag, ourKeyTag)) {
    return { ok: false, reason: 'notOurKey' };
  }
  book.expire(now);
  const request = book.get(aciHex(headerRequestId));
  if (request === undefined) {
    return { ok: false, reason: 'unsolicited' };
  }
  if (aciStringHex(request.responderAci) !== aciStringHex(senderAci)) {
    return { ok: false, reason: 'wrongResponder' };
  }
  if (request.conversationId !== conversationId) {
    return { ok: false, reason: 'wrongChat' };
  }
  if (
    request.responderKey === undefined ||
    request.responderKey !== responderKeyNow
  ) {
    return { ok: false, reason: 'responderKeyChanged' };
  }
  return { ok: true, request };
}
