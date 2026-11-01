// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/** Default copy action for zrdt components when the parent passes no onCopy. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // The renderer may lack clipboard permission; the code stays selectable.
    // oxlint-disable-next-line no-console
    console.warn('zrdt: copy to clipboard failed', error);
  }
}
