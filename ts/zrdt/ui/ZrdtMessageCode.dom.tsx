// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import { useCallback, useState } from 'react';
import type { ZrdtDigestHex } from './words.std.ts';
import { DEFAULT_WORD_COUNT, digestToWords, formatTag } from './words.std.ts';
import { copyToClipboard } from './clipboard.dom.ts';

export type ZrdtCodeDetailProps = Readonly<{
  digest: ZrdtDigestHex;
  /** >= 12; defaults to 12 (covers the digest's first 128 bits). */
  wordCount?: number;
  /** Gets the full 64-char hex digest. Defaults to the clipboard. */
  onCopy?: (digest: ZrdtDigestHex) => void;
}>;

/** Expanded per-message code: the digest as words, with "Copy" (full digest). */
export function ZrdtCodeDetail(props: ZrdtCodeDetailProps): ReactElement {
  const { digest, wordCount = DEFAULT_WORD_COUNT, onCopy } = props;
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    if (onCopy != null) {
      onCopy(digest);
    } else {
      void copyToClipboard(digest);
    }
    setCopied(true);
  }, [digest, onCopy]);
  return (
    <div className="ZrdtCodeDetail">
      <div className="ZrdtWords">
        {digestToWords(digest, Math.max(wordCount, DEFAULT_WORD_COUNT)).join(
          ' '
        )}
      </div>
      <div className="ZrdtCodeDetail__digest" title={digest}>
        {digest}
      </div>
      <button type="button" className="ZrdtButton" onClick={handleCopy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export type ZrdtMessageCodeProps = Readonly<{
  digest: ZrdtDigestHex;
  onCopy?: (digest: ZrdtDigestHex) => void;
}>;

/**
 * The 4-char tag in a message's metadata line ("·9ac1"). Clicking it shows
 * ZrdtCodeDetail below the tag.
 */
export function ZrdtMessageCode(props: ZrdtMessageCodeProps): ReactElement {
  const { digest, onCopy } = props;
  const [open, setOpen] = useState(false);
  return (
    <span className="ZrdtMessageCode">
      <button
        type="button"
        className="ZrdtMessageCode__tag"
        aria-expanded={open}
        title="Message code"
        onClick={event => {
          // Do not open the message's own click handlers (e.g. details).
          event.stopPropagation();
          setOpen(value => !value);
        }}
      >
        {formatTag(digest)}
      </button>
      {open && (
        <span className="ZrdtMessageCode__popover">
          <ZrdtCodeDetail digest={digest} onCopy={onCopy} />
        </span>
      )}
    </span>
  );
}
