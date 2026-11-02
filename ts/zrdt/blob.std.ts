// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Reading the framing of a store blob, `zrdtS3` (zrdt core/Zrdt/ChatStore.lean),
// for display and bookkeeping only: zrdtd alone decides whether a blob opens.
//
//   "zrdtS3" ‖ mode u8 (0 closed, 1 relative)
//     ‖ n u32 ‖ n × (digest 32 ‖ voucher aci 16)            the boundary
//     ‖ m u32 ‖ m × (digest 32 ‖ len u32 ‖ field-201 value)  the audiences
//     ‖ "zrdtS2" ‖ group 32 ‖ u32 count ‖ (u32 len ‖ record)*  the records

const MAGIC = 'zrdtS3';
const INNER_MAGIC = 'zrdtS2';

export type Blob3Header = Readonly<{
  relative: boolean;
  boundary: ReadonlyArray<{
    digest: Uint8Array<ArrayBuffer>;
    voucher: Uint8Array<ArrayBuffer>;
  }>;
  audienceCount: number;
  // Where the inner `zrdtS2` blob starts.
  innerOffset: number;
  // Its record count.
  recordCount: number;
}>;

function startsWith(
  bytes: Uint8Array<ArrayBuffer>,
  at: number,
  text: string
): boolean {
  if (at + text.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/** The header of a `zrdtS3` blob, or undefined if the framing does not read. */
export function readBlob3Header(
  blob: Uint8Array<ArrayBuffer>
): Blob3Header | undefined {
  if (!startsWith(blob, 0, MAGIC) || blob.length < MAGIC.length + 5) {
    return undefined;
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const mode = blob[MAGIC.length];
  if (mode !== 0 && mode !== 1) {
    return undefined;
  }
  let at = MAGIC.length + 1;
  const n = view.getUint32(at, false);
  at += 4;
  if (at + n * 48 > blob.length) {
    return undefined;
  }
  const boundary = new Array<{
    digest: Uint8Array<ArrayBuffer>;
    voucher: Uint8Array<ArrayBuffer>;
  }>();
  for (let i = 0; i < n; i += 1) {
    boundary.push({
      digest: blob.slice(at, at + 32),
      voucher: blob.slice(at + 32, at + 48),
    });
    at += 48;
  }
  if (at + 4 > blob.length) {
    return undefined;
  }
  const m = view.getUint32(at, false);
  at += 4;
  for (let i = 0; i < m; i += 1) {
    if (at + 36 > blob.length) {
      return undefined;
    }
    const len = view.getUint32(at + 32, false);
    at += 36 + len;
  }
  if (!startsWith(blob, at, INNER_MAGIC) || at + 6 + 32 + 4 > blob.length) {
    return undefined;
  }
  const recordCount = view.getUint32(at + 6 + 32, false);
  return {
    relative: mode === 1,
    boundary,
    audienceCount: m,
    innerOffset: at,
    recordCount,
  };
}
