// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useId, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useSelector } from 'react-redux';
import type { StateType } from '../reducer.preload.ts';
import { getZrdtDumpPath, useZrdtActions } from '../ducks/zrdt.preload.ts';
import { getSelectedConversationId } from '../selectors/nav.std.ts';
import {
  SettingsRow,
  FlowingSettingsControl,
} from '../../components/PreferencesUtil.dom.tsx';
import { AxoButton } from '../../axo/AxoButton.dom.tsx';
import { backendBadgeText } from '../../zrdt/ui/labels.std.ts';

/**
 * Settings → Internal, beat 4 (APP.md §7 "Import / Export history", §9):
 * export the chat's store blob to a file under the profile dir, import a
 * (possibly doctored) file, or salvage it. Demo only: no OS authentication,
 * no content section yet (TODO(zrdt): RESTORE_PLAN.md dump format).
 */
const SmartZrdtInternal = memo(function SmartZrdtInternal(): JSX.Element {
  const selectId = useId();
  const pathId = useId();
  const conversationLookup = useSelector(
    (state: StateType) => state.conversations.conversationLookup
  );
  const stableGroups = useMemo(
    () =>
      Object.values(conversationLookup)
        .filter(c => c.type === 'group' && c.groupVersion === 2)
        .map(c => ({ id: c.id, title: c.title })),
    [conversationLookup]
  );
  const selectedConversationId = useSelector(getSelectedConversationId);
  const backend = useSelector((state: StateType) => state.zrdt.backend);
  const result = useSelector((state: StateType) => state.zrdt.internalResult);
  const { exportConversation, importConversation, salvageFile, openCompare } =
    useZrdtActions();

  const initial =
    stableGroups.find(g => g.id === selectedConversationId)?.id ??
    stableGroups[0]?.id ??
    '';
  const [chosenId, setConversationId] = useState('');
  const [path, setPath] = useState('');
  const conversationId = chosenId || initial;

  let effectivePath = path.trim();
  if (effectivePath === '' && conversationId) {
    effectivePath = getZrdtDumpPath(conversationId);
  }

  const onExport = useCallback(() => {
    if (conversationId) {
      void exportConversation(conversationId, effectivePath);
    }
  }, [conversationId, effectivePath, exportConversation]);
  const onImport = useCallback(() => {
    if (conversationId) {
      void importConversation(conversationId, effectivePath);
    }
  }, [conversationId, effectivePath, importConversation]);
  const onSalvage = useCallback(() => {
    if (conversationId) {
      void salvageFile(conversationId, effectivePath);
    }
  }, [conversationId, effectivePath, salvageFile]);
  const onCompare = useCallback(() => {
    if (conversationId) {
      void openCompare(conversationId);
    }
  }, [conversationId, openCompare]);

  return (
    <SettingsRow title="zrdt (demo)">
      <FlowingSettingsControl>
        <div className="Preferences__two-thirds-flow">
          <div>
            {backend
              ? backendBadgeText(
                  backend.kind,
                  backend.version,
                  backend.available
                )
              : 'zrdt: not started'}
          </div>
          <label htmlFor={selectId}>Chat </label>
          <select
            id={selectId}
            value={conversationId}
            onChange={event => setConversationId(event.target.value)}
          >
            {stableGroups.map(g => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
          <div>
            <label htmlFor={pathId}>File </label>
            <input
              id={pathId}
              type="text"
              value={path}
              placeholder={effectivePath}
              onChange={event => setPath(event.target.value)}
              size={60}
            />
          </div>
          <div>
            Exports hold message structure only (authors, links, count). Do not
            share them: they leave Signal&apos;s encryption.
          </div>
          {result != null && (
            <div data-testid="zrdt-internal-result">{result}</div>
          )}
        </div>
        <div className="Preferences__flow-button Preferences__one-third-flow">
          <AxoButton.Root
            variant="strong-secondary"
            size="lg"
            onClick={onExport}
            disabled={!conversationId}
          >
            Export store
          </AxoButton.Root>
          <AxoButton.Root
            variant="strong-secondary"
            size="lg"
            onClick={onImport}
            disabled={!conversationId}
          >
            Import file
          </AxoButton.Root>
          <AxoButton.Root
            variant="strong-secondary"
            size="lg"
            onClick={onSalvage}
            disabled={!conversationId}
          >
            Keep what verifies
          </AxoButton.Root>
          <AxoButton.Root
            variant="strong-secondary"
            size="lg"
            onClick={onCompare}
            disabled={!conversationId}
          >
            Compare
          </AxoButton.Root>
        </div>
      </FlowingSettingsControl>
    </SettingsRow>
  );
});

export function renderZrdtInternal(): JSX.Element {
  return <SmartZrdtInternal />;
}
