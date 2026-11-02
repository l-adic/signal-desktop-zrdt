// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';
import { tw } from '../../../axo/tw.dom.tsx';
import type { BtShareQuestion } from '../bt/manager.std.ts';
import {
  CANCEL,
  SHARE,
  SHARE_A_FILE,
  SHARE_EXPLAINER,
  shareQuestion,
} from '../bt/manager.std.ts';

export type ZrdtShareFileDialogProps = Readonly<{
  question: Omit<BtShareQuestion, 'conversationId'>;
  onShare: () => void;
  onCancel: () => void;
}>;

/**
 * The fork's own share dialog (BUILD_M1 §A.1 step 1, §B.10): "Share trip.mp4
 * (20 MiB) with Camping (4 members)?". Nothing is uploaded or sent before
 * Share; Escape and Cancel decline. `zbt share` waits on it.
 */
export function ZrdtShareFileDialog(
  props: ZrdtShareFileDialogProps
): ReactElement {
  const { question, onShare, onCancel } = props;
  const titleId = useId();
  const textId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="ZrdtModal__overlay">
      <div
        className="ZrdtModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        data-testid="ZrdtShareFileDialog"
      >
        <h2 id={titleId} className="ZrdtModal__title">
          {SHARE_A_FILE}
        </h2>
        <p id={textId} className={tw('my-2 font-semibold')}>
          {shareQuestion(question)}
        </p>
        <p className={tw('my-2 text-secondary')}>{SHARE_EXPLAINER}</p>
        <div className="ZrdtModal__footer">
          <div className={tw('flex gap-2')}>
            <button type="button" className="ZrdtButton" onClick={onCancel}>
              {CANCEL}
            </button>
            <button type="button" className="ZrdtButton" onClick={onShare}>
              {SHARE}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type Pending = Readonly<{
  question: BtShareQuestion;
  resolve: (confirmed: boolean) => void;
}>;

/**
 * The share questions waiting for the user, answered one at a time. Its
 * `confirmShare` is BtManagerDeps.confirmShare; `ZrdtShareFileDialogHost`
 * shows the first question.
 */
export class ZrdtShareQuestions {
  readonly #queue: Array<Pending> = [];
  readonly #listeners = new Set<() => void>();

  readonly confirmShare = (question: BtShareQuestion): Promise<boolean> =>
    new Promise(resolve => {
      this.#queue.push({ question, resolve });
      this.#changed();
    });

  /** The question on screen; the same object until it is answered. */
  current(): BtShareQuestion | undefined {
    return this.#queue[0]?.question;
  }

  /** The user pressed Share (true) or Cancel (false). */
  answer(confirmed: boolean): void {
    const first = this.#queue.shift();
    first?.resolve(confirmed);
    this.#changed();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

export type ZrdtShareFileDialogHostProps = Readonly<{
  questions: ZrdtShareQuestions;
}>;

/** Shows the first waiting share question, if any. */
export function ZrdtShareFileDialogHost(
  props: ZrdtShareFileDialogHostProps
): ReactElement | null {
  const { questions } = props;
  const snapshot = useCallback(() => questions.current(), [questions]);
  const current = useSyncExternalStore(
    useCallback(listener => questions.subscribe(listener), [questions]),
    snapshot,
    snapshot
  );
  const onShare = useCallback(() => questions.answer(true), [questions]);
  const onCancel = useCallback(() => questions.answer(false), [questions]);
  if (current === undefined) {
    return null;
  }
  return (
    <ZrdtShareFileDialog
      question={current}
      onShare={onShare}
      onCancel={onCancel}
    />
  );
}
