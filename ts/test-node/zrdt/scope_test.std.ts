// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  getZrdtOutOfScopeReason,
  isZrdtRecordMessage,
} from '../../zrdt/scope.std.ts';
import type { ZrdtScopeDataMessageType } from '../../zrdt/scope.std.ts';

describe('zrdt/scope', () => {
  const groupV2 = { masterKey: new Uint8Array(32), revision: 3 };

  function check(
    dataMessage: ZrdtScopeDataMessageType,
    options: { isGroupV2?: boolean; isEdit?: boolean; isStory?: boolean } = {}
  ): string | undefined {
    return getZrdtOutOfScopeReason({
      isGroupV2: options.isGroupV2 ?? true,
      isEdit: options.isEdit ?? false,
      isStory: options.isStory,
      dataMessage,
    });
  }

  it('a plain GroupV2 message is a record', () => {
    assert.isUndefined(check({ groupV2 }));
    assert.isTrue(
      isZrdtRecordMessage({
        isGroupV2: true,
        isEdit: false,
        dataMessage: { groupV2 },
      })
    );
  });

  it('null fields (Proto params and decoded messages) count as unset', () => {
    assert.isUndefined(
      check({
        groupV2: { groupChange: null },
        storyContext: null,
        reaction: null,
        delete: null,
        adminDelete: null,
        groupCallUpdate: null,
        pollCreate: null,
        pollVote: null,
        pollTerminate: null,
        pinMessage: null,
        unpinMessage: null,
        payment: null,
        giftBadge: null,
        flags: 0,
      })
    );
    assert.isUndefined(check({ flags: null }));
  });

  it('1:1 chats, Note-to-self and GroupV1 are out', () => {
    assert.strictEqual(check({}, { isGroupV2: false }), 'notGroupV2');
    assert.isFalse(
      isZrdtRecordMessage({ isGroupV2: false, isEdit: false, dataMessage: {} })
    );
  });

  it('edits and stories are out', () => {
    assert.strictEqual(check({ groupV2 }, { isEdit: true }), 'edit');
    assert.strictEqual(check({ groupV2 }, { isStory: true }), 'story');
    assert.strictEqual(check({ storyContext: {} }), 'storyContext');
  });

  it('every non-NormalMessage DataMessage is out', () => {
    assert.strictEqual(check({ reaction: {} }), 'reaction');
    assert.strictEqual(check({ delete: {} }), 'delete');
    assert.strictEqual(check({ adminDelete: {} }), 'delete');
    assert.strictEqual(check({ groupCallUpdate: {} }), 'groupCallUpdate');
    assert.strictEqual(check({ pollCreate: {} }), 'poll');
    assert.strictEqual(check({ pollVote: {} }), 'poll');
    assert.strictEqual(check({ pollTerminate: {} }), 'poll');
    assert.strictEqual(check({ pinMessage: {} }), 'pin');
    assert.strictEqual(check({ unpinMessage: {} }), 'pin');
    assert.strictEqual(check({ payment: {} }), 'payment');
    assert.strictEqual(check({ giftBadge: {} }), 'payment');
    // EXPIRATION_TIMER_UPDATE = 2, PROFILE_KEY_UPDATE = 4
    assert.strictEqual(check({ flags: 2 }), 'flags');
    assert.strictEqual(check({ flags: 4 }), 'flags');
    assert.strictEqual(
      check({ groupV2: { groupChange: new Uint8Array(4) } }),
      'groupChange'
    );
  });
});
