// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The quote rule and the edit rule (JOIN_PLAN §8.3), on the wire quote that
// uploadMessageQuote returns: a reply drafted before an add and sent after;
// an edit of a message whose quote was stripped; blocked and unregistered
// members among the receivers.

import { assert } from 'chai';

import * as Bytes from '../../Bytes.std.ts';
import { createLogger } from '../../logging/log.std.ts';
import type { ReadonlyMessageAttributesType } from '../../model-types.d.ts';
import type { ConversationModel } from '../../models/conversations.preload.ts';
import type { OutgoingQuoteType } from '../../textsecure/SendMessage.preload.ts';
import type { AciString } from '../../types/ServiceId.std.ts';
import { uuidToBytes } from '../../util/uuidToBytes.std.ts';
import {
  applyZrdtQuoteRule,
  getCommittedAudience,
  getZrdtEditRecipients,
  splitZrdtTargetConversationIds,
} from '../../zrdt/quote.preload.ts';
import type { ZrdtTargetMemberType } from '../../zrdt/quote.preload.ts';

const log = createLogger('zrdt/quote_test');

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001' as AciString; // us
const BOB = 'b0b0b0b0-0000-4000-8000-000000000002' as AciString; // added later
const CAROL = 'c0c0c0c0-0000-4000-8000-000000000003' as AciString;
const DAVE = 'd0d0d0d0-0000-4000-8000-000000000004' as AciString; // blocked then
const ERIN = 'e0e0e0e0-0000-4000-8000-000000000005' as AciString; // unregistered then

const GROUP = {
  id: 'conversation-1',
  attributes: {
    type: 'group',
    groupId: Bytes.toBase64(new Uint8Array(32).fill(7)),
    groupVersion: 2,
  },
} as unknown as Pick<ConversationModel, 'id' | 'attributes'>;

function varint(value: number): Array<number> {
  const out: Array<number> = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) + 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

/** An opening (nonce ‖ DataMessage) whose field 201 lists these members. */
function openingFor(
  seated: ReadonlyArray<AciString>,
  zeroTag: ReadonlyArray<AciString> = []
): string {
  const entries = [
    ...seated.map(aci => ({ aci, tag: new Uint8Array(16).fill(0x11) })),
    ...zeroTag.map(aci => ({ aci, tag: new Uint8Array(16) })),
  ]
    .map(({ aci, tag }) => Buffer.concat([uuidToBytes(aci), tag]))
    .sort(Buffer.compare);
  const audience = Buffer.concat(entries);
  const body = Buffer.from('quoted text');
  const message = Buffer.concat([
    Buffer.from([0x0a, ...varint(body.length)]),
    body,
    Buffer.from([...varint(201 * 8 + 2), ...varint(audience.length)]),
    audience,
  ]);
  return Bytes.toBase64(
    new Uint8Array(Buffer.concat([Buffer.alloc(32, 0x42), message]))
  );
}

const P_DIGEST = 'ab'.repeat(32);

function quotedMessage(
  opening: string | undefined
): ReadonlyMessageAttributesType {
  return {
    id: 'p',
    conversationId: GROUP.id,
    type: 'incoming',
    sent_at: 1000,
    received_at: 1,
    timestamp: 1000,
    sourceServiceId: CAROL,
    zrdtDigest: P_DIGEST,
    ...(opening ? { zrdtOpening: opening } : {}),
  };
}

const QUOTE: OutgoingQuoteType = {
  id: 1000,
  authorAci: CAROL,
  text: 'quoted text',
  bodyRanges: [],
  attachments: [{ contentType: 'image/jpeg', fileName: 'x.jpg' }],
  isGiftBadge: false,
};

async function rule(
  quoted: ReadonlyMessageAttributesType | undefined,
  recipients: ReadonlyArray<string>,
  extraReceivers: ReadonlyArray<string> = []
): Promise<OutgoingQuoteType | undefined> {
  return applyZrdtQuoteRule({
    quote: QUOTE,
    conversation: GROUP,
    recipients,
    extraReceivers,
    findQuoted: async () => quoted,
    ourAci: ALICE,
    log,
  });
}

function assertStripped(quote: OutgoingQuoteType | undefined): void {
  assert.isOk(quote);
  assert.isUndefined(quote?.id, 'no id (no pre-join timestamp)');
  assert.isUndefined(quote?.authorAci, 'no author (no former member)');
  assert.isUndefined(quote?.text);
  assert.isUndefined(quote?.bodyRanges);
  assert.deepEqual(quote?.attachments, []);
  assert.strictEqual(Bytes.toHex(quote?.zrdtRef ?? new Uint8Array()), P_DIGEST);
}

describe('zrdt quote and edit rules (JOIN_PLAN §8.3)', () => {
  it('keeps a quote every receiver was sent', async () => {
    const p = quotedMessage(openingFor([ALICE, BOB, CAROL]));
    assert.deepEqual(await rule(p, [BOB, CAROL]), QUOTE);
  });

  it('a reply drafted before an add and sent after: stripped, pointing by digest', async () => {
    // p went to Alice and Carol. Alice clicked Reply; Bob was added before
    // the send; this attempt's recipients include Bob.
    const p = quotedMessage(openingFor([ALICE, CAROL]));
    assertStripped(await rule(p, [BOB, CAROL]));
    // Not yet a recipient of this attempt, but a recipient at enqueue: the
    // record can still reach him on a retry, so it is stripped too.
    assertStripped(await rule(p, [CAROL], [BOB, CAROL]));
    assert.deepEqual(await rule(p, [CAROL], [CAROL]), QUOTE);
  });

  it('blocked and unregistered members (zero tag in p) are not seated', async () => {
    const p = quotedMessage(openingFor([ALICE, BOB, CAROL], [DAVE, ERIN]));
    assertStripped(await rule(p, [BOB, CAROL, DAVE]));
    assertStripped(await rule(p, [BOB, CAROL], [ERIN]));
    assert.deepEqual(await rule(p, [BOB, CAROL]), QUOTE);
  });

  it('an unknown audience (erased, or not a record) strips; an unknown message strips', async () => {
    const erased = quotedMessage(undefined);
    assertStripped(await rule(erased, [CAROL]));
    const stripped = await rule(undefined, [CAROL]);
    assert.isOk(stripped);
    assert.isUndefined(stripped?.text);
    assert.isUndefined(stripped?.zrdtRef);
  });

  it('only GroupV2 conversations: 1:1 quotes go the stock way', async () => {
    const direct = {
      id: 'direct',
      attributes: { type: 'private' },
    } as unknown as Pick<ConversationModel, 'id' | 'attributes'>;
    assert.deepEqual(
      await applyZrdtQuoteRule({
        quote: QUOTE,
        conversation: direct,
        recipients: [BOB],
        findQuoted: async () => undefined,
        ourAci: ALICE,
        log,
      }),
      QUOTE
    );
  });

  it('an edit of a message whose quote was stripped: seats ∩ recipients, stripped again', async () => {
    // n: Alice's record that quoted p and was sent to Alice, Bob and Carol
    // (its quote was stripped on the wire; the local quote attribute still
    // names p). Frank was added after n.
    const FRANK = 'f0f0f0f0-0000-4000-8000-000000000006' as AciString;
    const n = {
      ...quotedMessage(openingFor([ALICE, BOB, CAROL])),
      id: 'n',
      type: 'outgoing',
      sourceServiceId: ALICE,
    } as ReadonlyMessageAttributesType;
    assert.isOk(getCommittedAudience(n));
    const editRecipients = getZrdtEditRecipients(n, [BOB, CAROL, FRANK]);
    assert.deepEqual(editRecipients, [BOB, CAROL], 'Frank never gets the edit');
    // The edit's wire quote of p goes through the rule again.
    const p = quotedMessage(openingFor([ALICE, CAROL]));
    assertStripped(await rule(p, editRecipients));
    // A target that is no record (no audience) is edited the stock way.
    const plain = quotedMessage(undefined);
    assert.deepEqual(getZrdtEditRecipients(plain, [BOB, FRANK]), [BOB, FRANK]);
  });

  describe('the target rule (reactions, pins, deletes, poll votes)', () => {
    // Conversation ids of the group's members, as Reactions and Polls keep
    // them; Dave was added after the target was sent.
    const byId = new Map<string, ZrdtTargetMemberType>([
      ['c-alice', 'me'],
      ['c-bob', { aci: BOB }],
      ['c-carol', { aci: CAROL }],
      ['c-dave', { aci: DAVE }],
      ['c-gone', undefined],
    ]);
    const memberOf = (id: string) => byId.get(id);
    const ids = ['c-alice', 'c-bob', 'c-carol', 'c-dave', 'c-gone'];

    it('a reaction to a pre-join record goes to its seats and us only', () => {
      const target = quotedMessage(openingFor([ALICE, BOB, CAROL]));
      assert.deepEqual(splitZrdtTargetConversationIds(target, ids, memberOf), {
        allowed: ['c-alice', 'c-bob', 'c-carol'],
        excluded: ['c-dave', 'c-gone'],
      });
    });

    it('a member listed with a zero tag (not sent the target) is left out', () => {
      const target = quotedMessage(openingFor([ALICE, BOB], [CAROL]));
      assert.deepEqual(
        splitZrdtTargetConversationIds(target, ids, memberOf).allowed,
        ['c-alice', 'c-bob']
      );
    });

    it('a target with no committed audience (not a record, e.g. a poll) goes the stock way', () => {
      const plain = quotedMessage(undefined);
      assert.deepEqual(splitZrdtTargetConversationIds(plain, ids, memberOf), {
        allowed: ids,
        excluded: [],
      });
    });

    it('pins, unpins, deletes and poll terminates: service ids, seats ∩ recipients', () => {
      const target = quotedMessage(openingFor([ALICE, BOB, CAROL]));
      assert.deepEqual(getZrdtEditRecipients(target, [BOB, CAROL, DAVE]), [
        BOB,
        CAROL,
      ]);
      assert.deepEqual(
        getZrdtEditRecipients(quotedMessage(undefined), [BOB, DAVE]),
        [BOB, DAVE]
      );
    });

    it('an outgoing target (our own record) is ruled the same way', () => {
      const target = {
        ...quotedMessage(openingFor([ALICE, CAROL])),
        type: 'outgoing',
      } as ReadonlyMessageAttributesType;
      assert.deepEqual(
        splitZrdtTargetConversationIds(target, ids, memberOf).allowed,
        ['c-alice', 'c-carol']
      );
    });
  });
});
