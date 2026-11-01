// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useId, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useSelector } from 'react-redux';
import type { StateType } from '../reducer.preload.ts';
import { getZrdtDumpPath, useZrdtActions } from '../ducks/zrdt.preload.ts';
import { getSelectedConversationId } from '../selectors/nav.std.ts';
import { getConversationSelector } from '../selectors/conversations.dom.ts';
import { getUserACI } from '../selectors/user.std.ts';
import { useConversationsActions } from '../ducks/conversations.preload.ts';
import { drop } from '../../util/drop.std.ts';
import {
  SettingsRow,
  FlowingSettingsControl,
} from '../../components/PreferencesUtil.dom.tsx';
import { AxoButton } from '../../axo/AxoButton.dom.tsx';
import { backendBadgeText } from '../../zrdt/ui/labels.std.ts';

/**
 * Settings → Internal, beats 4 and 5 (APP.md §7 "Import / Export history",
 * §9): export the chat's store to a file under the profile dir, for this
 * account (its own export) or for another member (SERVE for that member,
 * sealed to its key, JOIN_PLAN §4.5); import a (possibly doctored) file, or
 * salvage it; and the group's strict mode (§5). Demo only: no OS
 * authentication (TODO(zrdt)). The files are described in
 * ducks/zrdt.preload.ts (zrdtParseExport).
 */
const SmartZrdtInternal = memo(function SmartZrdtInternal(): JSX.Element {
  const selectId = useId();
  const pathId = useId();
  const forId = useId();
  const strictId = useId();
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
  const {
    exportConversation,
    exportConversationFor,
    importConversation,
    salvageFile,
    openCompare,
    setStrict,
  } = useZrdtActions();
  const conversationSelector = useSelector(getConversationSelector);
  const ourAci = useSelector(getUserACI);

  const initial =
    stableGroups.find(g => g.id === selectedConversationId)?.id ??
    stableGroups[0]?.id ??
    '';
  const [chosenId, setConversationId] = useState('');
  const [path, setPath] = useState('');
  const conversationId = chosenId || initial;

  // Whom the export is for: this account, or another member (JOIN_PLAN §4.5).
  const otherMembers = useMemo(
    () =>
      (conversationLookup[conversationId]?.memberships ?? [])
        .map(m => m.aci)
        .filter(aci => aci !== ourAci)
        .map(aci => ({ aci, title: conversationSelector(aci).title })),
    [conversationLookup, conversationId, conversationSelector, ourAci]
  );
  const [exportFor, setExportFor] = useState('');
  const forAci = otherMembers.some(m => m.aci === exportFor) ? exportFor : '';

  // Strict mode is a conversation attribute (not in Redux): read on every
  // render; a toggle re-renders.
  const [, setStrictToggles] = useState(0);
  const strict = conversationId
    ? window.ConversationController.get(conversationId)?.get('zrdtStrict') ===
      true
    : false;
  const onStrict = useCallback(
    async (on: boolean) => {
      if (conversationId) {
        await setStrict(conversationId, on);
        setStrictToggles(n => n + 1);
      }
    },
    [conversationId, setStrict]
  );

  let effectivePath = path.trim();
  if (effectivePath === '' && conversationId) {
    effectivePath = getZrdtDumpPath(conversationId);
  }

  const onExport = useCallback(() => {
    if (!conversationId) {
      return;
    }
    if (forAci) {
      void exportConversationFor(conversationId, forAci, effectivePath);
    } else {
      void exportConversation(conversationId, effectivePath);
    }
  }, [
    conversationId,
    effectivePath,
    exportConversation,
    exportConversationFor,
    forAci,
  ]);
  const { showConversation } = useConversationsActions();
  const onImport = useCallback(async () => {
    if (!conversationId) {
      return;
    }
    const outcome = await importConversation(conversationId, effectivePath);
    if (outcome != null) {
      // Back to the chat. Beat 4: the red banner names what is missing and
      // offers "Keep what verifies". Beat 5: the imported history waits in
      // the collapsed "not yet confirmed" section.
      await showConversation({ conversationId });
    }
  }, [conversationId, effectivePath, importConversation, showConversation]);
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
            <label htmlFor={forId}>Export for </label>
            <select
              id={forId}
              value={forAci}
              onChange={event => setExportFor(event.target.value)}
            >
              <option value="">this account (own export)</option>
              {otherMembers.map(m => (
                <option key={m.aci} value={m.aci}>
                  {m.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <input
              id={strictId}
              type="checkbox"
              checked={strict}
              onChange={event => drop(onStrict(event.target.checked))}
              disabled={!conversationId}
            />
            <label htmlFor={strictId}>
              {' '}
              Strict mode: this device serves content only in author copies
            </label>
          </div>
          <div>
            Your own export holds the chat&apos;s messages (their text, authors
            and links); only this account can import it. An export for another
            member holds only what that member was sent, sealed to their key. Do
            not share either: they leave Signal&apos;s encryption.
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
            onClick={() => drop(onImport())}
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
