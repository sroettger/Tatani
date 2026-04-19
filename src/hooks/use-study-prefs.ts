import { useEffect, useState } from "react";

// Per-device study preferences stored in localStorage.
const KEY_CHUNK_SIZE = "study.chunkSize";
const KEY_QUEUE_SIZE = "study.queueSize";

export const DEFAULT_CHUNK_SIZE = 10;
export const DEFAULT_QUEUE_SIZE = 30;

export const CHUNK_SIZE_MIN = 3;
export const CHUNK_SIZE_MAX = 30;
export const QUEUE_SIZE_MIN = 5;
export const QUEUE_SIZE_MAX = 200;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const readNumber = (key: string, fallback: number, min: number, max: number) => {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(Math.round(n), min, max) : fallback;
};

export function useStudyPrefs() {
  const [chunkSize, setChunkSizeState] = useState<number>(() =>
    readNumber(KEY_CHUNK_SIZE, DEFAULT_CHUNK_SIZE, CHUNK_SIZE_MIN, CHUNK_SIZE_MAX)
  );
  const [queueSize, setQueueSizeState] = useState<number>(() =>
    readNumber(KEY_QUEUE_SIZE, DEFAULT_QUEUE_SIZE, QUEUE_SIZE_MIN, QUEUE_SIZE_MAX)
  );

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY_CHUNK_SIZE) {
        setChunkSizeState(readNumber(KEY_CHUNK_SIZE, DEFAULT_CHUNK_SIZE, CHUNK_SIZE_MIN, CHUNK_SIZE_MAX));
      } else if (e.key === KEY_QUEUE_SIZE) {
        setQueueSizeState(readNumber(KEY_QUEUE_SIZE, DEFAULT_QUEUE_SIZE, QUEUE_SIZE_MIN, QUEUE_SIZE_MAX));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setChunkSize = (n: number) => {
    const v = clamp(Math.round(n), CHUNK_SIZE_MIN, CHUNK_SIZE_MAX);
    setChunkSizeState(v);
    window.localStorage.setItem(KEY_CHUNK_SIZE, String(v));
  };
  const setQueueSize = (n: number) => {
    const v = clamp(Math.round(n), QUEUE_SIZE_MIN, QUEUE_SIZE_MAX);
    setQueueSizeState(v);
    window.localStorage.setItem(KEY_QUEUE_SIZE, String(v));
  };

  return { chunkSize, queueSize, setChunkSize, setQueueSize };
}
