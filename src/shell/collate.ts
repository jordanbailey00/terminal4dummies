// Sorting that matches what people see on an Ubuntu desktop (en_US.UTF-8):
// case-insensitive-ish, punctuation (like the dot in ".bashrc") ignored at
// first, lowercase before uppercase on ties.

const collator = new Intl.Collator('en-US', { ignorePunctuation: true, sensitivity: 'variant' });

export function compareLocale(a: string, b: string): number {
  const c = collator.compare(a, b);
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Plain byte-order comparison, like LC_ALL=C. */
export function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
