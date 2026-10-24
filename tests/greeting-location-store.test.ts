import { afterEach, describe, expect, it } from 'vitest';
import {
  clearStoredLocation,
  locationChoice,
  readStoredLocation,
  removeStoredLocation,
  roundCoord,
  subscribeLocationChoice,
  writeStoredLocation,
} from '@/lib/greeting/location-store';

const g = globalThis as { localStorage?: unknown };

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

afterEach(() => {
  delete g.localStorage;
});

describe('greeting location store', () => {
  it('rounds to one decimal place', () => {
    expect(roundCoord(3.14159)).toBe(3.1);
  });

  it('stores a rounded device location and reports the choice', () => {
    g.localStorage = fakeStorage();
    expect(locationChoice()).toBe('unset');
    writeStoredLocation(3.14, 101.52);
    expect(readStoredLocation()).toEqual({ lat: 3.1, lon: 101.5 });
    expect(locationChoice()).toBe('device');
  });

  it('pins declined (city) apart from never asked (unset)', () => {
    g.localStorage = fakeStorage();
    writeStoredLocation(3.14, 101.52);
    clearStoredLocation();
    expect(readStoredLocation()).toBeNull();
    expect(locationChoice()).toBe('city');
  });

  it('keeps an explicit city pick apart from a permission refusal', () => {
    g.localStorage = fakeStorage();
    writeStoredLocation(3.14, 101.52);
    removeStoredLocation();
    expect(readStoredLocation()).toBeNull();
    expect(locationChoice()).toBe('unset');
    clearStoredLocation();
    expect(locationChoice()).toBe('city');
  });

  it('notifies subscribers on same-tab changes', () => {
    g.localStorage = fakeStorage();
    let calls = 0;
    const off = subscribeLocationChoice(() => (calls += 1));
    writeStoredLocation(1, 2);
    clearStoredLocation();
    removeStoredLocation();
    expect(calls).toBe(3);
    off();
    writeStoredLocation(1, 2);
    expect(calls).toBe(3);
  });

  it('never throws when storage is missing or throws', () => {
    expect(readStoredLocation()).toBeNull();
    expect(locationChoice()).toBe('unset');
    expect(() => writeStoredLocation(1, 2)).not.toThrow();
    expect(() => clearStoredLocation()).not.toThrow();

    const boom = () => {
      throw new Error('denied');
    };
    g.localStorage = { getItem: boom, setItem: boom, removeItem: boom };
    expect(readStoredLocation()).toBeNull();
    expect(locationChoice()).toBe('unset');
    expect(() => writeStoredLocation(1, 2)).not.toThrow();
    expect(() => clearStoredLocation()).not.toThrow();
    expect(() => removeStoredLocation()).not.toThrow();
  });
});
