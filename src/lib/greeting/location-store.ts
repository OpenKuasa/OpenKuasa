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

export function writeStoredLocation(lat: number, lon: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ lat: roundCoord(lat), lon: roundCoord(lon) }));
  } catch {
    // Storage unavailable: the choice just won't be remembered.
  }
}

/** Decline device location on this browser (use the workspace city). */
export function clearStoredLocation(): void {
  try {
    localStorage.setItem(KEY, 'declined');
  } catch {
    // Storage unavailable.
  }
}

export function locationChoice(): LocationChoice {
  const value = raw();
  if (!value) return 'unset';
  if (value === 'declined') return 'city';
  return readStoredLocation() ? 'device' : 'unset';
}
