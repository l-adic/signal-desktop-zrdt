// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Store keys for the apps (zrdt docs/apps/BUILD_M1.md §B.5, docs/zrdt/
// FORK_MAP.md §5). The zrdt service keys stores by string; chats use the
// conversation id. The apps add two kinds of key:
//
// - a channel store: `app:<conversationId>:<channel id hex>`. It is a plain
//   zrdt store (its records persist in zrdt_records like a chat's), and the
//   key carries its group, the channel id, so the service re-opens it after a
//   restart without any other table;
// - a piece store: hex(A's digest) (T-m10), 64 lowercase hex digits. Piece
//   stores live in zrdtd's memory only; after a restart the host binds again.
//
// Neither can be a conversation id (a uuid or base64 group id).

import type { AppTag } from './api.std.ts';
import {
  APP_GIT,
  APP_TORRENT,
  CHANNEL_OF,
  fromHex,
  toHex,
} from './appMessage.std.ts';

type Bytes = Uint8Array<ArrayBuffer>;

export const CHANNEL_KEY_PREFIX = 'app:';

const CHANNEL_KEY = /^app:([^:]+):([0-9a-f]{64})$/;
const PIECE_KEY = /^[0-9a-f]{64}$/;

/** The store key of a channel. */
export function channelKeyOf(conversationId: string, channelId: Bytes): string {
  if (conversationId.includes(':') || conversationId === '') {
    throw new Error(`zrdt apps: not a conversation id: ${conversationId}`);
  }
  if (channelId.length !== 32) {
    throw new Error('zrdt apps: a channel id is 32 bytes');
  }
  return `${CHANNEL_KEY_PREFIX}${conversationId}:${toHex(channelId)}`;
}

export type ParsedChannelKey = Readonly<{
  conversationId: string;
  channelId: Bytes;
}>;

/** The conversation and channel id of a channel key, or undefined. */
export function parseChannelKey(key: string): ParsedChannelKey | undefined {
  const m = CHANNEL_KEY.exec(key);
  if (!m || m[1] === undefined || m[2] === undefined) {
    return undefined;
  }
  const channelId = fromHex(m[2]);
  return channelId === undefined
    ? undefined
    : { conversationId: m[1], channelId };
}

export function isChannelKey(key: string): boolean {
  return CHANNEL_KEY.test(key);
}

/** A piece store's key: hex of A's digest (T-m10). */
export function pieceKeyOf(announcement: Bytes): string {
  if (announcement.length !== 32) {
    throw new Error('zrdt apps: a record digest is 32 bytes');
  }
  return toHex(announcement);
}

export function isPieceKey(key: string): boolean {
  return PIECE_KEY.test(key);
}

/** Whether a store key is an app's, not a chat's. */
export function isAppStoreKey(key: string): boolean {
  return isChannelKey(key) || isPieceKey(key);
}

/** The group id the service opens a key's store with: a channel's id. */
export function groupIdOfAppKey(key: string): Bytes | undefined {
  return parseChannelKey(key)?.channelId;
}

/** The (app, channel name) pairs M1 runs. */
export const APP_CHANNELS: ReadonlyArray<
  Readonly<{ app: AppTag; name: string }>
> = [
  { app: APP_TORRENT, name: CHANNEL_OF[APP_TORRENT] },
  { app: APP_GIT, name: CHANNEL_OF[APP_GIT] },
];

/** The channels this device has opened, by key and by (conversation, app). */
export class ChannelBook {
  readonly #byKey = new Map<
    string,
    Readonly<{ conversationId: string; app: AppTag; channelId: Bytes }>
  >();

  readonly #byConversation = new Map<string, string>();

  static #pairKey(conversationId: string, app: AppTag): string {
    return `${app}\u0000${conversationId}`;
  }

  add(conversationId: string, app: AppTag, channelId: Bytes): string {
    const key = channelKeyOf(conversationId, channelId);
    this.#byKey.set(key, { conversationId, app, channelId });
    this.#byConversation.set(ChannelBook.#pairKey(conversationId, app), key);
    return key;
  }

  keyOf(conversationId: string, app: AppTag): string | undefined {
    return this.#byConversation.get(ChannelBook.#pairKey(conversationId, app));
  }

  get(
    key: string
  ):
    | Readonly<{ conversationId: string; app: AppTag; channelId: Bytes }>
    | undefined {
    return this.#byKey.get(key);
  }

  keys(): Array<string> {
    return [...this.#byKey.keys()];
  }
}
