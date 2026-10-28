// mods/lib/mod-mutex.ts
const MUTEX_KEY = "wildwood-mod-mutex";
const MUTEX_EVENT = "wildwood-mod-mutex-change";

export type MutexState = {
  holder: string;
  reason: string;
  until: number;
} | null;

export function readMutex(): MutexState {
  try {
    const raw = localStorage.getItem(MUTEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MutexState;
    if (!parsed || typeof parsed.until !== "number") return null;
    if (Date.now() >= parsed.until) {
      try { localStorage.removeItem(MUTEX_KEY); } catch { /* idem */ }
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function acquireMutex(holder: string, reason: string, ttlMs: number): () => void {
  const current = readMutex();
  if (current && current.holder !== holder) {
    return () => {};
  }
  const state: MutexState = { holder, reason, until: Date.now() + ttlMs };
  try {
    localStorage.setItem(MUTEX_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent(MUTEX_EVENT, { detail: state }));
  } catch { /* idem */ }
  return () => {
    const still = readMutex();
    if (still?.holder === holder) {
      try {
        localStorage.removeItem(MUTEX_KEY);
        window.dispatchEvent(new CustomEvent(MUTEX_EVENT, { detail: null }));
      } catch { /* idem */ }
    }
  };
}

export function isPausedFor(moduleId: string): boolean {
  const m = readMutex();
  if (!m) return false;
  return m.holder !== moduleId;
}

export function mutexHolder(): string | null {
  return readMutex()?.holder ?? null;
}

export function onMutexChange(cb: (state: MutexState) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<MutexState>).detail);
  const storageHandler = (e: StorageEvent) => {
    if (e.key === MUTEX_KEY) cb(readMutex());
  };
  window.addEventListener(MUTEX_EVENT, handler);
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(MUTEX_EVENT, handler);
    window.removeEventListener("storage", storageHandler);
  };
}
