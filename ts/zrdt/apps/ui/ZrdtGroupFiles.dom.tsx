// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChangeEvent, ReactElement } from 'react';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { tw } from '../../../axo/tw.dom.tsx';
import type { BtManager, BtTransferView } from '../bt/manager.std.ts';
import { SHARE_A_FILE } from '../bt/manager.std.ts';
import { ZrdtTransferRow } from './ZrdtTransferRow.dom.tsx';

export type ZrdtGroupFilesViewProps = Readonly<{
  transfers: ReadonlyArray<BtTransferView>;
  /** The user picked a file; the parent reads it and calls BtManager.share. */
  onPickFile: (file: File) => void;
  onDownload: (id: string) => void;
  onShowFile?: (file: string) => void;
}>;

/**
 * A group's files: the "Share a file" action and one row per file, newest
 * last. Pure presentation; `ZrdtGroupFiles` connects it to a BtManager.
 */
export function ZrdtGroupFilesView(
  props: ZrdtGroupFilesViewProps
): ReactElement {
  const { transfers, onPickFile, onDownload, onShowFile } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      // The same file may be picked again later.
      input.value = '';
      if (file != null) {
        onPickFile(file);
      }
    },
    [onPickFile]
  );

  return (
    <section
      className={tw('flex flex-col gap-1 px-4 py-2')}
      aria-label="Files"
      data-testid="ZrdtGroupFiles"
    >
      <div className={tw('flex items-center gap-2')}>
        <button
          type="button"
          className="ZrdtButton"
          onClick={() => inputRef.current?.click()}
        >
          {SHARE_A_FILE}
        </button>
        <input
          ref={inputRef}
          type="file"
          className={tw('hidden')}
          aria-label={SHARE_A_FILE}
          onChange={onChange}
        />
      </div>
      {transfers.map(t => (
        <ZrdtTransferRow
          key={t.id}
          transfer={t}
          onDownload={onDownload}
          onShowFile={onShowFile}
        />
      ))}
    </section>
  );
}

export type ZrdtGroupFilesProps = Readonly<{
  manager: BtManager;
  conversationId: string;
  groupTitle: string;
  memberCount: number;
  self: Readonly<{ aci: string; name: string }>;
  onShowFile?: (file: string) => void;
  /** Where a failed read or share is reported (the log). */
  onError?: (error: unknown) => void;
}>;

/**
 * `ZrdtGroupFilesView` on a BtManager: re-renders on every change, and
 * shares a picked file (the manager opens the share dialog first).
 */
export function ZrdtGroupFiles(props: ZrdtGroupFilesProps): ReactElement {
  const {
    manager,
    conversationId,
    groupTitle,
    memberCount,
    self,
    onShowFile,
    onError,
  } = props;
  const snapshot = useCallback(() => manager.transfers(), [manager]);
  const all = useSyncExternalStore(
    useCallback(listener => manager.subscribe(listener), [manager]),
    snapshot,
    snapshot
  );
  const transfers = all.filter(t => t.conversationId === conversationId);

  const onPickFile = useCallback(
    (file: File) => {
      const run = async () => {
        try {
          const stream = new Uint8Array(await file.arrayBuffer());
          await manager.share({
            conversationId,
            groupTitle,
            memberCount,
            self,
            name: file.name,
            stream,
          });
        } catch (error) {
          onError?.(error);
        }
      };
      void run();
    },
    [manager, conversationId, groupTitle, memberCount, self, onError]
  );

  const onDownload = useCallback(
    (id: string) => {
      const run = async () => {
        try {
          await manager.download(id);
        } catch (error) {
          onError?.(error);
        }
      };
      void run();
    },
    [manager, onError]
  );

  return (
    <ZrdtGroupFilesView
      transfers={transfers}
      onPickFile={onPickFile}
      onDownload={onDownload}
      onShowFile={onShowFile}
    />
  );
}
