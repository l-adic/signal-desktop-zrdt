// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import type { ZrdtDigestHex } from './words.std.ts';
import { unconfirmedSectionTitle } from './labels.std.ts';
import { formatTag } from './words.std.ts';

export type ZrdtUnconfirmedItem = Readonly<{
  digest: ZrdtDigestHex;
  /** The author the record claims, as a display name. Shown small and grey. */
  attributedTo: string;
  /** Plain message text; undefined when only the structure is held. */
  text?: string;
  sentAt?: number;
}>;

export type ZrdtUnconfirmedSectionProps = Readonly<{
  items: ReadonlyArray<ZrdtUnconfirmedItem>;
  /** Uncontrolled initial state; collapsed by default. */
  defaultExpanded?: boolean;
}>;

function itemMeta(item: ZrdtUnconfirmedItem): string {
  const parts = [formatTag(item.digest), `attributed to ${item.attributedTo}`];
  if (item.sentAt != null) {
    parts.push(new Date(item.sentAt).toLocaleString());
  }
  return parts.join(' \u00b7 ');
}

/**
 * Imported or salvaged records that no member has confirmed yet (APP.md §7,
 * RESTORE_PLAN.md). One collapsed section, never inline under a member's
 * name: no avatars, and text is rendered as plain text, so no live links.
 */
export function ZrdtUnconfirmedSection(
  props: ZrdtUnconfirmedSectionProps
): ReactElement | null {
  const { items, defaultExpanded = false } = props;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="ZrdtUnconfirmed">
      <button
        type="button"
        className="ZrdtUnconfirmed__toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded(value => !value)}
      >
        <span className="ZrdtUnconfirmed__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        {unconfirmedSectionTitle(items.length)}
      </button>
      {expanded && (
        <ul id={listId} className="ZrdtUnconfirmed__list">
          {items.map(item => (
            <li key={item.digest} className="ZrdtUnconfirmed__item">
              <div className="ZrdtUnconfirmed__meta">{itemMeta(item)}</div>
              <div className="ZrdtUnconfirmed__text">
                {item.text ?? '(content unavailable)'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
