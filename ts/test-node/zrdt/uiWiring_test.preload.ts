// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as sinon from 'sinon';
import type { Store } from 'redux';
import { createStore } from '../../state/createStore.preload.ts';

import { reducer as rootReducer } from '../../state/reducer.preload.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import { noopAction } from '../../state/ducks/noop.std.ts';
import {
  actions,
  getEmptyState,
  reducer,
  runZrdtThunk,
  zrdtBlobRecordCount,
  zrdtHex,
  zrdtRejectReasonFromOutcome,
} from '../../state/ducks/zrdt.preload.ts';
import { getZrdtMessageProps } from '../../state/selectors/message.preload.ts';
import { getConversationSelector } from '../../state/selectors/conversations.dom.ts';
import { zrdtService } from '../../zrdt/service.preload.ts';
import { generateAci } from '../../test-helpers/serviceIdUtils.std.ts';
import {
  getDefaultConversation,
  getDefaultGroup,
} from '../../test-helpers/getDefaultConversation.std.ts';
import { labelText } from '../../zrdt/ui/labels.std.ts';
import { parseCompareCode } from '../../zrdt/ui/compareCode.std.ts';
import * as Bytes from '../../Bytes.std.ts';

const D1 = `9ac1${'0'.repeat(60)}`;
const D2 = `c7f2${'1'.repeat(60)}`;
const D3 = `0b0b${'2'.repeat(60)}`;

const ALICE = generateAci();
const BOB = generateAci();
const ME = generateAci();
const GROUP_ID = Bytes.toBase64(new Uint8Array(32).fill(7));

function makeState(): StateType {
  const empty = rootReducer(undefined, noopAction('zrdt test'));
  const alice = getDefaultConversation({
    id: 'alice',
    serviceId: ALICE,
    title: 'Alice',
    firstName: 'Alice',
  });
  const bob = getDefaultConversation({
    id: 'bob',
    serviceId: BOB,
    title: 'Bob',
    firstName: 'Bob',
  });
  const group = getDefaultGroup({ id: 'camping', groupId: GROUP_ID });
  return {
    ...empty,
    conversations: {
      ...empty.conversations,
      conversationLookup: { alice, bob, camping: group },
      conversationsByServiceId: { [ALICE]: alice, [BOB]: bob },
    },
    user: { ...empty.user, ourAci: ME },
  };
}

function makeStore(initial: StateType): Store<StateType> {
  return createStore(initial);
}

describe('zrdt UI wiring', () => {
  describe('helpers', () => {
    it('zrdtHex and the blob record count', () => {
      assert.strictEqual(zrdtHex(new Uint8Array([0, 15, 255])), '000fff');
      const blob = new Uint8Array(6 + 32 + 4 + 3);
      blob.set([0, 0, 1, 2], 38);
      assert.strictEqual(zrdtBlobRecordCount(blob), 258);
      assert.isUndefined(zrdtBlobRecordCount(new Uint8Array(10)));
    });

    it('maps OPEN outcomes to banner reasons', () => {
      assert.isUndefined(zrdtRejectReasonFromOutcome({ status: 'ok' }));
      assert.deepEqual(
        zrdtRejectReasonFromOutcome({
          status: 'unverifiable',
          unverifiable: [Bytes.fromHex(D2)],
          missing: [Bytes.fromHex(D1)],
        }),
        { kind: 'unverifiable', missing: [D1] }
      );
      assert.deepEqual(zrdtRejectReasonFromOutcome({ status: 'tooLarge' }), {
        kind: 'too-large',
      });
      assert.deepEqual(
        zrdtRejectReasonFromOutcome({
          status: 'collision',
          digest: Bytes.fromHex(D3),
        }),
        { kind: 'collision', digest: D3 }
      );
    });
  });

  describe('reducer', () => {
    it('patches a conversation and clears keys', () => {
      let state = reducer(
        getEmptyState(),
        actions.patchConversation('c1', {
          rejected: { reason: { kind: 'malformed' }, source: 'import' },
          busy: true,
        })
      );
      assert.deepEqual(state.byConversation.c1?.rejected, {
        reason: { kind: 'malformed' },
        source: 'import',
      });
      assert.deepEqual(state.byConversation.c1?.disown, []);
      state = reducer(
        state,
        actions.patchConversation('c1', { disown: [D1] }, ['rejected', 'busy'])
      );
      assert.isUndefined(state.byConversation.c1?.rejected);
      assert.isUndefined(state.byConversation.c1?.busy);
      assert.deepEqual(state.byConversation.c1?.disown, [D1]);
    });
  });

  describe('getZrdtMessageProps', () => {
    const state = makeState();
    const conversationSelector = getConversationSelector(state);
    const base = {
      type: 'incoming' as const,
      sourceServiceId: ALICE,
      zrdtDigest: D1,
    };
    const label = (
      message: Parameters<typeof getZrdtMessageProps>[0],
      statuses?:
        | Record<string, never>
        | Parameters<typeof getZrdtMessageProps>[1]['zrdtStatuses']
    ) => {
      const props = getZrdtMessageProps(message, {
        conversationSelector,
        ourAci: ME,
        zrdtStatuses: statuses,
      });
      return props.zrdtLabel != null ? labelText(props.zrdtLabel) : null;
    };

    it('no digest: no zrdt props', () => {
      assert.deepEqual(
        getZrdtMessageProps(
          { type: 'incoming', sourceServiceId: ALICE },
          { conversationSelector, ourAci: ME }
        ),
        {}
      );
    });

    it('live and confirmed: no label, but the code', () => {
      const props = getZrdtMessageProps(base, {
        conversationSelector,
        ourAci: ME,
        zrdtStatuses: { [D1]: { kind: 'confirmedByAuthor' } },
      });
      assert.strictEqual(props.zrdtDigest, D1);
      assert.isNull(props.zrdtLabel);
      assert.isFalse(props.zrdtHidden);
    });

    it('relayed by Bob, then confirmed by Alice', () => {
      const relayed = {
        ...base,
        zrdtProvenance: { kind: 'relayed' as const, byAci: BOB },
      };
      assert.strictEqual(label(relayed), 'relayed by Bob');
      assert.strictEqual(
        label(relayed, { [D1]: { kind: 'heldBy', aci: BOB } }),
        'relayed by Bob'
      );
      const upgraded = {
        ...base,
        zrdtProvenance: { kind: 'live' as const, arrivedIndirectly: true },
      };
      assert.strictEqual(
        label(upgraded, { [D1]: { kind: 'confirmedByAuthor' } }),
        'confirmed by Alice'
      );
    });

    it('held by, not confirmed by, and the stored-status fallback', () => {
      const imported = {
        ...base,
        zrdtProvenance: { kind: 'imported' as const },
      };
      assert.strictEqual(
        label(imported, { [D1]: { kind: 'heldBy', aci: BOB } }),
        'held by Bob'
      );
      assert.strictEqual(
        label(imported, { [D1]: { kind: 'notConfirmedByAuthor' } }),
        'not confirmed by Alice'
      );
      assert.strictEqual(
        label({
          ...imported,
          zrdtStatus: { kind: 'heldBy', heldByAci: BOB },
        }),
        'held by Bob'
      );
    });

    it('imported and unconfirmed: hidden (collapsed section)', () => {
      const props = getZrdtMessageProps(
        { ...base, zrdtProvenance: { kind: 'imported' } },
        {
          conversationSelector,
          ourAci: ME,
          zrdtStatuses: { [D1]: { kind: 'unconfirmed' } },
        }
      );
      assert.isTrue(props.zrdtHidden);
      // A relayed, unconfirmed message stays in the timeline.
      const relayed = getZrdtMessageProps(
        { ...base, zrdtProvenance: { kind: 'relayed', byAci: BOB } },
        {
          conversationSelector,
          ourAci: ME,
          zrdtStatuses: { [D1]: { kind: 'unconfirmed' } },
        }
      );
      assert.isFalse(relayed.zrdtHidden);
    });
  });

  describe('compare', () => {
    let sandbox: sinon.SinonSandbox;
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      // Clears the module-level compare timer.
      actions.closeCompare();
      sandbox.restore();
    });

    function setup(ourHeads: Array<string>, held: Array<string>) {
      sandbox
        .stub(zrdtService, 'heads')
        .callsFake(async () => ourHeads.map(h => Bytes.fromHex(h)));
      sandbox
        .stub(zrdtService, 'has')
        .callsFake(async (_c, d) => held.includes(zrdtHex(d)));
      return makeStore(makeState());
    }

    function codeFor(owner: string, heads: Array<string>): string {
      const chat = Bytes.toHex(Bytes.fromBase64(GROUP_ID));
      return `zrdt1:${chat}:${owner}:${[...heads].sort().join(',')}`;
    }

    it('opens with our code for this group', async () => {
      const store = setup([D1], [D1]);
      await runZrdtThunk(actions.openCompare('camping'), store);
      const compare = store.getState().zrdt.compare;
      assert.isDefined(compare);
      const parsed = parseCompareCode(compare?.ourCode ?? '');
      assert.isTrue(parsed.ok);
      if (parsed.ok) {
        assert.deepEqual(parsed.code.heads, [D1]);
        assert.strictEqual(parsed.code.owner, ME);
      }
      assert.lengthOf(compare?.ourWords ?? [], 12);
    });

    it('identical, they are behind, invalid', async () => {
      const store = setup([D1, D2], [D1, D2, D3]);
      await runZrdtThunk(actions.openCompare('camping'), store);
      await runZrdtThunk(actions.comparePasted(codeFor(BOB, [D2, D1])), store);
      assert.deepEqual(store.getState().zrdt.compare?.outcome, {
        kind: 'identical',
      });
      assert.strictEqual(store.getState().zrdt.compare?.theirName, 'Bob');
      await runZrdtThunk(actions.comparePasted(codeFor(BOB, [D3])), store);
      assert.deepEqual(store.getState().zrdt.compare?.outcome, {
        kind: 'they-are-behind',
      });
      await runZrdtThunk(actions.comparePasted('hello'), store);
      assert.deepEqual(store.getState().zrdt.compare?.outcome, {
        kind: 'invalid-code',
        error: 'not-a-compare-code',
      });
    });

    it('you are behind: asks, then "Asked; no answer." after the timeout', async () => {
      const store = setup([D1], [D1]);
      await runZrdtThunk(actions.openCompare('camping'), store);
      await runZrdtThunk(actions.comparePasted(codeFor(BOB, [D2])), store);
      assert.deepEqual(store.getState().zrdt.compare?.outcome, {
        kind: 'you-are-behind',
        missing: [D2],
        asking: true,
      });
      await clock.tickAsync(10_000);
      // Let the re-check's promises settle.
      for (let i = 0; i < 20; i += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      assert.deepEqual(store.getState().zrdt.compare?.outcome, {
        kind: 'withheld',
        missing: [D2],
      });
    });
  });
});
