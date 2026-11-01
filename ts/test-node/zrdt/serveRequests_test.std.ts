// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The requester's checks on a sealed SERVE reply (JOIN_PLAN §4.4): solicited
// request id, header for this account and its key, from the member asked,
// whose key has not changed since the request.

import { assert } from 'chai';

import {
  SERVE_REQUEST_TTL_MS,
  ServeRequestBook,
  checkServedReply,
} from '../../zrdt/serveRequests.std.ts';

const US = 'b0b0b0b0-0000-4000-8000-000000000002';
const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const MALLORY = 'e0e0e0e0-0000-4000-8000-000000000005';
const US_BYTES = new Uint8Array(Buffer.from(US.replace(/-/g, ''), 'hex'));
const OUR_TAG = new Uint8Array(16).fill(0x77);
const REQUEST_ID = new Uint8Array(16).fill(0x1d);
const ALICE_KEY = '05'.repeat(33);

function setup(now = 1_000) {
  const book = new ServeRequestBook();
  book.add({
    requestId: Buffer.from(REQUEST_ID).toString('hex'),
    conversationId: 'conv',
    responderAci: ALICE,
    responderKey: ALICE_KEY,
    mode: 'perDigest',
    digests: ['d1'.repeat(32)],
    sentAt: now,
  });
  const base = {
    book,
    now: now + 10,
    headerAci: US_BYTES,
    headerKeyTag: OUR_TAG,
    headerRequestId: REQUEST_ID,
    conversationId: 'conv',
    ourAci: US,
    ourKeyTag: OUR_TAG,
    senderAci: ALICE,
    responderKeyNow: ALICE_KEY,
  };
  return { book, base };
}

describe('zrdt SERVE reply checks (JOIN_PLAN §4.4)', () => {
  it('takes a solicited reply from the member asked', () => {
    const { base } = setup();
    const check = checkServedReply(base);
    assert.isTrue(check.ok);
  });

  it('drops a reply for another account or another key', () => {
    const { base } = setup();
    assert.deepEqual(
      checkServedReply({ ...base, headerAci: new Uint8Array(16).fill(1) }),
      { ok: false, reason: 'notForUs' }
    );
    assert.deepEqual(
      checkServedReply({ ...base, headerKeyTag: new Uint8Array(16).fill(1) }),
      { ok: false, reason: 'notOurKey' }
    );
  });

  it('drops an unsolicited or completed request id (other devices drop it too)', () => {
    const { book, base } = setup();
    assert.deepEqual(
      checkServedReply({ ...base, headerRequestId: new Uint8Array(16) }),
      { ok: false, reason: 'unsolicited' }
    );
    book.complete(Buffer.from(REQUEST_ID).toString('hex'));
    assert.deepEqual(checkServedReply(base), {
      ok: false,
      reason: 'unsolicited',
    });
  });

  it('drops a reply from a member not asked, or for another chat', () => {
    const { base } = setup();
    assert.deepEqual(checkServedReply({ ...base, senderAci: MALLORY }), {
      ok: false,
      reason: 'wrongResponder',
    });
    assert.deepEqual(checkServedReply({ ...base, conversationId: 'other' }), {
      ok: false,
      reason: 'wrongChat',
    });
  });

  it("drops a reply after the responder's key changed (a swapped key)", () => {
    const { base } = setup();
    assert.deepEqual(
      checkServedReply({ ...base, responderKeyNow: '06'.repeat(33) }),
      { ok: false, reason: 'responderKeyChanged' }
    );
    assert.deepEqual(
      checkServedReply({ ...base, responderKeyNow: undefined }),
      { ok: false, reason: 'responderKeyChanged' }
    );
  });

  it('drops a late reply', () => {
    const { base } = setup();
    assert.deepEqual(
      checkServedReply({ ...base, now: base.now + SERVE_REQUEST_TTL_MS }),
      { ok: false, reason: 'unsolicited' }
    );
  });
});
