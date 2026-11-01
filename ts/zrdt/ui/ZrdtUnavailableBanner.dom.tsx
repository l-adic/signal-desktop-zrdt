// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import { UNAVAILABLE_TEXT } from './labels.std.ts';

export type ZrdtUnavailableBannerProps = Readonly<{
  /** e.g. "zrdtd exited with code 1"; shown small after the main text. */
  detail?: string;
  onRetry?: () => void;
}>;

/** Shown in the banner slot while zrdtd is down (PLAN.md §3.3, host side). */
export function ZrdtUnavailableBanner(
  props: ZrdtUnavailableBannerProps
): ReactElement {
  const { detail, onRetry } = props;
  return (
    <div className="ZrdtBanner ZrdtBanner--warning" role="alert">
      <span className="ZrdtBanner__text">{UNAVAILABLE_TEXT}</span>
      {detail != null && <span className="ZrdtBanner__detail">{detail}</span>}
      {onRetry != null && (
        <button type="button" className="ZrdtButton" onClick={onRetry}>
          Restart
        </button>
      )}
    </div>
  );
}
