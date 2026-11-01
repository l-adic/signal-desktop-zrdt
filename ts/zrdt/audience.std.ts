// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// The author's audience: DataMessage field 201 (zrdt docs/JOIN_PLAN.md
// section 3.2). Reading it is host code in the trusted base (JOIN_PLAN §9,
// "reading field 201 joins the unproved protobuf scan"); it mirrors
// `audienceOf`, `parseAudience` and `ephemeral` of the Lean `Zrdt.Serve`, so
// the host and zrdtd read the same bytes the same way. Nothing here hashes:
// key tags come from zrdtd (AUDIENCE) and from the seal module.
//
//   zrdtAudience = n entries, 1 <= n <= 256, strictly increasing by aci
//   entry        = aci(16) ‖ keyTag(16); keyTag 16 zero bytes = not seated

import {
  ACI_BYTES,
  AUDIENCE_ENTRY_BYTES,
  MAX_AUDIENCE,
  NONCE_BYTES,
} from './ZrdtBackend.std.ts';

type Bytes = Uint8Array<ArrayBuffer>;

/** DataMessage field 201: the audience. */
const AUDIENCE_FIELD = 201;

/** DataMessage fields 5 (expireTimer) and 14 (isViewOnce). */
const FIELD_EXPIRE_TIMER = 5;
const FIELD_IS_VIEW_ONCE = 14;

/** One audience entry. `seated` is false for the zero tag. */
export type Seat = Readonly<{ aci: Bytes; tag: Bytes; seated: boolean }>;

type TopField = Readonly<{
  num: number;
  wireType: number;
  /** Where the value starts (after the key, and after the length for LEN). */
  valueStart: number;
  /** Just after the value. */
  stop: number;
}>;

function readVarint(
  bytes: Bytes,
  offset: number
): { value: number; next: number } | undefined {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) {
      return undefined;
    }
    value += (byte % 128) * scale;
    scale *= 128;
    if (byte < 128) {
      return { value, next: offset + i + 1 };
    }
  }
  return undefined;
}

/**
 * The top-level fields of a protobuf message, or undefined if it is not a
 * sequence of well-formed fields (Lean `fields`: wire types 0, 1, 2, 5; a
 * key below 2^32 with a field number of at least 1).
 */
function topFields(message: Bytes): Array<TopField> | undefined {
  const out = new Array<TopField>();
  let offset = 0;
  while (offset < message.length) {
    const key = readVarint(message, offset);
    if (key === undefined || key.value >= 2 ** 32) {
      return undefined;
    }
    const num = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (num === 0) {
      return undefined;
    }
    let valueStart = key.next;
    let stop: number;
    if (wireType === 0) {
      const v = readVarint(message, key.next);
      if (v === undefined) {
        return undefined;
      }
      stop = v.next;
    } else if (wireType === 1) {
      stop = key.next + 8;
    } else if (wireType === 2) {
      const len = readVarint(message, key.next);
      if (len === undefined) {
        return undefined;
      }
      valueStart = len.next;
      stop = len.next + len.value;
    } else if (wireType === 5) {
      stop = key.next + 4;
    } else {
      return undefined;
    }
    if (stop > message.length) {
      return undefined;
    }
    out.push({ num, wireType, valueStart, stop });
    offset = stop;
  }
  return out;
}

function isZero(bytes: Bytes): boolean {
  return bytes.every(byte => byte === 0);
}

function compareBytes(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return a.length - b.length;
}

/**
 * Field-201 bytes as entries (Lean `parseAudience`): 1 to 256 entries of 32
 * bytes, strictly increasing by ACI. Undefined otherwise.
 */
export function parseAudience(bytes: Bytes): Array<Seat> | undefined {
  if (
    bytes.length % AUDIENCE_ENTRY_BYTES !== 0 ||
    bytes.length < AUDIENCE_ENTRY_BYTES ||
    bytes.length > AUDIENCE_ENTRY_BYTES * MAX_AUDIENCE
  ) {
    return undefined;
  }
  const seats = new Array<Seat>();
  for (let i = 0; i < bytes.length; i += AUDIENCE_ENTRY_BYTES) {
    const aci = bytes.slice(i, i + ACI_BYTES);
    const tag = bytes.slice(i + ACI_BYTES, i + AUDIENCE_ENTRY_BYTES);
    const previous = seats.at(-1);
    if (previous !== undefined && compareBytes(previous.aci, aci) >= 0) {
      return undefined;
    }
    seats.push({ aci, tag, seated: !isZero(tag) });
  }
  return seats;
}

/**
 * The audience committed in a DataMessage (Lean `audienceOf` without the
 * nonce): exactly one top-level field 201, of wire type 2, whose value
 * parses. Undefined otherwise (no audience: the record is refused).
 */
export function audienceOfDataMessage(
  dataMessage: Bytes
): Array<Seat> | undefined {
  const fields = topFields(dataMessage);
  if (fields === undefined) {
    return undefined;
  }
  const found = fields.filter(f => f.num === AUDIENCE_FIELD);
  const only = found[0];
  if (found.length !== 1 || only === undefined || only.wireType !== 2) {
    return undefined;
  }
  return parseAudience(dataMessage.slice(only.valueStart, only.stop));
}

/** The audience committed in an opening (`nonce ‖ DataMessage`). */
export function audienceOfOpening(opening: Bytes): Array<Seat> | undefined {
  if (opening.length < NONCE_BYTES) {
    return undefined;
  }
  return audienceOfDataMessage(opening.slice(NONCE_BYTES));
}

/**
 * The opening's message disappears or is view-once (Lean `ephemeral`): a
 * top-level field 5 or 14 that is not a varint zero. Anything that does not
 * parse counts as ephemeral.
 */
export function isEphemeralOpening(opening: Bytes): boolean {
  if (opening.length < NONCE_BYTES) {
    return true;
  }
  const message = opening.slice(NONCE_BYTES);
  const fields = topFields(message);
  if (fields === undefined) {
    return true;
  }
  return fields.some(f => {
    if (f.num !== FIELD_EXPIRE_TIMER && f.num !== FIELD_IS_VIEW_ONCE) {
      return false;
    }
    if (f.wireType !== 0) {
      return true;
    }
    return (readVarint(message, f.valueStart)?.value ?? 1) !== 0;
  });
}

/** 16 ACI bytes as lowercase hex (the key of the sets below). */
export function aciHex(aci: Uint8Array<ArrayBuffer>): string {
  let out = '';
  for (const byte of aci) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** "xxxxxxxx-xxxx-..." as 32 lowercase hex digits. */
export function aciStringHex(aci: string): string {
  return aci.replace(/-/g, '').toLowerCase();
}

/** The ACIs (hex) the audience lists, seated or not. */
export function audienceAcis(seats: ReadonlyArray<Seat>): Set<string> {
  return new Set(seats.map(seat => aciHex(seat.aci)));
}

/** The ACIs (hex) the audience seats: a non-zero tag. */
export function seatedAcis(seats: ReadonlyArray<Seat>): Set<string> {
  return new Set(seats.filter(s => s.seated).map(s => aciHex(s.aci)));
}

/**
 * Whether the audience seats `aci` under the key with tag `tag`: an entry with
 * that ACI and that tag, and the tag is not zero (Lean `seats`, with the tag
 * computed by the caller).
 */
export function seatsUnderTag(
  seats: ReadonlyArray<Seat>,
  aci: Uint8Array<ArrayBuffer>,
  tag: Uint8Array<ArrayBuffer>
): boolean {
  const hex = aciHex(aci);
  const tagHex = aciHex(tag);
  return seats.some(
    s => s.seated && aciHex(s.aci) === hex && aciHex(s.tag) === tagHex
  );
}
