import { describe, expect, it } from 'vitest';
import { keyedRows, keyedSlices, seriesConfig, sliceConfig } from '@/components/charts/keys';

const HOSTILE = '</style><script>alert(1)</script>';
const SAFE_KEY = /^s\d+$/;

describe('chart keys', () => {
  it('keys slices by position and keeps their labels', () => {
    const slices = [
      { key: HOSTILE, label: HOSTILE, value: 3 },
      { key: 'R&D / Ops', label: 'R&D / Ops', value: 2, color: 'var(--chart-4)' },
    ];
    const keyed = keyedSlices(slices);
    expect(keyed.map((s) => s.key)).toEqual(['s0', 's1']);
    expect(keyed.map((s) => s.label)).toEqual([HOSTILE, 'R&D / Ops']);
    expect(keyed.map((s) => s.value)).toEqual([3, 2]);

    const config = sliceConfig(slices);
    expect(Object.keys(config)).toEqual(['s0', 's1']);
    expect(config.s0).toEqual({ label: HOSTILE, color: 'var(--chart-1)' });
    expect(config.s1).toEqual({ label: 'R&D / Ops', color: 'var(--chart-4)' });
  });

  it('gives two slices with the same name their own keys', () => {
    const keyed = keyedSlices([
      { key: 'Sales', label: 'Sales', value: 1 },
      { key: 'Sales', label: 'Sales', value: 2 },
    ]);
    expect(new Set(keyed.map((s) => s.key)).size).toBe(2);
  });

  it('keys series by position and keeps their labels', () => {
    const config = seriesConfig([
      { key: HOSTILE, label: 'Leads' },
      { key: 'spend', label: HOSTILE, color: 'var(--chart-3)' },
    ]);
    expect(Object.keys(config).every((k) => SAFE_KEY.test(k))).toBe(true);
    expect(config.s0).toEqual({ label: 'Leads', color: 'var(--chart-1)' });
    expect(config.s1).toEqual({ label: HOSTILE, color: 'var(--chart-3)' });
  });

  it('re-keys rows to match, reading each value by its original name', () => {
    const rows = keyedRows(
      [
        { month: 'Jan', [HOSTILE]: 4, 'a.b': 7, s0: 99 },
        { month: 'Feb', [HOSTILE]: 5, 'a.b': 8, s0: 98 },
      ],
      [
        { key: HOSTILE, label: 'One' },
        { key: 'a.b', label: 'Two' },
        { key: 's0', label: 'Three' },
      ],
      'month',
    );
    expect(rows).toEqual([
      { x: 'Jan', s0: 4, s1: 7, s2: 99 },
      { x: 'Feb', s0: 5, s1: 8, s2: 98 },
    ]);
  });

  it('leaves out a value a row does not have', () => {
    expect(keyedRows([{ label: 'Jan' }], [{ key: 'leads', label: 'Leads' }], 'label')).toEqual([
      { x: 'Jan' },
    ]);
  });
});
