// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, type JSX } from 'react';
import { useSelector } from 'react-redux';
import type { StateType } from '../reducer.preload.ts';
import { useZrdtActions } from '../ducks/zrdt.preload.ts';
import { ZrdtBackendBadge } from '../../zrdt/ui/ZrdtBackendBadge.dom.tsx';
import { ZrdtCompareModal } from '../../zrdt/ui/ZrdtCompareModal.dom.tsx';

/** The always-on backend badge (APP.md §7, §9 checklist). */
const SmartZrdtBackendBadge = memo(
  function SmartZrdtBackendBadge(): JSX.Element {
    const backend = useSelector((state: StateType) => state.zrdt.backend);
    return (
      <div data-testid="zrdt-backend-badge">
        <ZrdtBackendBadge
          kind={backend?.kind ?? 'stub'}
          version={backend?.version ?? 'not started'}
          available={backend?.available ?? false}
          floating
        />
      </div>
    );
  }
);

/** The compare screen, driven by state.zrdt.compare (APP.md §7 "Compare"). */
const SmartZrdtCompareModal = memo(
  function SmartZrdtCompareModal(): JSX.Element | null {
    const compare = useSelector((state: StateType) => state.zrdt.compare);
    const { comparePasted, askCompare, closeCompare } = useZrdtActions();
    const onCompare = useCallback(
      (pastedCode: string) => {
        void comparePasted(pastedCode);
      },
      [comparePasted]
    );
    const onAsk = useCallback(() => {
      void askCompare();
    }, [askCompare]);
    if (compare == null) {
      return null;
    }
    return (
      <div
        data-testid="zrdt-compare"
        data-zrdt-outcome={compare.outcome?.kind ?? ''}
      >
        <ZrdtCompareModal
          key={compare.conversationId}
          ourCode={compare.ourCode}
          ourWords={compare.ourWords}
          theirName={compare.theirName}
          theirWords={compare.theirWords}
          outcome={compare.outcome}
          onCompare={onCompare}
          onAsk={onAsk}
          onClose={closeCompare}
        />
      </div>
    );
  }
);

/** Rendered once in the app root: badge + compare modal. */
export function SmartZrdtRoot(): JSX.Element {
  return (
    <>
      <SmartZrdtBackendBadge />
      <SmartZrdtCompareModal />
    </>
  );
}
