// Associative arrays (declare -A) that list their keys in the same order as
// bash: bash keeps them in a 1024-bucket hash table (FNV-1 hash), walks the
// buckets in order, and puts newer keys first within a bucket.

const BUCKETS = 1024;

function bucketOf(key: string): number {
  let h = 2166136261;
  for (const b of new TextEncoder().encode(key)) {
    h = Math.imul(h, 16777619) >>> 0;
    h = (h ^ b) >>> 0;
  }
  return h & (BUCKETS - 1);
}

interface Entry {
  value: string;
  bucket: number;
  seq: number;
}

export class AssocArray {
  private items = new Map<string, Entry>();
  private seq = 0;

  get size(): number {
    return this.items.size;
  }

  get(key: string): string | undefined {
    return this.items.get(key)?.value;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  set(key: string, value: string): void {
    const e = this.items.get(key);
    if (e) e.value = value;
    else this.items.set(key, { value, bucket: bucketOf(key), seq: this.seq++ });
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  /** Keys in bash's iteration order. */
  keys(): string[] {
    return [...this.items.entries()].sort((a, b) => a[1].bucket - b[1].bucket || b[1].seq - a[1].seq).map(([k]) => k);
  }

  values(): string[] {
    return this.keys().map((k) => this.items.get(k)!.value);
  }

  clone(): AssocArray {
    const c = new AssocArray();
    for (const [k, e] of this.items) c.items.set(k, { ...e });
    c.seq = this.seq;
    return c;
  }
}
