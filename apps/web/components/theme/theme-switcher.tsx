'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { SegmentedControl, type SegmentedOption } from '../ui/segmented-control';

type Preference = 'system' | 'light' | 'dark';

// Shared with the pre-paint script in theme-script.tsx.
const STORAGE_KEY = 'fd-theme';

const options: readonly SegmentedOption<Preference>[] = [
  { value: 'system', label: 'Automatic', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

const listeners = new Set<() => void>();

function isOverride(value: unknown): value is 'light' | 'dark' {
  return value === 'light' || value === 'dark';
}

// The attribute on <html> is the state: the pre-paint script set it from storage, and nothing else writes it.
function read(): Preference {
  const theme = document.documentElement.dataset.theme;
  return isOverride(theme) ? theme : 'system';
}

function apply(preference: Preference): void {
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
  for (const listener of listeners) listener();
}

// Another tab changed the preference: follow it, so all tabs of the site agree.
function onStorage(event: StorageEvent): void {
  if (event.key === STORAGE_KEY) apply(isOverride(event.newValue) ? event.newValue : 'system');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

function choose(preference: Preference): void {
  apply(preference);
  // The preference is per device (§8.3). Storage can throw (private mode, blocked site data); the choice then
  // lasts for this page only, which is the best available.
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {}
}

/** The footer's appearance switch: Automatic follows the system; Light and Dark override it on this device. */
export function ThemeSwitcher() {
  // The server cannot know the stored choice; hydration renders Automatic, then the real value.
  const preference = useSyncExternalStore(subscribe, read, () => 'system' as const);
  return (
    <SegmentedControl legend="Appearance" size="sm" options={options} value={preference} onChange={choose} />
  );
}
