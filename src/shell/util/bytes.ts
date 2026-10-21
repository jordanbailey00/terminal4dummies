// Turning raw bytes (from \NNN and \xHH escapes) into text.

/**
 * Decode bytes as UTF-8 where they form valid characters, so
 * printf '\303\251' gives "é"; other bytes stay as single characters.
 */
export function decodeBytes(bytes: number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    const n = b >= 0xc2 && b < 0xe0 ? 2 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xf0 && b < 0xf5 ? 4 : 1;
    if (n > 1 && i + n <= bytes.length) {
      try {
        out += new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes.slice(i, i + n)));
        i += n;
        continue;
      } catch {
        // not valid UTF-8: keep the byte as it is
      }
    }
    out += String.fromCharCode(b);
    i++;
  }
  return out;
}
