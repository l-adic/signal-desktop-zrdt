// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';

import { assert } from 'chai';

import { toBase64, toHex } from '../../../../Bytes.std.ts';
import type { BtShareQuestion } from '../../../../zrdt/apps/bt/manager.std.ts';
import {
  BtManager,
  PIECE_BYTES,
} from '../../../../zrdt/apps/bt/manager.std.ts';
import type {
  BtEndpointResponse,
  BtGroup,
} from '../../../../zrdt/apps/bt/routes.std.ts';
import {
  BtRoutes,
  UPLOAD_TTL_MS,
} from '../../../../zrdt/apps/bt/routes.std.ts';
import { FakeBtApi, fileBytes } from './fakeBtApi.std.ts';
import { MemoryWriter } from './memoryWriter.std.ts';

function sha256(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

const CAMPING: BtGroup = {
  conversationId: 'conv-camping',
  title: 'Camping',
  memberCount: 4,
};

function setup(answer = true) {
  const api = new FakeBtApi();
  const questions: Array<BtShareQuestion> = [];
  const manager = new BtManager({
    api,
    writer: new MemoryWriter(),
    confirmShare: async q => {
      questions.push(q);
      return answer;
    },
  });
  let now = 1_000_000;
  let nextId = 1;
  const routes = new BtRoutes({
    manager,
    findGroup: alias => (alias === 'Camping' ? CAMPING : undefined),
    self: () => ({ aci: 'aci-alice', name: 'Alice' }),
    sha256,
    randomId: () => {
      const id = `u${nextId}`;
      nextId += 1;
      return id;
    },
    now: () => now,
  });
  const call = (method: string, url: string, payload?: unknown) =>
    routes.handle({ method, url, body: payload });
  const advance = (ms: number) => {
    now += ms;
  };
  return { api, questions, manager, routes, call, advance };
}

function body(r: BtEndpointResponse): Record<string, unknown> {
  return r.body as Record<string, unknown>;
}

async function upload(
  call: ReturnType<typeof setup>['call'],
  bytes: Uint8Array<ArrayBuffer>
): Promise<string> {
  const created = await call('POST', '/v1/bt/Camping/uploads', {
    size: bytes.byteLength,
  });
  assert.strictEqual(created.status, 201);
  const id = String(body(created).upload);
  const pieces = Number(body(created).pieces);
  for (let i = 0; i < pieces; i += 1) {
    const slice = bytes.slice(i * PIECE_BYTES, (i + 1) * PIECE_BYTES);
    // oxlint-disable-next-line no-await-in-loop
    const put = await call('PUT', `/v1/bt/Camping/uploads/${id}/pieces/${i}`, {
      sha256: toHex(sha256(slice)),
      data: toBase64(slice),
    });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  }
  return id;
}

describe('zrdt/apps/bt/routes', () => {
  it('hello names the app and the limits', async () => {
    const { call } = setup();
    const r = await call('GET', '/v1/hello');
    assert.strictEqual(r.status, 200);
    assert.deepEqual(r.body, {
      protocol: 1,
      app: 'bt',
      member: 'Alice',
      pieceSize: PIECE_BYTES,
      maxStream: 64 * PIECE_BYTES,
    });
    assert.strictEqual((await call('POST', '/v1/hello')).status, 405);
  });

  it('a group we are not in looks like one that does not exist', async () => {
    const { call } = setup();
    const r = await call('GET', '/v1/bt/Work');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(body(r).error, 'no_group');
    assert.strictEqual((await call('GET', '/v1/git/Camping')).status, 404);
    assert.strictEqual((await call('GET', '/v1/bt/%E0%A4%A')).status, 400);
  });

  it('share: hand-over, the dialog, then the file in the list', async () => {
    const { call, questions, manager } = setup(true);
    const bytes = fileBytes(2 * PIECE_BYTES + 100);
    const id = await upload(call, bytes);
    const shared = await call('POST', '/v1/bt/Camping/shares', {
      upload: id,
      name: 'trip.mp4',
    });
    assert.strictEqual(shared.status, 200);
    assert.strictEqual(body(shared).status, 'ok');
    assert.strictEqual(body(shared).audience, 4);
    assert.lengthOf(questions, 1);
    assert.strictEqual(questions[0]?.name, 'trip.mp4');
    assert.strictEqual(questions[0]?.size, bytes.byteLength);

    const listed = await call('GET', '/v1/bt/Camping');
    assert.strictEqual(listed.status, 200);
    const files = body(listed).files as Array<Record<string, unknown>>;
    assert.lengthOf(files, 1);
    assert.include(files[0], {
      name: 'trip.mp4',
      self: true,
      state: 'checked',
      pieces: 3,
      checked: 3,
      from: 'Alice',
    });
    const file = String(body(shared).file);
    const one = await call('GET', `/v1/bt/Camping/files/${file}`);
    assert.strictEqual(one.status, 200);
    assert.strictEqual(body(one).file, file);
    assert.strictEqual(manager.transfers().length, 1);

    // The hand-over is consumed.
    const again = await call('POST', '/v1/bt/Camping/shares', {
      upload: id,
      name: 'trip.mp4',
    });
    assert.strictEqual(again.status, 404);
  });

  it('declined in the dialog: 409 DECLINED, nothing published', async () => {
    const { call, api } = setup(false);
    const id = await upload(call, fileBytes(10));
    const r = await call('POST', '/v1/bt/Camping/shares', {
      upload: id,
      name: 'trip.mp4',
    });
    assert.strictEqual(r.status, 409);
    assert.include(r.body as object, { status: 'refused', reason: 'DECLINED' });
    assert.lengthOf(api.calls, 0);
  });

  it('an unsafe name is refused before the dialog', async () => {
    const { call, questions } = setup(true);
    const id = await upload(call, fileBytes(10));
    const r = await call('POST', '/v1/bt/Camping/shares', {
      upload: id,
      name: '../../x',
    });
    assert.strictEqual(r.status, 409);
    assert.include(r.body as object, { reason: 'BAD_NAME' });
    assert.lengthOf(questions, 0);
  });

  it('hand-over checks: size, index, length, hash, completeness, expiry', async () => {
    const { call, advance } = setup();
    assert.strictEqual(
      (await call('POST', '/v1/bt/Camping/uploads', { size: 0 })).status,
      413
    );
    assert.strictEqual(
      (
        await call('POST', '/v1/bt/Camping/uploads', {
          size: 64 * PIECE_BYTES + 1,
        })
      ).status,
      413
    );
    assert.strictEqual(
      (await call('POST', '/v1/bt/Camping/uploads', { size: '5' })).status,
      400
    );
    const created = await call('POST', '/v1/bt/Camping/uploads', {
      size: PIECE_BYTES + 3,
    });
    const id = String(body(created).upload);
    const piece = (i: string, data: Uint8Array<ArrayBuffer>, hash?: string) =>
      call('PUT', `/v1/bt/Camping/uploads/${id}/pieces/${i}`, {
        sha256: hash ?? toHex(sha256(data)),
        data: toBase64(data),
      });
    assert.strictEqual((await piece('2', fileBytes(3))).status, 400);
    assert.strictEqual((await piece('01', fileBytes(3))).status, 400);
    const short = await piece('1', fileBytes(2));
    assert.strictEqual(short.status, 400);
    assert.strictEqual(body(short).error, 'bad_piece');
    const wrongHash = await piece('1', fileBytes(3), '00'.repeat(32));
    assert.strictEqual(body(wrongHash).error, 'bad_piece');
    assert.strictEqual((await piece('1', fileBytes(3))).status, 200);

    const incomplete = await call('POST', '/v1/bt/Camping/shares', {
      upload: id,
      name: 'x.bin',
    });
    assert.strictEqual(incomplete.status, 400);
    assert.match(String(body(incomplete).message), /piece 1 not uploaded/);

    advance(UPLOAD_TTL_MS + 1);
    assert.strictEqual((await piece('1', fileBytes(3))).status, 404);
  });

  it('wrong methods and unknown paths', async () => {
    const { call } = setup();
    assert.strictEqual((await call('POST', '/v1/bt/Camping')).status, 405);
    assert.strictEqual(
      (await call('GET', '/v1/bt/Camping/uploads')).status,
      405
    );
    assert.strictEqual(
      (await call('GET', '/v1/bt/Camping/shares')).status,
      405
    );
    assert.strictEqual((await call('GET', '/v1/bt/Camping/nope')).status, 404);
    assert.strictEqual(
      (await call('GET', '/v1/bt/Camping/files/abc')).status,
      404
    );
  });

  it('never reports a pointer, an opening, a nonce or a piece key', async () => {
    const { call, api, manager } = setup();
    const bob = { aci: 'aci-bob', name: 'Bob' };
    const a = api.addFile({
      name: 'trip.mp4',
      bytes: fileBytes(PIECE_BYTES + 1),
      author: bob,
    });
    // The receiver side, as lane transport will call it.
    await manager.onAnnouncement({
      conversationId: CAMPING.conversationId,
      announcement: a,
      author: bob,
      confirmedByAuthor: true,
    });
    const listed = await call('GET', '/v1/bt/Camping');
    const files = body(listed).files as Array<Record<string, unknown>>;
    assert.lengthOf(files, 1);
    assert.deepEqual(Object.keys(files[0] ?? {}).sort(), [
      'checked',
      'failure',
      'file',
      'from',
      'id',
      'name',
      'notices',
      'pieceStates',
      'pieces',
      'resent',
      'savedTo',
      'self',
      'size',
      'state',
      'status',
    ]);
    assert.include(files[0], {
      file: a,
      from: 'Bob',
      self: false,
      state: 'checked',
    });
    const text = JSON.stringify(listed.body).toLowerCase();
    for (const word of [
      'pointer',
      'opening',
      'nonce',
      'cdnkey',
      'piecekey',
      'digest',
    ]) {
      assert.notInclude(text, word);
    }
  });
});
