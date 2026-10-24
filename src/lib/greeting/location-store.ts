/**
 * The greeting's device-location opt-in, kept in this browser only.
 * Absent key = never asked; `declined` = the person chose the workspace city.
 * Every access is guarded: private mode or blocked storage must never throw.
 */
const KEY = 'okos.greeting.location';

export type StoredLocation = { lat: number; lon: number };
export type LocationChoice = 'device' | 'city' | 'unset';

/** One decimal place (about 11 km): enough for weather, too coarse to track. */
export function roundCoord(n: number): number {
  return Math.round(n * 10) / 10;
}

function raw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function readStoredLocation(): StoredLocation | null {
  const value = raw();
  if (!value || value === 'declined') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { lat, lon } = parsed as Record<string, unknown>;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/** Called by `useSyncExternalStore`; also tells same-tab readers the choice changed. */
export function subscribeLocationChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function writeStoredLocation(lat: number, lon: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ lat: roundCoord(lat), lon: roundCoord(lon) }));
  } catch {
    // Storage unavailable: the choice just won't be remembered.
  }
  notify();
}

/** The browser refused location permission: remember it (workspace city, no more asking). */
export function clearStoredLocation(): void {
  try {
    localStorage.setItem(KEY, 'declined');
  } catch {
    // Storage unavailable.
  }
  notify();
}

/**
 * The person picked the workspace city on purpose. That is not a permission
 * refusal, so forget any saved device location and leave the choice 'unset'.
 */
export function removeStoredLocation(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable.
  }
  notify();
}

export function locationChoice(): LocationChoice {
  const value = raw();
  if (!value) return 'unset';
  if (value === 'declined') return 'city';
  return readStoredLocation() ? 'device' : 'unset';
}
