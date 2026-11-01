// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as sinon from 'sinon';

import { SignalService as Proto } from '../../protobuf/index.std.ts';
import * as Bytes from '../../Bytes.std.ts';
import type { MessageAttributesType } from '../../model-types.d.ts';
import type { ZrdtSendAttributesType } from '../../types/Zrdt.std.ts';
import {
  StubBackend,
  commitment,
  encodeRecord,
  makeRecord,
  removeTopLevelFields,
} from '../../zrdt/backends/stub.node.ts';
import { messageSender } from '../../textsecure/SendMessage.preload.ts';
import type {
  GroupMessageOptionsType,
  ZrdtMetaSendType,
} from '../../textsecure/SendMessage.preload.ts';
import {
  ZRDT_META_VERSION,
  freezeZrdtSend,
  getFrozenDataMessage,
  isZrdtGroupSend,
  reacceptOutgoingMessages,
} from '../../zrdt/send.preload.ts';
import type {
  ZrdtFreezableMessageType,
  ZrdtMessageUpdateType,
  ZrdtSendServiceType,
} from '../../zrdt/send.preload.ts';
import { generateAci } from '../../test-helpers/serviceIdUtils.std.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { createLogger } from '../../logging/log.std.ts';

const log = createLogger('zrdt/send_test');

type Bytes = Uint8Array<ArrayBuffer>;

const CHAT = 'conversation-1';
const GROUP_ID = new Uint8Array(32).fill(7);
const OUR_ACI = new Uint8Array(16).fill(1);
const OTHER_ACI = new Uint8Array(16).fill(2);
const MASTER_KEY = new Uint8Array(32).fill(9);
// Serialized identity keys (33 bytes); the stub only hashes them.
const OUR_KEY = new Uint8Array(33).fill(0x05);
const OTHER_KEY = new Uint8Array(33).fill(0x06);
const AUDIENCE_MEMBERS = [
  { aci: OUR_ACI, key: OUR_KEY },
  { aci: OTHER_ACI, key: OTHER_KEY },
];
// A fixed field-201 value for the toProto tests.
const AUDIENCE_BYTES = new Uint8Array(32).fill(0x0a);

function fill(byte: number, size = 32): Bytes {
  return new Uint8Array(size).fill(byte);
}

// A zrdtService fake over the TypeScript stub backend: COMMIT + ACCEPT as
// T0's acceptOwn does (minus the SQL rows), with a call log.
class FakeService implements ZrdtSendServiceType {
  readonly backend = new StubBackend({ env: {} });

  readonly calls = new Array<string>();

  readonly acceptOwnArgs = new Array<
    Parameters<ZrdtSendServiceType['acceptOwn']>[1]
  >();

  disown = new Array<Bytes>();

  failNextAccept = false;

  async init(): Promise<void> {
    await this.backend.create(CHAT, GROUP_ID);
  }

  ensureConversation = async (): Promise<void> => {
    this.calls.push('ensureConversation');
  };

  heads = async (conversationId: string): Promise<Array<Bytes>> => {
    this.calls.push('heads');
    return this.backend.heads(conversationId);
  };

  disownSet = async (): Promise<Array<Bytes>> => {
    this.calls.push('disownSet');
    return this.disown;
  };

  has = async (conversationId: string, digest: Bytes): Promise<boolean> => {
    this.calls.push('has');
    return this.backend.has(conversationId, digest);
  };

  audience = async (
    members: Parameters<ZrdtSendServiceType['audience']>[0]
  ): Promise<Bytes | 'tooLarge'> => {
    this.calls.push('audience');
    const result = await this.backend.audience(members);
    return result.kind === 'ok' ? result.audience : 'tooLarge';
  };

  acceptOwn = async (
    conversationId: string,
    a: Parameters<ZrdtSendServiceType['acceptOwn']>[1]
  ): Promise<{ digest: Bytes; record: Bytes; opening: Bytes }> => {
    this.calls.push('acceptOwn');
    this.acceptOwnArgs.push(a);
    if (this.failNextAccept) {
      this.failNextAccept = false;
      throw new Error('zrdtd unavailable');
    }
    const commit = commitment(
      a.groupId,
      a.authorAci,
      a.nonce,
      a.dataMessageBytes
    );
    const parts = {
      group: a.groupId,
      commit,
      links: a.links,
      author: a.authorAci,
    };
    const committed = removeTopLevelFields(
      a.dataMessageBytes,
      new Set([15, 200])
    );
    assert.isDefined(committed, 'dataMessageBytes must parse');
    // As the service does: ACCEPT with the opening (its audience is recorded).
    const result = await this.backend.accept(
      conversationId,
      parts,
      Bytes.concatenate([a.nonce, committed ?? new Uint8Array(0)])
    );
    if (result.kind !== 'accepted') {
      throw new Error(`acceptOwn: ${result.kind}`);
    }
    return {
      digest: result.digest,
      record: encodeRecord(makeRecord(parts)),
      opening: Bytes.concatenate([a.nonce, committed]),
    };
  };
}

type FakeMessage = ZrdtFreezableMessageType & {
  attributes: ZrdtMessageUpdateType;
  saves: Array<ZrdtMessageUpdateType>;
};

function makeMessage(
  calls: Array<string>,
  zrdt?: ZrdtSendAttributesType
): FakeMessage {
  const message: FakeMessage = {
    idForLogging: 'message-1',
    attributes: { zrdt },
    saves: [],
    getZrdt: () => message.attributes.zrdt,
    update: async attributes => {
      calls.push(
        `save:${attributes.zrdt?.digest === '' ? 'frozen' : 'accepted'}`
      );
      message.attributes = { ...message.attributes, ...attributes };
      message.saves.push(structuredClone(message.attributes));
    },
  };
  return message;
}

function frozenOf(message: FakeMessage): ZrdtSendAttributesType {
  const { zrdt } = message.attributes;
  assert.isOk(zrdt);
  return zrdt;
}

function digestOf(message: FakeMessage): string {
  const digest = message.attributes.zrdt?.digest;
  assert.isString(digest);
  return digest ?? '';
}

let timestamp = 1_700_000_000_000;

function makeBuildContent(
  body: string,
  built: Array<ZrdtMetaSendType>
): (zrdt: ZrdtMetaSendType) => Promise<Proto.Content.Params> {
  timestamp += 1000;
  const ts = timestamp;
  return zrdt => {
    built.push(zrdt);
    return messageSender.getContentMessage({
      timestamp: ts,
      body,
      bodyRanges: [{ start: 0, length: 1, style: Proto.BodyRange.Style.BOLD }],
      expireTimer: undefined,
      groupV2: { masterKey: MASTER_KEY, revision: 4, members: [] },
      profileKey: fill(5),
      recipients: [],
      zrdt,
    });
  };
}

describe('zrdt/send: freeze once', () => {
  let service: FakeService;
  let nonceByte: number;

  beforeEach(async () => {
    service = new FakeService();
    await service.init();
    nonceByte = 0x40;
  });

  function getRandomBytes(size: number): Bytes {
    nonceByte += 1;
    return fill(nonceByte, size);
  }

  async function freeze(
    message: FakeMessage,
    body = 'hello',
    built = new Array<ZrdtMetaSendType>()
  ): Promise<Proto.Content.Params> {
    return freezeZrdtSend({
      conversationId: CHAT,
      groupId: GROUP_ID,
      ourAci: OUR_ACI,
      message,
      buildContent: makeBuildContent(body, built),
      getAudienceMembers: async () => AUDIENCE_MEMBERS,
      service,
      getRandomBytes,
      log,
    });
  }

  it('Message.toProto carries ZrdtMeta in DataMessage.zrdt (field 200)', async () => {
    const links = [fill(1), fill(2)];
    const disown = [fill(3)];
    const content = await makeBuildContent(
      'hi',
      []
    )({
      links,
      nonce: fill(4),
      version: ZRDT_META_VERSION,
      disown,
      audience: AUDIENCE_BYTES,
    });
    const decoded = Proto.Content.decode(Proto.Content.encode(content));
    const zrdt = decoded.content?.dataMessage?.zrdt;
    assert.isOk(zrdt);
    assert.deepEqual(zrdt?.links, links);
    assert.deepEqual(zrdt?.nonce, fill(4));
    assert.strictEqual(zrdt?.version, 3);
    assert.deepEqual(zrdt?.disown, disown);
    // The audience is DataMessage field 201.
    assert.deepEqual(
      decoded.content?.dataMessage?.zrdtAudience,
      AUDIENCE_BYTES
    );

    // An empty ZrdtMeta (first message: no heads) is still on the wire.
    const first = await makeBuildContent(
      'hi',
      []
    )({
      links: [],
      nonce: fill(4),
      version: ZRDT_META_VERSION,
      disown: [],
      audience: AUDIENCE_BYTES,
    });
    const firstDecoded = Proto.Content.decode(Proto.Content.encode(first));
    assert.isOk(firstDecoded.content?.dataMessage?.zrdt);

    // Without zrdt, nothing changes.
    const plain = await messageSender.getContentMessage({
      timestamp: 1,
      body: 'x',
      recipients: [generateAci()],
    });
    assert.isNull(plain.content?.dataMessage?.zrdt);
  });

  it('first attempt: heads, nonce, disown, persist frozen, accept, persist digest', async () => {
    service.disown = [fill(0xdd)];
    const message = makeMessage(service.calls);
    const built = new Array<ZrdtMetaSendType>();
    const content = await freeze(message, 'hello', built);

    assert.deepEqual(service.calls, [
      'heads',
      'disownSet',
      'audience',
      'save:frozen',
      'acceptOwn',
      'save:accepted',
    ]);
    assert.lengthOf(built, 1);
    assert.deepEqual(built[0]?.links, []);
    assert.deepEqual(built[0]?.disown, [fill(0xdd)]);
    assert.strictEqual(built[0]?.nonce.byteLength, 32);

    const frozen = message.attributes.zrdt;
    assert.isOk(frozen);
    const { nonce, contentBytes, digest, links } = frozen;
    assert.strictEqual(nonce, Bytes.toHex(fill(0x41)));
    assert.deepEqual(links, []);
    assert.match(digest, /^[0-9a-f]{64}$/);

    // The first save already holds the frozen bytes, before ACCEPT.
    assert.strictEqual(message.saves[0]?.zrdt?.digest, '');
    assert.strictEqual(message.saves[0]?.zrdt?.contentBytes, contentBytes);

    // The Content we send is exactly the frozen bytes.
    assert.deepEqual(
      Proto.Content.encode(content),
      Bytes.fromBase64(contentBytes)
    );

    // ACCEPT saw the DataMessage bytes of the frozen Content.
    const args = service.acceptOwnArgs[0];
    const { dataMessageBytes } = getFrozenDataMessage(
      Bytes.fromBase64(contentBytes)
    );
    assert.deepEqual(args?.dataMessageBytes, dataMessageBytes);
    assert.deepEqual(args?.nonce, fill(0x41));
    assert.deepEqual(args?.groupId, GROUP_ID);
    assert.deepEqual(args?.authorAci, OUR_ACI);

    // UI and lookup attributes
    assert.strictEqual(message.attributes.zrdtDigest, digest);
    assert.deepEqual(message.attributes.zrdtProvenance, { kind: 'live' });
    const opening = Bytes.fromBase64(message.attributes.zrdtOpening ?? '');
    assert.deepEqual(opening.subarray(0, 32), fill(0x41));
    // The opening never carries the group master key (field 15) or field 200.
    const openedMessage = Proto.DataMessage.decode(opening.slice(32));
    assert.isNull(openedMessage.groupV2);
    assert.isNull(openedMessage.zrdt);
    assert.strictEqual(openedMessage.body, 'hello');

    assert.isTrue(await service.backend.has(CHAT, Bytes.fromHex(digest)));

    // JOIN_PLAN §3.2: the opening commits the audience (field 201), and the
    // backend recorded it: both members are seated under their keys.
    const expected = await service.backend.audience(AUDIENCE_MEMBERS);
    assert.strictEqual(expected.kind, 'ok');
    assert.deepEqual(
      openedMessage.zrdtAudience,
      expected.kind === 'ok' ? expected.audience : undefined
    );
    for (const { aci, key } of AUDIENCE_MEMBERS) {
      // oxlint-disable-next-line no-await-in-loop
      assert.deepEqual(await service.backend.addressed(CHAT, aci, key), [
        Bytes.fromHex(digest),
      ]);
    }
    assert.deepEqual(
      await service.backend.addressed(CHAT, OTHER_ACI, OUR_KEY),
      [],
      'a member under another key is not seated'
    );
  });

  it('retry: sends the same bytes, never recomputes links', async () => {
    const message = makeMessage(service.calls);
    const first = Proto.Content.encode(await freeze(message, 'one'));
    const frozen = message.attributes.zrdt;

    // Another record arrives: the heads change.
    const other = makeMessage([]);
    await freeze(other, 'two');
    service.calls.length = 0;

    const built = new Array<ZrdtMetaSendType>();
    const second = Proto.Content.encode(await freeze(message, 'one', built));
    assert.deepEqual(second, first);
    assert.lengthOf(built, 0, 'no rebuild');
    assert.deepEqual(service.calls, ['has'], 'no heads, no accept');
    assert.deepEqual(message.attributes.zrdt, frozen);
  });

  it('a second message links the first (sends are serialised per chat)', async () => {
    const m1 = makeMessage([]);
    await freeze(m1, 'one');
    const m2 = makeMessage([]);
    const built = new Array<ZrdtMetaSendType>();
    await freeze(m2, 'two', built);
    assert.deepEqual(
      built[0]?.links.map(l => Bytes.toHex(l)),
      [digestOf(m1)]
    );
    assert.deepEqual(m2.attributes.zrdt?.links, [digestOf(m1)]);
  });

  it('ACCEPT fails: frozen bytes are kept; the retry accepts the same record', async () => {
    const m0 = makeMessage([]);
    await freeze(m0, 'zero');

    service.failNextAccept = true;
    const message = makeMessage(service.calls);
    let error: unknown;
    try {
      await freeze(message, 'one');
    } catch (e) {
      error = e;
    }
    assert.instanceOf(error, Error);
    const frozen = message.attributes.zrdt;
    assert.strictEqual(frozen?.digest, '');
    assert.deepEqual(frozen?.links, [digestOf(m0)]);

    // Meanwhile a new head appears; the retry must not pick it up.
    await freeze(makeMessage([]), 'meanwhile');
    service.calls.length = 0;

    const built = new Array<ZrdtMetaSendType>();
    const content = await freeze(message, 'one', built);
    assert.lengthOf(built, 0);
    assert.deepEqual(service.calls, ['acceptOwn', 'save:accepted']);
    const last = service.acceptOwnArgs.at(-1);
    assert.deepEqual(
      last?.links.map(l => Bytes.toHex(l)),
      [digestOf(m0)]
    );
    assert.deepEqual(
      Proto.Content.encode(content),
      Bytes.fromBase64(frozenOf(message).contentBytes)
    );
    assert.match(message.attributes.zrdt?.digest ?? '', /^[0-9a-f]{64}$/);
    assert.strictEqual(
      message.attributes.zrdtDigest,
      message.attributes.zrdt?.digest
    );
  });

  it('retry with a digest the store lost: re-accepts the frozen bytes', async () => {
    const message = makeMessage([]);
    await freeze(message, 'one');
    const frozen = message.attributes.zrdt;

    // A fresh store (e.g. rebuilt from rows that lacked this record)
    service = new FakeService();
    await service.init();
    const resumed = makeMessage(service.calls, frozen);
    await freeze(resumed, 'one');
    assert.deepEqual(service.calls, ['has', 'acceptOwn', 'save:accepted']);
    assert.strictEqual(resumed.attributes.zrdt?.digest, frozen?.digest);
    assert.isTrue(
      await service.backend.has(CHAT, Bytes.fromHex(digestOf(resumed)))
    );
  });

  it('reacceptOutgoingMessages re-accepts only our stored-digest messages the store lacks', async () => {
    const m1 = makeMessage([]);
    await freeze(m1, 'one');
    const m2 = makeMessage([]);
    await freeze(m2, 'two');

    service = new FakeService();
    await service.init();

    const messages: Array<Pick<MessageAttributesType, 'id' | 'type' | 'zrdt'>> =
      [
        { id: 'in', type: 'incoming', zrdt: m1.attributes.zrdt },
        {
          id: 'pending',
          type: 'outgoing',
          zrdt: { ...frozenOf(m2), digest: '' },
        },
        { id: 'plain', type: 'outgoing' },
        { id: 'm1', type: 'outgoing', zrdt: m1.attributes.zrdt },
        { id: 'm2', type: 'outgoing', zrdt: m2.attributes.zrdt },
      ];
    const count = await reacceptOutgoingMessages({
      conversationId: CHAT,
      groupId: GROUP_ID,
      ourAci: OUR_ACI,
      messages,
      service,
      log,
    });
    assert.strictEqual(count, 2);
    assert.deepEqual(await service.backend.heads(CHAT), [
      Bytes.fromHex(digestOf(m2)),
    ]);

    // A second pass finds everything stored.
    assert.strictEqual(
      await reacceptOutgoingMessages({
        conversationId: CHAT,
        groupId: GROUP_ID,
        ourAci: OUR_ACI,
        messages,
        service,
        log,
      }),
      0
    );
  });

  it('reacceptOutgoingMessages re-accepts in any order (a record linking one we lost)', async () => {
    const m1 = makeMessage([]);
    await freeze(m1, 'one');
    const m2 = makeMessage([]);
    await freeze(m2, 'two');
    // m2 links m1.
    assert.deepEqual(m2.attributes.zrdt?.links, [digestOf(m1)]);

    service = new FakeService();
    await service.init();
    const count = await reacceptOutgoingMessages({
      conversationId: CHAT,
      groupId: GROUP_ID,
      ourAci: OUR_ACI,
      messages: [
        { id: 'm2', type: 'outgoing', zrdt: m2.attributes.zrdt },
        { id: 'm1', type: 'outgoing', zrdt: m1.attributes.zrdt },
      ],
      service,
      log,
    });
    assert.strictEqual(count, 2);
    assert.deepEqual(await service.backend.heads(CHAT), [
      Bytes.fromHex(digestOf(m2)),
    ]);
  });

  it('reacceptOutgoingMessages stops when a pass re-accepts nothing', async () => {
    const m1 = makeMessage([]);
    await freeze(m1, 'one');
    const m2 = makeMessage([]);
    await freeze(m2, 'two');

    service = new FakeService();
    await service.init();
    // m1 is not in the list, so m2 never resolves.
    const count = await reacceptOutgoingMessages({
      conversationId: CHAT,
      groupId: GROUP_ID,
      ourAci: OUR_ACI,
      messages: [{ id: 'm2', type: 'outgoing', zrdt: m2.attributes.zrdt }],
      service,
      log,
    });
    assert.strictEqual(count, 0);
    assert.deepEqual(
      service.calls.filter(call => call === 'acceptOwn'),
      ['acceptOwn']
    );
  });

  it('rich content (attachments, quote, preview, mentions) re-encodes byte for byte', async () => {
    const aci = generateAci();
    const attachment: Proto.AttachmentPointer.Params = {
      attachmentIdentifier: { cdnKey: 'abc123' },
      clientUuid: fill(0x11, 16),
      contentType: 'image/jpeg',
      key: fill(0x12, 64),
      size: 12345,
      thumbnail: null,
      digest: fill(0x13),
      incrementalMac: null,
      chunkSize: null,
      fileName: 'cat.jpg',
      flags: 0,
      width: 640,
      height: 480,
      caption: null,
      blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
      uploadTimestamp: 1_700_000_000_000n,
      cdnNumber: 3,
      audioWaveform: null,
      audioDurationSeconds: null,
    };
    const content = await messageSender.getContentMessage({
      timestamp: 1_700_000_123_456,
      body: '\uFFFC look at this https://signal.org',
      bodyRanges: [{ start: 0, length: 1, mentionAci: aci }],
      attachments: [attachment],
      quote: {
        id: 1_700_000_000_001,
        authorAci: aci,
        text: 'earlier',
        attachments: [],
        bodyRanges: [],
      },
      preview: [
        { url: 'https://signal.org', title: 'Signal', date: 1_600_000_000_000 },
      ],
      expireTimer: undefined,
      groupV2: { masterKey: MASTER_KEY, revision: 4, members: [] },
      profileKey: fill(5),
      recipients: [],
      zrdt: {
        links: [fill(1)],
        nonce: fill(2),
        version: ZRDT_META_VERSION,
        disown: [],
        audience: AUDIENCE_BYTES,
      },
    });
    const once = Proto.Content.encode(content);
    const twice = Proto.Content.encode(Proto.Content.decode(once));
    assert.deepEqual(twice, once);
    const { dataMessage, dataMessageBytes } = getFrozenDataMessage(once);
    assert.deepEqual(
      Proto.DataMessage.encode(Proto.DataMessage.decode(dataMessageBytes)),
      dataMessageBytes
    );
    assert.strictEqual(dataMessage.attachments.length, 1);
    assert.isOk(dataMessage.quote);
    assert.isOk(dataMessage.zrdt);
  });

  it('rejects a bad group id or ACI', async () => {
    for (const [groupId, ourAci] of [
      [fill(1, 31), OUR_ACI],
      [GROUP_ID, OTHER_ACI.subarray(0, 15)],
    ] as const) {
      let error: unknown;
      try {
        // oxlint-disable-next-line no-await-in-loop
        await freezeZrdtSend({
          conversationId: CHAT,
          groupId: new Uint8Array(groupId),
          ourAci: new Uint8Array(ourAci),
          message: makeMessage([]),
          buildContent: makeBuildContent('x', []),
          getAudienceMembers: async () => AUDIENCE_MEMBERS,
          service,
          log,
        });
      } catch (e) {
        error = e;
      }
      assert.instanceOf(error, Error);
    }
  });
});

describe('zrdt/send: isZrdtGroupSend', () => {
  const groupSendOptions: GroupMessageOptionsType = {
    timestamp: 1,
    body: 'hi',
    groupV2: {
      masterKey: MASTER_KEY,
      revision: 1,
      members: [generateAci()],
    },
  };

  it('a GroupV2 normal message is in scope', () => {
    assert.isTrue(
      isZrdtGroupSend({
        isGroupV2: true,
        editedMessageTimestamp: undefined,
        groupSendOptions,
      })
    );
  });

  it('edits, story replies, reactions, polls and GroupV1 are out', () => {
    const cases: Array<Parameters<typeof isZrdtGroupSend>[0]> = [
      { isGroupV2: false, editedMessageTimestamp: undefined, groupSendOptions },
      { isGroupV2: true, editedMessageTimestamp: 5, groupSendOptions },
      {
        isGroupV2: true,
        editedMessageTimestamp: undefined,
        groupSendOptions: { ...groupSendOptions, targetTimestampForEdit: 5 },
      },
      {
        isGroupV2: true,
        editedMessageTimestamp: undefined,
        groupSendOptions: {
          ...groupSendOptions,
          storyContext: { timestamp: 1, authorAci: generateAci() },
        },
      },
      {
        isGroupV2: true,
        editedMessageTimestamp: undefined,
        groupSendOptions: {
          ...groupSendOptions,
          reaction: {
            remove: false,
            targetAuthorAci: generateAci(),
            targetTimestamp: 1,
          },
        },
      },
      {
        isGroupV2: true,
        editedMessageTimestamp: undefined,
        groupSendOptions: {
          ...groupSendOptions,
          pollCreate: {
            question: 'q',
            options: ['a', 'b'],
            allowMultiple: false,
          },
        },
      },
    ];
    for (const options of cases) {
      assert.isFalse(isZrdtGroupSend(options));
    }
  });
});

describe('zrdt/send: getAttrsFromGroupOptions', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('passes zrdt through to Message.toProto', async () => {
    const ourAci = generateAci();
    const other = generateAci();
    sandbox.stub(itemStorage.user, 'getCheckedAci').returns(ourAci);
    sandbox
      .stub(itemStorage.blocked, 'getBlockedServiceIds')
      .returns(new Map());
    sandbox.stub(itemStorage.blocked, 'getBlockedNumbers').returns(new Map());

    const zrdt: ZrdtMetaSendType = {
      links: [fill(1)],
      nonce: fill(2),
      version: ZRDT_META_VERSION,
      disown: [fill(3)],
      audience: AUDIENCE_BYTES,
    };
    const attrs = messageSender.getAttrsFromGroupOptions({
      timestamp: 1,
      body: 'hi',
      groupV2: {
        masterKey: MASTER_KEY,
        revision: 1,
        members: [ourAci, other],
      },
      zrdt,
    });
    assert.strictEqual(attrs.zrdt, zrdt);
    assert.deepEqual(attrs.recipients, [other]);

    const content = await messageSender.getContentMessage(attrs);
    const decoded = Proto.Content.decode(Proto.Content.encode(content));
    assert.deepEqual(decoded.content?.dataMessage?.zrdt?.links, [fill(1)]);
    assert.deepEqual(decoded.content?.dataMessage?.zrdt?.disown, [fill(3)]);
  });
});
