// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useMemo, type JSX } from 'react';
import { useSelector } from 'react-redux';
import type { StateType } from '../reducer.preload.ts';
import { useZrdtActions } from '../ducks/zrdt.preload.ts';
import { useNavActions } from '../ducks/nav.std.ts';
import { drop } from '../../util/drop.std.ts';
import { NavTab, SettingsPage } from '../../types/Nav.std.ts';
import { getConversationSelector } from '../selectors/conversations.dom.ts';
import { ZrdtRejectedBanner } from '../../zrdt/ui/ZrdtRejectedBanner.dom.tsx';
import { ZrdtUnavailableBanner } from '../../zrdt/ui/ZrdtUnavailableBanner.dom.tsx';
import { ZrdtOwnNameAlarm } from '../../zrdt/ui/ZrdtOwnNameAlarm.dom.tsx';
import type { ZrdtUnconfirmedItem } from '../../zrdt/ui/ZrdtUnconfirmedSection.dom.tsx';
import { ZrdtUnconfirmedSection } from '../../zrdt/ui/ZrdtUnconfirmedSection.dom.tsx';

/**
 * The conversation-level zrdt banner slot, under the header (APP.md §7):
 * zrdt unavailable, rejected copy (with "Keep what verifies"), the own-name
 * alarm, and the collapsed "not yet confirmed" section.
 */
export const SmartZrdtConversationBanners = memo(
  function SmartZrdtConversationBanners({
    conversationId,
  }: Readonly<{ conversationId: string }>): JSX.Element | null {
    const isGroup = useSelector(
      (state: StateType) =>
        state.conversations.conversationLookup[conversationId]?.type === 'group'
    );
    const backend = useSelector((state: StateType) => state.zrdt.backend);
    const unavailableDetail = useSelector(
      (state: StateType) => state.zrdt.unavailableDetail
    );
    const zrdtState = useSelector(
      (state: StateType) => state.zrdt.byConversation[conversationId]
    );
    const conversationSelector = useSelector(getConversationSelector);
    const { keepWhatVerifies, dismissSalvageReport, dismissOwnNameAlarm } =
      useZrdtActions();
    const { changeLocation } = useNavActions();

    const onKeepWhatVerifies = useCallback(() => {
      void keepWhatVerifies(conversationId);
    }, [conversationId, keepWhatVerifies]);
    const onImportCopy = useCallback(() => {
      drop(
        changeLocation({
          tab: NavTab.Settings,
          details: { page: SettingsPage.Internal },
        })
      );
    }, [changeLocation]);
    const onDismissSalvage = useCallback(() => {
      dismissSalvageReport(conversationId);
    }, [conversationId, dismissSalvageReport]);
    const onDismissAlarm = useCallback(() => {
      dismissOwnNameAlarm(conversationId);
    }, [conversationId, dismissOwnNameAlarm]);

    const alarmDigests = useMemo(() => {
      const dismissed = new Set(zrdtState?.alarmDismissed ?? []);
      return (zrdtState?.disown ?? []).filter(d => !dismissed.has(d));
    }, [zrdtState?.alarmDismissed, zrdtState?.disown]);

    const unconfirmedItems = useMemo(
      (): Array<ZrdtUnconfirmedItem> =>
        (zrdtState?.unconfirmed ?? []).map(item => {
          const contact =
            item.attributedToAci != null
              ? conversationSelector(item.attributedToAci)
              : undefined;
          return {
            digest: item.digest,
            attributedTo:
              contact != null
                ? contact.firstName || contact.title
                : 'an unknown member',
            text: item.text,
            sentAt: item.sentAt,
          };
        }),
      [conversationSelector, zrdtState?.unconfirmed]
    );

    if (!isGroup) {
      return null;
    }
    const unavailable = backend != null && !backend.available;
    const rejected = zrdtState?.rejected;
    const salvage = zrdtState?.salvage;
    if (
      !unavailable &&
      rejected == null &&
      salvage == null &&
      alarmDigests.length === 0 &&
      unconfirmedItems.length === 0
    ) {
      return null;
    }
    return (
      <div className="ZrdtBanners" data-testid="zrdt-banners">
        {unavailable && <ZrdtUnavailableBanner detail={unavailableDetail} />}
        {rejected != null && (
          <ZrdtRejectedBanner
            reason={rejected.reason}
            busy={zrdtState?.busy === true}
            onKeepWhatVerifies={onKeepWhatVerifies}
            onImportCopy={onImportCopy}
          />
        )}
        {rejected == null && salvage != null && (
          <ZrdtRejectedBanner
            reason={{ kind: 'unverifiable', missing: [] }}
            salvage={salvage}
            onKeepWhatVerifies={onKeepWhatVerifies}
            onImportCopy={onImportCopy}
            onDismiss={onDismissSalvage}
          />
        )}
        <ZrdtOwnNameAlarm digests={alarmDigests} onDismiss={onDismissAlarm} />
        <ZrdtUnconfirmedSection items={unconfirmedItems} />
      </div>
    );
  }
);
