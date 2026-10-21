// Binary file data (archives, images, programs) travelling through text:
// pipes and files hold strings, so binary data is written as a tagged,
// base64-like string that looks like garbage when printed and is turned
// back into binary data when a program (or a file) receives it.

import type { BinaryData, FileData } from './fs';

const STREAM_TAG = '\x01\x03T4DBIN1\x02';
const STREAM_END = '\x04';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const STREAM_ALPHABET = '\x01\x02\x05\x06\x10\x11\x12\x13\x14\x15\x16\x17\x19\x1c\x1d\x1e\x1f!#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQ';
const TO_STREAM = new Map<string, string>();
const FROM_STREAM = new Map<string, string>();
for (let i = 0; i < 64; i++) {
  TO_STREAM.set(B64[i], STREAM_ALPHABET[i]);
  FROM_STREAM.set(STREAM_ALPHABET[i], B64[i]);
}

/**
 * Encode binary data as a string that can travel through pipes and files.
 * It looks like binary garbage if someone prints it.
 */
export function encodeBinaryStream(blob: BinaryData): string {
  const bytes = new TextEncoder().encode(JSON.stringify(blob));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin).replace(/=+$/, '');
  let out = STREAM_TAG;
  for (const c of b64) out += TO_STREAM.get(c);
  return out + STREAM_END;
}

/** Decode data produced by encodeBinaryStream (null if the text is not such data). */
export function decodeBinaryStream(text: string): BinaryData | null {
  if (!text.startsWith(STREAM_TAG)) return null;
  const end = text.indexOf(STREAM_END, STREAM_TAG.length);
  if (end === -1) return null;
  let b64 = '';
  for (const c of text.slice(STREAM_TAG.length, end)) {
    const v = FROM_STREAM.get(c);
    if (v === undefined) return null;
    b64 += v;
  }
  while (b64.length % 4) b64 += '=';
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = JSON.parse(new TextDecoder().decode(bytes)) as BinaryData;
    if (!blob || (blob.kind !== 'blob' && blob.kind !== 'native') || typeof blob.size !== 'number') return null;
    return blob;
  } catch {
    return null;
  }
}

/** Is this text the start of encoded binary data that got cut short? */
export function isTruncatedStream(text: string): boolean {
  return text.startsWith(STREAM_TAG) && !text.includes(STREAM_END, STREAM_TAG.length);
}

/** File data with encoded binary strings turned back into binary data. */
export function asBinary(data: FileData): FileData {
  if (typeof data === 'string') return decodeBinaryStream(data) ?? data;
  return data;
}

/** A complete encoded stream (for files that should store it as binary again). */
export function isEncodedStream(text: string): boolean {
  return text.startsWith(STREAM_TAG) && text.endsWith(STREAM_END);
}

