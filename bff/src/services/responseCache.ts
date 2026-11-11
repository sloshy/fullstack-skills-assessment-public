interface CacheEntry<T> {
  value: T;
  expiresAt: number; // epoch ms
  group?: string;
}

/** Opaque token from generation(): which invalidations a value has seen. */
export interface CacheGeneration {
  /** Bumped by clear(). */
  readonly epoch: number;
  /** Bumped by deleteGroup(). */
  readonly group: number;
}

export interface SetOptions {
  /** Entries in a group can be dropped together with deleteGroup. */
  group?: string;
  /**
   * The group's generation, read before the upstream call that produced the value. If the
   * group (or the whole cache) has been invalidated since, the value may predate that change,
   * so it isn't stored.
   */
  generation?: CacheGeneration;
}

export class ResponseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly groupGenerations = new Map<string, number>();
  private epoch = 0;
  private nextSweepAt = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, options: SetOptions = {}): void {
    const { group, generation } = options;
    if (generation !== undefined) {
      if (generation.epoch !== this.epoch) return;
      if (group !== undefined && generation.group !== this.groupGeneration(group)) return;
    }

    this.sweepExpired();
    // Re-inserting moves the key to the end, so map order is oldest-written first
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs, group });
  }

  generation(group?: string): CacheGeneration {
    return { epoch: this.epoch, group: group === undefined ? 0 : this.groupGeneration(group) };
  }

  deleteGroup(group: string): void {
    this.groupGenerations.set(group, this.groupGeneration(group) + 1);
    for (const [key, entry] of this.entries) {
      if (entry.group === group) this.entries.delete(key);
    }
  }

  clear(): void {
    this.epoch += 1;
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private groupGeneration(group: string): number {
    return this.groupGenerations.get(group) ?? 0;
  }

  /** Drops expired entries, at most once per ttl. */
  // Keys that are never read again would otherwise stay in the map until pushed out.
  // At most once per ttl so a burst of sets stays cheap.
  private sweepExpired(): void {
    const now = Date.now();
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
