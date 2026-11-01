// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { SignalService as Proto } from '../../protobuf/index.std.ts';
import {
  findLengthDelimitedField,
  getDataMessageBytes,
  getSyncSentDataMessageBytes,
} from '../../zrdt/wire.std.ts';
import { isZrdtRecordMessage } from '../../zrdt/scope.std.ts';

function concat(
  ...parts: Array<Uint8Array<ArrayBuffer>>
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('zrdt wire: DataMessage bytes as sent', () => {
  const dataMessage = Proto.DataMessage.encode({
    body: 'who is bringing the tent?',
    timestamp: 1234n,
    zrdt: {
      links: [new Uint8Array(32).fill(7)],
      nonce: new Uint8Array(32).fill(9),
      version: 1,
      disown: null,
    },
  } as unknown as Proto.DataMessage.Params);

  it('slices Content.dataMessage', () => {
    const content = Proto.Content.encode({
      content: { dataMessage: Proto.DataMessage.decode(dataMessage) },
      senderKeyDistributionMessage: null,
      pniSignatureMessage: null,
    });
    assert.deepEqual(getDataMessageBytes(content), dataMessage);
  });

  it('keeps bytes another client sent, even if a re-encode differs', () => {
    // field 1 (body) twice inside the DataMessage: a re-encode would collapse
    // it; the slice must not.
    const odd = concat(dataMessage, new Uint8Array([0x0a, 0x01, 0x41]));
    const content = concat(new Uint8Array([0x0a, odd.length]), odd);
    assert.deepEqual(getDataMessageBytes(content), odd);
  });

  it('slices SyncMessage.sent.message', () => {
    const sent = concat(
      new Uint8Array([0x10, 0x05]), // timestamp = 5
      new Uint8Array([0x1a, dataMessage.length]),
      dataMessage
    );
    const sync = concat(new Uint8Array([0x0a, sent.length]), sent);
    const content = concat(new Uint8Array([0x12, sync.length]), sync);
    assert.deepEqual(getSyncSentDataMessageBytes(content), dataMessage);
    assert.isUndefined(getDataMessageBytes(content));
  });

  it('treats a duplicate field or a truncated message as absent', () => {
    const one = concat(new Uint8Array([0x0a, 0x01, 0x00]));
    assert.isUndefined(getDataMessageBytes(concat(one, one)));
    assert.strictEqual(
      findLengthDelimitedField(new Uint8Array([0x0a, 0x05, 0x00]), 1),
      'invalid'
    );
    assert.strictEqual(
      findLengthDelimitedField(new Uint8Array([0x08, 0x01]), 1),
      'absent'
    );
  });
});

describe('zrdt scope predicate (receive side)', () => {
  const group = { groupChange: null };
  it('a plain group message is in scope', () => {
    assert.isTrue(isZrdtRecordMessage({ groupV2: group, flags: 0 }));
  });
  it('1:1, reactions, deletes, timers, group changes and polls are not', () => {
    assert.isFalse(isZrdtRecordMessage({}));
    assert.isFalse(isZrdtRecordMessage({ groupV2: group, reaction: {} }));
    assert.isFalse(isZrdtRecordMessage({ groupV2: group, delete: {} }));
    assert.isFalse(isZrdtRecordMessage({ groupV2: group, flags: 2 }));
    assert.isFalse(isZrdtRecordMessage({ groupV2: group, storyContext: {} }));
    assert.isFalse(isZrdtRecordMessage({ groupV2: group, pollVote: {} }));
    assert.isFalse(
      isZrdtRecordMessage({ groupV2: { groupChange: new Uint8Array(1) } })
    );
  });
});
