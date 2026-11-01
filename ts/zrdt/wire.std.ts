// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Finds the DataMessage bytes inside a decrypted Content, exactly as they were
// sent (APP.md §3: "hash the bytes as sent"). Other clients' bytes must never
// be re-encoded, so this slices the plaintext; it never builds bytes.
//
// Only the top level of each message is scanned. A field that occurs twice is
// treated as absent: protobuf would merge the two copies, and the host would
// then commit to bytes that are not the message it shows.

type Field = Readonly<{ start: number; end: number }>;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

function readVarint(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number
): { value: number; next: number } | undefined {
  let value = 0;
  let scale = 1;
  for (let i = offset; i < bytes.length && i < offset + 10; i += 1) {
    const byte = bytes[i] ?? 0;
    value += (byte % 0x80) * scale;
    if (byte < 0x80) {
      return { value, next: i + 1 };
    }
    scale *= 0x80;
  }
  return undefined;
}

// Returns the byte range of the value of length-delimited field `fieldNumber`
// at the top level of `bytes`; 'absent', or 'invalid' (malformed, duplicate).
export function findLengthDelimitedField(
  bytes: Uint8Array<ArrayBuffer>,
  fieldNumber: number
): Field | 'absent' | 'invalid' {
  let offset = 0;
  let found: Field | undefined;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) {
      return 'invalid';
    }
    const wireType = key.value % 8;
    const field = Math.floor(key.value / 8);
    offset = key.next;
    if (wireType === WIRE_VARINT) {
      const v = readVarint(bytes, offset);
      if (!v) {
        return 'invalid';
      }
      offset = v.next;
    } else if (wireType === WIRE_FIXED64) {
      offset += 8;
    } else if (wireType === WIRE_FIXED32) {
      offset += 4;
    } else if (wireType === WIRE_LEN) {
      const len = readVarint(bytes, offset);
      if (!len) {
        return 'invalid';
      }
      const start = len.next;
      const end = start + len.value;
      if (end > bytes.length) {
        return 'invalid';
      }
      if (field === fieldNumber) {
        if (found) {
          return 'invalid';
        }
        found = { start, end };
      }
      offset = end;
    } else {
      // groups (3, 4) and unknown wire types: not used by SignalService
      return 'invalid';
    }
    if (offset > bytes.length) {
      return 'invalid';
    }
  }
  return found ?? 'absent';
}

function sliceField(
  bytes: Uint8Array<ArrayBuffer>,
  path: ReadonlyArray<number>
): Uint8Array<ArrayBuffer> | undefined {
  let current = bytes;
  for (const fieldNumber of path) {
    const field = findLengthDelimitedField(current, fieldNumber);
    if (field === 'absent' || field === 'invalid') {
      return undefined;
    }
    current = current.slice(field.start, field.end);
  }
  return current;
}

// Content.dataMessage = 1
export function getDataMessageBytes(
  contentPlaintext: Uint8Array<ArrayBuffer>
): Uint8Array<ArrayBuffer> | undefined {
  return sliceField(contentPlaintext, [1]);
}

// Content.syncMessage = 2 -> SyncMessage.sent = 1 -> Sent.message = 3
export function getSyncSentDataMessageBytes(
  contentPlaintext: Uint8Array<ArrayBuffer>
): Uint8Array<ArrayBuffer> | undefined {
  return sliceField(contentPlaintext, [2, 1, 3]);
}
