import type { EmpiricalMeasurementInput } from "@/types/metro";

const DB_NAME = "scancdmx_offline_timer";
const STORE_NAME = "pending_measurements";
const DB_VERSION = 1;

export interface QueuedMeasurement extends EmpiricalMeasurementInput {
  localId?: number;
  queuedAtIso: string;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {
          keyPath: "localId",
          autoIncrement: true,
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueOfflineMeasurement(
  item: EmpiricalMeasurementInput
): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add({
      ...item,
      queuedAtIso: new Date().toISOString(),
    });
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function listQueuedMeasurements(): Promise<QueuedMeasurement[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result as QueuedMeasurement[]) ?? []);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function clearQueuedMeasurements(ids: number[]): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const id of ids) {
      store.delete(id);
    }
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function submitOrQueueMeasurements(
  items: EmpiricalMeasurementInput[],
  adminPin?: string
): Promise<{
  synced: boolean;
  queuedCount: number;
  rejectedReasons: string[];
}> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    for (const it of items) {
      await enqueueOfflineMeasurement(it);
    }
    const q = await listQueuedMeasurements();
    return { synced: false, queuedCount: q.length, rejectedReasons: [] };
  }

  try {
    const res = await fetch("/api/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, adminPin }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const q = await listQueuedMeasurements();
    return {
      synced: true,
      queuedCount: q.length,
      rejectedReasons: Array.isArray(data.rejectedReasons)
        ? data.rejectedReasons
        : [],
    };
  } catch {
    for (const it of items) {
      await enqueueOfflineMeasurement(it);
    }
    const q = await listQueuedMeasurements();
    return { synced: false, queuedCount: q.length, rejectedReasons: [] };
  }
}

export async function flushOfflineQueue(): Promise<{
  flushed: number;
  remaining: number;
}> {
  const pending = await listQueuedMeasurements();
  if (pending.length === 0) return { flushed: 0, remaining: 0 };

  try {
    const cleanItems: EmpiricalMeasurementInput[] = pending.map(
      ({ localId: _id, queuedAtIso: _q, ...rest }) => rest
    );
    const res = await fetch("/api/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: cleanItems }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = pending
      .map((p) => p.localId)
      .filter((id): id is number => typeof id === "number");
    await clearQueuedMeasurements(ids);
    return { flushed: ids.length, remaining: 0 };
  } catch {
    return { flushed: 0, remaining: pending.length };
  }
}
