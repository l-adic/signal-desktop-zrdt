// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// PLACEHOLDER (lane T3). Lane T2 owns this module; on merge, take T2's file
// and drop this one.
/* oxlint-disable signal-desktop/enforce-file-suffix */

export async function requestMissing(
  _conversationId: string,
  _digests: Array<Uint8Array<ArrayBuffer>>,
  _firstAskAci?: string
): Promise<void> {
  throw new Error('zrdt resend: placeholder (lane T2 not merged)');
}
