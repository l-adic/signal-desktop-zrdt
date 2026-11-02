// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ZrdtDigestHex } from './words.std.ts';
import {
  ASK_AGAIN,
  ASK_FOR_IT,
  COPY_COMPARE_CODE,
  PASTE_COMPARE_CODE,
  identicalText,
  invalidCodeText,
  theyAreBehindText,
  withheldText,
  youAreBehindText,
} from './labels.std.ts';
import { copyToClipboard } from './clipboard.dom.ts';

/**
 * What the parent tells the modal after it parsed the pasted code, asked the
 * backend (HAS) and, for "you-are-behind", sent its requests.
 */
export type ZrdtCompareOutcome =
  | Readonly<{ kind: 'identical' }>
  | Readonly<{ kind: 'they-are-behind' }>
  | Readonly<{
      kind: 'you-are-behind';
      missing: ReadonlyArray<ZrdtDigestHex>;
      /** A request is out and the timeout has not passed yet. */
      asking: boolean;
    }>
  | Readonly<{
      /** Still missing after the timeout: "Asked; no answer." */
      kind: 'withheld';
      missing: ReadonlyArray<ZrdtDigestHex>;
    }>
  | Readonly<{
      kind: 'invalid-code';
      error: 'not-a-compare-code' | 'bad-digest' | 'other-chat';
    }>;

export type ZrdtCompareModalProps = Readonly<{
  /** Our compare code (encodeCompareCode), copied verbatim. */
  ourCode: string;
  /** >= 12 words of SHA-256(sorted heads) (headsFingerprintWords). */
  ourWords: ReadonlyArray<string>;
  /** Display name of the pasted code's owner, once parsed. */
  theirName?: string;
  /** The pasted code's fingerprint words, once parsed. */
  theirWords?: ReadonlyArray<string>;
  outcome?: ZrdtCompareOutcome;
  /** The user pasted (or edited) a code; the parent parses and compares. */
  onCompare: (pastedCode: string) => void;
  /** "Ask for it" and "Ask again": request the outcome's missing digests. */
  onAsk: () => void;
  onClose: () => void;
  /** Defaults to navigator.clipboard.writeText. */
  onCopy?: (text: string) => void;
}>;

const OUTCOME_CLASS_NAMES: Record<ZrdtCompareOutcome['kind'], string> = {
  identical: 'ZrdtCompare__outcome ZrdtCompare__outcome--identical',
  'they-are-behind':
    'ZrdtCompare__outcome ZrdtCompare__outcome--they-are-behind',
  'you-are-behind': 'ZrdtCompare__outcome ZrdtCompare__outcome--you-are-behind',
  withheld: 'ZrdtCompare__outcome ZrdtCompare__outcome--withheld',
  'invalid-code': 'ZrdtCompare__outcome ZrdtCompare__outcome--invalid-code',
};

function OutcomeView(
  props: Readonly<{
    outcome: ZrdtCompareOutcome;
    theirName: string;
    onAsk: () => void;
  }>
): ReactElement {
  const { outcome, theirName, onAsk } = props;
  let text: string;
  let action: ReactElement | null = null;
  switch (outcome.kind) {
    case 'identical':
      text = identicalText(theirName);
      break;
    case 'they-are-behind':
      text = theyAreBehindText(theirName);
      break;
    case 'you-are-behind':
      text = youAreBehindText(theirName, outcome.missing);
      action = outcome.asking ? (
        <span className="ZrdtSpinner" aria-label="Asking" />
      ) : (
        <button type="button" className="ZrdtButton" onClick={onAsk}>
          {ASK_FOR_IT}
        </button>
      );
      break;
    case 'withheld':
      text = withheldText(theirName, outcome.missing);
      action = (
        <button type="button" className="ZrdtButton" onClick={onAsk}>
          {ASK_AGAIN}
        </button>
      );
      break;
    case 'invalid-code':
      text = invalidCodeText(outcome.error);
      break;
    default:
      throw new Error('ZrdtCompareModal: unknown outcome');
  }
  return (
    <div className={OUTCOME_CLASS_NAMES[outcome.kind]} role="status">
      <span className="ZrdtCompare__outcome-text">{text}</span>
      {action}
    </div>
  );
}

/**
 * Compare screen (APP.md §7 "Compare"). Pure presentation: the parent
 * supplies the codes, the words, the outcome and the callbacks.
 */
export function ZrdtCompareModal(props: ZrdtCompareModalProps): ReactElement {
  const {
    ourCode,
    ourWords,
    theirName,
    theirWords,
    outcome,
    onCompare,
    onAsk,
    onClose,
    onCopy,
  } = props;
  const titleId = useId();
  const pasteId = useId();
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);

  // The paste box has focus on open, so Cmd+V works at once (beats 1, 3).
  useEffect(() => {
    pasteRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleCopy = useCallback(() => {
    if (onCopy != null) {
      onCopy(ourCode);
    } else {
      void copyToClipboard(ourCode);
    }
    setCopied(true);
  }, [onCopy, ourCode]);

  const handleCompare = useCallback(() => {
    if (pasted.trim().length > 0) {
      onCompare(pasted);
    }
  }, [onCompare, pasted]);

  const wordsEqual =
    theirWords != null && theirWords.join(' ') === ourWords.join(' ');

  return (
    <div className="ZrdtModal__overlay">
      <div
        className="ZrdtModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="ZrdtModal__title">
          Compare this chat
        </h2>

        <section className="ZrdtCompare__section">
          <h3 className="ZrdtCompare__heading">Your compare code</h3>
          <textarea
            className="ZrdtCompare__code"
            readOnly
            value={ourCode}
            rows={3}
            aria-label="Your compare code"
          />
          <div className="ZrdtCompare__row">
            <button type="button" className="ZrdtButton" onClick={handleCopy}>
              {COPY_COMPARE_CODE}
            </button>
            {copied && <span className="ZrdtCompare__hint">Copied</span>}
          </div>
          <div className="ZrdtCompare__words-label">
            Equal? Read these words to each other:
          </div>
          <div className="ZrdtWords">{ourWords.join(' ')}</div>
        </section>

        <section className="ZrdtCompare__section">
          <label htmlFor={pasteId} className="ZrdtCompare__heading">
            {PASTE_COMPARE_CODE}
          </label>
          <textarea
            id={pasteId}
            ref={pasteRef}
            className="ZrdtCompare__code"
            value={pasted}
            rows={3}
            placeholder="zrdt1:…"
            onChange={event => setPasted(event.target.value)}
            onPaste={event => {
              const text = event.clipboardData.getData('text');
              if (text.trim().length > 0) {
                event.preventDefault();
                setPasted(text);
                onCompare(text);
              }
            }}
          />
          <div className="ZrdtCompare__row">
            <button
              type="button"
              className="ZrdtButton"
              onClick={handleCompare}
              disabled={pasted.trim().length === 0}
            >
              Compare
            </button>
          </div>
          {theirWords != null && (
            <>
              <div className="ZrdtCompare__words-label">
                {theirName != null ? `${theirName}'s words` : 'Their words'}
                {wordsEqual ? ' (same as yours):' : ' (different from yours):'}
              </div>
              <div className="ZrdtWords">{theirWords.join(' ')}</div>
            </>
          )}
          {outcome != null && (
            <OutcomeView
              outcome={outcome}
              theirName={theirName ?? 'This member'}
              onAsk={onAsk}
            />
          )}
        </section>

        <div className="ZrdtModal__footer">
          <button type="button" className="ZrdtButton" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
