import { expect, it } from 'vitest';
import { defaultInitialMemory, memoryWorkingSet } from './memory.js';

it.each(['16384M', '10G', '4294967296', '4194304K', '1t'])('caps initial allocation for a large maximum of %s', maximum => {
  expect(defaultInitialMemory(maximum)).toBe('2048M');
});
it.each(['512M', '1g', '2048M', '536870912', '524288k'])('does not start above a small maximum of %s', maximum => {
  expect(defaultInitialMemory(maximum)).toBe(maximum);
});
it('preserves the existing behavior for custom percentage limits', () => {
  expect(defaultInitialMemory('50%')).toBe('50%');
});

it('excludes inactive file cache on cgroup v2 (the reported 19.4 GB case)', () => {
  const gib = 1024 ** 3;
  expect(memoryWorkingSet({ usage: 19.4 * gib, stats: { inactive_file: 3 * gib } })).toBeCloseTo(16.4 * gib, 4);
});
it('uses the cgroup v1 working set rather than subtracting all cache', () => {
  expect(memoryWorkingSet({ usage: 1000, stats: { total_inactive_file: 200, cache: 600 } })).toBe(800);
});
it('does not treat a zero inactive cache as missing', () => {
  expect(memoryWorkingSet({ usage: 1000, stats: { inactive_file: 0, cache: 600 } })).toBe(1000);
});
it('supports old daemons and missing counters', () => {
  expect(memoryWorkingSet({ usage: 1000, stats: { cache: 300 } })).toBe(700);
  expect(memoryWorkingSet({ usage: 1000 })).toBe(1000);
  expect(memoryWorkingSet({})).toBe(0);
});
it.each([-1, 1000, 2000])('does not hide real memory for an inconsistent cache counter %s', inactive_file => {
  expect(memoryWorkingSet({ usage: 1000, stats: { inactive_file } })).toBe(1000);
});
