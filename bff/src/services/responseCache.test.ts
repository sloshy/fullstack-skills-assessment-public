import { ResponseCache } from './responseCache';

describe('ResponseCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the value until the ttl is up', () => {
    const cache = new ResponseCache<string>(1000);
    cache.set('a', 'first');

    jest.advanceTimersByTime(999);
    expect(cache.get('a')).toBe('first');

    jest.advanceTimersByTime(1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('restarts the ttl when a key is set again', () => {
    const cache = new ResponseCache<string>(1000);
    cache.set('a', 'first');
    jest.advanceTimersByTime(600);
    cache.set('a', 'second');
    jest.advanceTimersByTime(600);

    expect(cache.get('a')).toBe('second');
  });

  it('drops every entry on clear', () => {
    const cache = new ResponseCache<string>(1000);
    cache.set('a', 'first');
    cache.set('b', 'second');

    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('drops only the entries in a group on deleteGroup', () => {
    const cache = new ResponseCache<string>(1000);
    cache.set('a1', 'first', { group: 'mer_a' });
    cache.set('a2', 'second', { group: 'mer_a' });
    cache.set('b1', 'third', { group: 'mer_b' });

    cache.deleteGroup('mer_a');

    expect(cache.get('a1')).toBeUndefined();
    expect(cache.get('a2')).toBeUndefined();
    expect(cache.get('b1')).toBe('third');
  });

  it('does not store a value fetched before its group was invalidated', () => {
    const cache = new ResponseCache<string>(1000);
    const generation = cache.generation('mer_a');

    cache.deleteGroup('mer_a'); // a write lands while the fetch is in flight
    cache.set('a1', 'stale', { group: 'mer_a', generation });

    expect(cache.get('a1')).toBeUndefined();

    cache.set('a1', 'fresh', { group: 'mer_a', generation: cache.generation('mer_a') });
    expect(cache.get('a1')).toBe('fresh');
  });

  it('does not store a value fetched before a clear(), even for a group never invalidated', () => {
    const cache = new ResponseCache<string>(1000);
    const generation = cache.generation('mer_new');

    cache.clear(); // e.g. a write whose merchant couldn't be resolved
    cache.set('n1', 'stale', { group: 'mer_new', generation });

    expect(cache.get('n1')).toBeUndefined();
  });

  it('caps the number of entries, evicting the oldest first', () => {
    const cache = new ResponseCache<string>(60_000, 3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.set('a', '1 again'); // rewriting makes it the newest

    cache.set('d', '4');

    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1 again');
    expect(cache.get('c')).toBe('3');
    expect(cache.get('d')).toBe('4');
  });

  it('evicts expired entries that are never read again', () => {
    const cache = new ResponseCache<string>(1000);
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, 'v');
    expect(cache.size).toBe(100);

    jest.advanceTimersByTime(1000);
    cache.set('new', 'v');

    expect(cache.size).toBe(1);
  });
});
