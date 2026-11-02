// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import type { ZrdtBackendKind } from './labels.std.ts';
import { backendBadgeText, backendBadgeTooltip } from './labels.std.ts';

export type ZrdtBackendBadgeProps = Readonly<{
  kind: ZrdtBackendKind;
  /** From VERSION: protocol version and git hash, e.g. "1 (ab12cd3)". */
  version: string;
  /** False while zrdtd is down. Defaults to true. */
  available?: boolean;
  /** Fixed in the window's bottom corner, so it is always on screen. */
  floating?: boolean;
}>;

const KIND_CLASS_NAMES: Record<ZrdtBackendKind, string> = {
  lean: 'ZrdtBackendBadge ZrdtBackendBadge--lean',
  stub: 'ZrdtBackendBadge ZrdtBackendBadge--stub',
};

/** The backend's kind and version, always on screen (APP.md §7, §9 checklist). */
export function ZrdtBackendBadge(props: ZrdtBackendBadgeProps): ReactElement {
  const { kind, version, available = true, floating = false } = props;
  const badge = (
    <span
      className={
        available
          ? KIND_CLASS_NAMES[kind]
          : 'ZrdtBackendBadge ZrdtBackendBadge--down'
      }
      title={backendBadgeTooltip(kind)}
    >
      {backendBadgeText(kind, version, available)}
    </span>
  );
  if (floating) {
    return <div className="ZrdtBackendBadge__floating">{badge}</div>;
  }
  return badge;
}
