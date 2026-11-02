// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// sendZrdtServed's content (JOIN_PLAN §4.3, §8.2): the destination and the
// seal key come from SERVE's reply header; a key SERVE did not check is
// refused; only the checked key opens the entries.

import { assert } from 'chai';
import { PrivateKey } from '@signalapp/libsignal-client';

import type { ServeReply } from '../../zrdt/ZrdtBackend.std.ts';
import { encodeServeEntries } from '../../zrdt/backends/codec.std.ts';
import { buildZrdtServedContent } from '../../zrdt/served.preload.ts';
import {
  encodeServeHeader,
  keyTag,
  openServeReply,
} from '../../zrdt/seal.node.ts';

type Bytes = Uint8Array<ArrayBuffer>;

const GROUP = new Uint8Array(32).fill(0x67);
const BOB_ACI = new Uint8Array(16).fill(0xb0);

function replyFor(key: Bytes): ServeReply {
  const header = {
    requesterAci: BOB_ACI,
    keyTag: keyTag(key),
    requestId: new Uint8Array(16).fill(0x1d),
  };
  const entries = [
    { kind: 'boundary' as const, digest: new Uint8Array(32).fill(0xd1) },
  ];
  return {
    header,
    headerBytes: encodeServeHeader(header),
    entries,
    entriesBytes: encodeServeEntries(entries),
  };
}

describe('zrdt sendZrdtServed content (JOIN_PLAN §4.3)', () => {
  const bob = PrivateKey.generate();
  const bobKey = new Uint8Array(bob.getPublicKey().serialize());

  it('takes the destination from the header and seals to the checked key', () => {
    const reply = replyFor(bobKey);
    const { destinationAci, content } = buildZrdtServedContent({
      groupId: GROUP,
      reply,
      key: bobKey,
    });
    assert.deepEqual(destinationAci, BOB_ACI);
    const served =
      content && 'zrdtServed' in content ? content.zrdtServed : undefined;
    assert.isOk(served);
    if (!served?.header || !served.ephemeralKey || !served.sealed) {
      return;
    }
    assert.deepEqual(served.header, reply.headerBytes);
    const opened = openServeReply({
      group: GROUP,
      headerBytes: served.header,
      ephemeralKey: served.ephemeralKey,
      sealed: served.sealed,
      ourPrivateKey: bob,
      ourPublicKey: bob.getPublicKey(),
    });
    assert.deepEqual(opened, reply.entriesBytes);
    const attacker = PrivateKey.generate();
    assert.isUndefined(
      openServeReply({
        group: GROUP,
        headerBytes: served.header,
        ephemeralKey: served.ephemeralKey,
        sealed: served.sealed,
        ourPrivateKey: attacker,
        ourPublicKey: attacker.getPublicKey(),
      })
    );
  });

  it('refuses a key other than the one SERVE checked (a host bug)', () => {
    const reply = replyFor(bobKey);
    const swapped = new Uint8Array(
      PrivateKey.generate().getPublicKey().serialize()
    );
    assert.throws(
      () => buildZrdtServedContent({ groupId: GROUP, reply, key: swapped }),
      /not the one SERVE checked/
    );
  });
});
