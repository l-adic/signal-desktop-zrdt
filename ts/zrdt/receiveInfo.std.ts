// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// What MessageReceiver's zrdt step (receive.preload.ts) hands to
// handleDataMessage on the ProcessedDataMessage (`zrdtReceive`). Not saved:
// handleDataMessage copies the parts that are message attributes.

export type ZrdtReceiveInfo = Readonly<{
  conversationId: string;
  // The record's hex digest: accepted, or waiting in zrdt_pending (the
  // service drains it once its links arrive).
  digest?: string;
  // base64(nonce ‖ DataMessage without fields 15 and 200)
  opening?: string;
  // MISSING: the hex digests the record links and nobody here holds (records
  // waiting in zrdt_pending are left out). A gap row is placed for them.
  missing?: ReadonlyArray<string>;
  // The received_at (and _ms) of that gap row (APP.md §6, placement).
  gapReceivedAt?: number;
  gapReceivedAtMs?: number;
  // Gap rows that were waiting for this digest; the message takes the first
  // one's received_at and they resolve once it is saved.
  resolvesGapIds?: ReadonlyArray<string>;
}>;
