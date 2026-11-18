import { parseItem, type ParseResult } from './parse.ts';

/**
 * The parsed-item store (spec section 4): global to the daemon, keyed by content hash of the file bytes,
 * holding immutable parse results. Reference-counted by the workspace indexes that point at each result
 * and evicted when the count reaches zero. It knows nothing about paths.
 *
 * Contract for indexes: every `acquire` must be balanced by exactly one `release` of the same hash.
 */
export class ParsedItemStore {
  private readonly entries = new Map<string, { result: ParseResult; refs: number }>();
  /** Number of times bytes were actually parsed (a cache miss). For tests and `scan.finished` stats. */
  parseCount = 0;

  /** Takes a reference to the parse result for `bytes`, parsing only if the hash is not already stored. */
  acquire(bytes: Uint8Array, knownHash?: string): ParseResult {
    if (knownHash) {
      const hit = this.entries.get(knownHash);
      if (hit) {
        hit.refs++;
        return hit.result;
      }
    }
    const result = parseItem(bytes);
    const existing = this.entries.get(result.hash);
    if (existing) {
      existing.refs++;
      return existing.result;
    }
    this.parseCount++;
    this.entries.set(result.hash, { result, refs: 1 });
    return result;
  }

  /** Drops one reference; evicts the result at zero. */
  release(hash: string): void {
    const e = this.entries.get(hash);
    if (!e) return;
    if (--e.refs <= 0) this.entries.delete(hash);
  }

  get(hash: string): ParseResult | undefined {
    return this.entries.get(hash)?.result;
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  refs(hash: string): number {
    return this.entries.get(hash)?.refs ?? 0;
  }

  get size(): number {
    return this.entries.size;
  }
}
