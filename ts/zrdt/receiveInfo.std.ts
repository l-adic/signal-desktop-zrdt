// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// What MessageReceiver's zrdt step (receive.preload.ts) hands to
// handleDataMessage on the ProcessedDataMessage (`zrdtReceive`). Not saved:
// handleDataMessage copies the parts that are message attributes.

export type ZrdtReceiveInfo = Readonly<{
  conversationId: string;
  // ACCEPTED: hex digest and base64 opening (nonce ‖ DataMessage without
  // fields 15 and 200).
  digest?: string;
  opening?: string;
  // MISSING: the hex digests the record links and we lack.
  missing?: ReadonlyArray<string>;
  // MISSING: the message's received_at before the restamp; the gap row takes
  // it (APP.md §6, timeline placement).
  gapReceivedAt?: number;
  gapReceivedAtMs?: number;
  // MISSING: key of the in-memory pending entry, to attach the message id.
  pendingKey?: string;
  // ACCEPTED: gap rows that were waiting for this digest; the message takes
  // the first one's received_at and they resolve.
  resolvesGapIds?: ReadonlyArray<string>;
}>;
