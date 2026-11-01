// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import type { ZrdtRejectReason } from './labels.std.ts';
import type { ZrdtDigestHex } from './words.std.ts';
import {
  IMPORT_A_COPY,
  KEEP_WHAT_VERIFIES,
  rejectedText,
  salvageReportText,
} from './labels.std.ts';

export type ZrdtSalvageReport = Readonly<{
  kept: number;
  dropped: ReadonlyArray<ZrdtDigestHex>;
}>;

export type ZrdtRejectedBannerProps = Readonly<{
  /** Why OPEN (or MERGE of an import) failed. */
  reason: ZrdtRejectReason;
  /** Set after "Keep what verifies" (SALVAGE): shows kept and dropped. */
  salvage?: ZrdtSalvageReport;
  /** True while SALVAGE or an import runs; disables the buttons. */
  busy?: boolean;
  onKeepWhatVerifies: () => void;
  onImportCopy: () => void;
  /** Shown only with a salvage report. */
  onDismiss?: () => void;
}>;

/**
 * Conversation-level banner (APP.md §6 Startup, §7). It names what is
 * missing, not who is at fault: a corrupted or truncated copy fails the same
 * way.
 */
export function ZrdtRejectedBanner(
  props: ZrdtRejectedBannerProps
): ReactElement {
  const { reason, salvage, busy, onKeepWhatVerifies, onImportCopy, onDismiss } =
    props;
  if (salvage != null) {
    return (
      <div className="ZrdtBanner ZrdtBanner--info" role="status">
        <span className="ZrdtBanner__text">
          {salvageReportText(salvage.kept, salvage.dropped)}
        </span>
        {onDismiss != null && (
          <button type="button" className="ZrdtButton" onClick={onDismiss}>
            OK
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="ZrdtBanner ZrdtBanner--error" role="alert">
      <span className="ZrdtBanner__text">{rejectedText(reason)}</span>
      <button
        type="button"
        className="ZrdtButton"
        onClick={onKeepWhatVerifies}
        disabled={busy === true}
      >
        {KEEP_WHAT_VERIFIES}
      </button>
      <button
        type="button"
        className="ZrdtButton"
        onClick={onImportCopy}
        disabled={busy === true}
      >
        {IMPORT_A_COPY}
      </button>
    </div>
  );
}
