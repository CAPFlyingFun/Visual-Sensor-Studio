/**
 * Where held clips live between recording and exporting.
 *
 * IndexedDB rather than memory, because a held clip has to survive the things
 * that happen to a phone: a reload, a tab discarded under memory pressure, the
 * app being backgrounded while a call comes in. A recording lost to any of
 * those would be lost silently, which is the worst way to lose one.
 *
 * It is still not storage in the sense a person means by the word. The browser
 * may evict this whole database when the device is short of space, and Safari
 * discards a site's data after weeks without a visit. Nothing here is ever
 * uploaded — the database is private to this origin and this device — and
 * nothing here should be the only copy of something that matters. Both halves
 * of that are said in the interface, not just in this comment.
 */

import type { ClipRecord } from './clip-library.js';

const DB_NAME = 'visual-sensor-clips';
const DB_VERSION = 1;
const STORE = 'clips';

export interface StoredClip extends ClipRecord {
  blob: Blob;
  mime: string;
  extension: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('clip database unavailable'));
  });
}

function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('clip store failed'));
    tx.oncomplete = () => db.close();
  }));
}

export async function putClip(clip: StoredClip): Promise<void> {
  await run('readwrite', (store) => store.put(clip));
}

export async function listClips(): Promise<StoredClip[]> {
  const all = await run<StoredClip[]>('readonly', (store) => store.getAll() as IDBRequest<StoredClip[]>);
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getClip(id: string): Promise<StoredClip | undefined> {
  return run<StoredClip | undefined>('readonly',
    (store) => store.get(id) as IDBRequest<StoredClip | undefined>);
}

export async function deleteClip(id: string): Promise<void> {
  await run('readwrite', (store) => store.delete(id));
}

export async function clearClips(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}

/** Mark a clip as having a copy somewhere the phone will not delete on its own. */
export async function markExported(id: string, when: number): Promise<void> {
  const clip = await getClip(id);
  if (!clip) return;
  await putClip({ ...clip, savedAt: when });
}

/**
 * What the browser says about storage — approximate by design.
 *
 * The figures are deliberately coarsened so a page cannot fingerprint a device
 * by its exact free space, and the API is absent altogether in some browsers.
 * A missing answer is reported as unknown rather than filled in with a guess,
 * because a guessed quota would turn into a budget and then into a phone
 * filling up.
 */
export async function readQuota(): Promise<{ quota: number; usage: number } | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    if (typeof estimate.quota !== 'number' || typeof estimate.usage !== 'number') return null;
    return { quota: estimate.quota, usage: estimate.usage };
  } catch {
    return null;
  }
}
