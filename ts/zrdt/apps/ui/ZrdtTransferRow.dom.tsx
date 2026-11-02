// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import type { TailwindStyles } from '../../../axo/tw.dom.tsx';
import { tw } from '../../../axo/tw.dom.tsx';
import type {
  BtPhase,
  BtPieceView,
  BtTransferView,
} from '../bt/manager.std.ts';
import {
  DOWNLOAD,
  TRY_AGAIN,
  pieceTitle,
  resentSummaryText,
  statusText,
  subtitleText,
} from '../bt/manager.std.ts';

export type ZrdtTransferRowProps = Readonly<{
  transfer: BtTransferView;
  /** "Download" (an offered file) and "Try again" (a failed receive). */
  onDownload?: (id: string) => void;
  /** "Show in folder" for a saved file. */
  onShowFile?: (file: string) => void;
}>;

/** The state a piece cell shows; "missing" and "asking" read as repair. */
type Cell = 'waiting' | 'busy' | 'checked' | 'resent' | 'repair' | 'failed';

function cellOf(p: BtPieceView): Cell {
  switch (p.state) {
    case 'waiting':
      return 'waiting';
    case 'uploading':
    case 'fetching':
      return 'busy';
    case 'checked':
      return p.source.kind === 'member' ? 'resent' : 'checked';
    case 'missing':
    case 'asking':
      return 'repair';
    case 'unavailable':
      return 'failed';
    default:
      throw new Error('ZrdtTransferRow: unknown piece state');
  }
}

// Checked from the CDN or the author's file: green; resent by a member and
// checked: blue; being repaired: yellow; nobody had it: red.
const CELL_STYLES: Record<Cell, TailwindStyles> = {
  waiting: tw('size-3 rounded-sm bg-tertiary'),
  busy: tw('size-3 rounded-sm bg-accent-tint'),
  checked: tw('size-3 rounded-sm bg-affirmative'),
  resent: tw('size-3 rounded-sm bg-accent'),
  repair: tw('size-3 rounded-sm bg-warning-bright'),
  failed: tw('size-3 rounded-sm bg-destructive'),
};

const ACTIVE: ReadonlySet<BtPhase> = new Set([
  'uploading',
  'binding',
  'fetching',
  'repairing',
  'saving',
]);

function statusKindOf(phase: BtPhase): 'ok' | 'failed' | 'other' {
  if (phase === 'checked') {
    return 'ok';
  }
  return phase === 'failed' ? 'failed' : 'other';
}

const STATUS_STYLES: Record<'ok' | 'failed' | 'other', TailwindStyles> = {
  ok: tw('text-affirmative'),
  failed: tw('text-destructive'),
  other: tw('text-secondary'),
};

/**
 * One file in a group (BUILD_M1 §A.1): name, size and sender; one cell per
 * piece (checked, resent by a member, being repaired, failed); the status
 * line; "pieces 3, 12 and 15 resent by Bob"; and, for this user only,
 * "piece 7 from Dave failed its check".
 */
export function ZrdtTransferRow(props: ZrdtTransferRowProps): ReactElement {
  const { transfer: t, onDownload, onShowFile } = props;
  const statusKind = statusKindOf(t.phase);
  const canRetry =
    t.direction === 'in' &&
    (t.phase === 'offered' || t.phase === 'failed') &&
    onDownload != null;
  return (
    <div
      className={tw(
        'my-1 flex flex-col gap-1 rounded-lg bg-surface-secondary p-2'
      )}
      data-testid="ZrdtTransferRow"
      data-phase={t.phase}
      data-file={t.announcement}
    >
      <div className={tw('flex items-center gap-2')}>
        {ACTIVE.has(t.phase) && (
          <span className="ZrdtSpinner" aria-hidden="true" />
        )}
        <span className={tw('font-semibold')}>{t.name ?? 'A file'}</span>
        <span className={tw('text-secondary')}>{subtitleText(t)}</span>
      </div>
      {t.pieces.length > 0 && (
        <ul
          className={tw('m-0 flex list-none flex-wrap gap-0.5 p-0')}
          aria-label="Pieces"
        >
          {t.pieces.map((p, index) => (
            <li
              // Pieces never move: the index is the identity.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className={CELL_STYLES[cellOf(p)]}
              title={pieceTitle(index, p)}
              data-piece={index + 1}
              data-state={p.state}
            />
          ))}
        </ul>
      )}
      <div className={STATUS_STYLES[statusKind]} role="status">
        {statusText(t)}
      </div>
      {t.resent.length > 0 && (
        <div className={tw('flex flex-wrap gap-1')}>
          {t.resent.map(r => (
            <span key={r.member.aci} className="ZrdtLabel ZrdtLabel--relayed">
              {resentSummaryText(r)}
            </span>
          ))}
        </div>
      )}
      {t.notices.map(notice => (
        <div
          key={notice}
          className="ZrdtBanner ZrdtBanner--error"
          role="alert"
          data-testid="ZrdtTransferNotice"
        >
          <span className="ZrdtBanner__text">{notice}</span>
        </div>
      ))}
      {(canRetry || (t.savedTo != null && onShowFile != null)) && (
        <div className={tw('flex gap-2')}>
          {canRetry && (
            <button
              type="button"
              className="ZrdtButton"
              onClick={() => onDownload(t.id)}
            >
              {t.phase === 'offered' ? DOWNLOAD : TRY_AGAIN}
            </button>
          )}
          {t.savedTo != null && onShowFile != null && (
            <button
              type="button"
              className="ZrdtButton"
              onClick={() => onShowFile(t.savedTo ?? '')}
            >
              Show in folder
            </button>
          )}
        </div>
      )}
    </div>
  );
}
