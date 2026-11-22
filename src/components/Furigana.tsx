import { useEffect, useMemo, useState } from "react";
import Tokenizer from "@sglkc/kuromoji/src/Tokenizer";
import DynamicDictionaries from "@sglkc/kuromoji/src/dict/DynamicDictionaries";

type Token = { surface_form: string; reading?: string };

type KuromojiTokenizer = {
  tokenize: (text: string) => Token[];
};

interface KuromojiDynamicDictionaries {
  loadTrie(base: Int32Array, check: Int32Array): void;
  loadTokenInfoDictionaries(tid: Uint8Array, tidPos: Uint8Array, tidMap: Uint8Array): void;
  loadConnectionCosts(cc: Int16Array): void;
  loadUnknownDictionaries(
    unk: Uint8Array,
    unkPos: Uint8Array,
    unkMap: Uint8Array,
    unkChar: Uint8Array,
    unkCompat: Uint32Array,
    unkInvoke: Uint8Array,
  ): void;
}

const DynamicDictionariesCtor = DynamicDictionaries as unknown as new () => KuromojiDynamicDictionaries;
const TokenizerCtor = Tokenizer as unknown as new (dic: KuromojiDynamicDictionaries) => KuromojiTokenizer;

const DICT_DB_NAME = "tatani-kuromoji-dict-v1";
const DICT_STORE_NAME = "buffers";

const DICT_FILES = [
  "base.dat",
  "check.dat",
  "tid.dat",
  "tid_pos.dat",
  "tid_map.dat",
  "cc.dat",
  "unk.dat",
  "unk_pos.dat",
  "unk_map.dat",
  "unk_char.dat",
  "unk_compat.dat",
  "unk_invoke.dat",
] as const;

let resolvedTokenizer: KuromojiTokenizer | null = null;
let tokenizerPromise: Promise<KuromojiTokenizer> | null = null;
let dictDbPromise: Promise<IDBDatabase | null> | null = null;

function openDictDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dictDbPromise) return dictDbPromise;
  dictDbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DICT_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DICT_STORE_NAME)) {
          db.createObjectStore(DICT_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dictDbPromise;
}

function readCachedBuffer(db: IDBDatabase | null, key: string): Promise<ArrayBuffer | null> {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DICT_STORE_NAME, "readonly");
      const req = tx.objectStore(DICT_STORE_NAME).get(key);
      req.onsuccess = () => {
        const val = req.result;
        resolve(val instanceof ArrayBuffer && val.byteLength > 0 ? val : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function writeCachedBuffer(db: IDBDatabase | null, key: string, buffer: ArrayBuffer): Promise<void> {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(DICT_STORE_NAME, "readwrite");
      tx.objectStore(DICT_STORE_NAME).put(buffer, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

function resolveDictUrl(file: string): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  const path = `${base}/dict/${file}.gz`;
  const origin =
    typeof window !== "undefined" &&
    window.location?.origin &&
    window.location.origin !== "null"
      ? window.location.origin
      : "http://localhost";
  return new URL(path, origin).toString();
}

async function decompressGzipResponse(response: Response): Promise<ArrayBuffer> {
  if (typeof DecompressionStream !== "undefined" && response.body) {
    const raw = await response.arrayBuffer();
    const bytes = new Uint8Array(raw);
    const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!isGzip) return raw;
    const decompressed = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(decompressed).arrayBuffer();
  }
  return response.arrayBuffer();
}

async function loadDictBuffer(db: IDBDatabase | null, file: string): Promise<ArrayBuffer> {
  const cached = await readCachedBuffer(db, file);
  if (cached) return cached;

  const url = resolveDictUrl(file);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load dictionary file: ${url} (${response.status})`);
  }
  const buffer = await decompressGzipResponse(response);
  await writeCachedBuffer(db, file, buffer);
  return buffer;
}

function getTokenizer(): Promise<KuromojiTokenizer> {
  if (resolvedTokenizer) return Promise.resolve(resolvedTokenizer);
  if (tokenizerPromise) return tokenizerPromise;

  tokenizerPromise = (async () => {
    const db = await openDictDb();
    const [base, check, tid, tidPos, tidMap, cc, unk, unkPos, unkMap, unkChar, unkCompat, unkInvoke] =
      await Promise.all(DICT_FILES.map((file) => loadDictBuffer(db, file)));

    const dic = new DynamicDictionariesCtor();
    dic.loadTrie(new Int32Array(base), new Int32Array(check));
    dic.loadTokenInfoDictionaries(new Uint8Array(tid), new Uint8Array(tidPos), new Uint8Array(tidMap));
    dic.loadConnectionCosts(new Int16Array(cc));
    dic.loadUnknownDictionaries(
      new Uint8Array(unk),
      new Uint8Array(unkPos),
      new Uint8Array(unkMap),
      new Uint8Array(unkChar),
      new Uint32Array(unkCompat),
      new Uint8Array(unkInvoke),
    );
    const built = new TokenizerCtor(dic);
    resolvedTokenizer = built;
    return built;
  })().catch((error: unknown) => {
    tokenizerPromise = null;
    throw error;
  });

  return tokenizerPromise;
}

const kataToHira = (s: string) =>
  s.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

const hasKanji = (s: string) => /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(s);

export function Furigana({
  text,
  className,
  show = false,
}: {
  text: string;
  className?: string;
  /** When true, render furigana above kanji. When false, render plain text. */
  show?: boolean;
}) {
  const [tokenizer, setTokenizer] = useState<KuromojiTokenizer | null>(() => resolvedTokenizer);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!text || !show) return;
    if (resolvedTokenizer) {
      if (tokenizer !== resolvedTokenizer) setTokenizer(resolvedTokenizer);
      return;
    }
    let cancelled = false;
    getTokenizer()
      .then((tk) => {
        if (!cancelled) setTokenizer(tk);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [text, show, tokenizer]);

  const activeTokenizer = tokenizer ?? resolvedTokenizer;
  const tokens = useMemo(
    () => (show && text && !failed && activeTokenizer ? activeTokenizer.tokenize(text) : null),
    [show, text, failed, activeTokenizer],
  );

  if (!tokens) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {tokens.map((t, i) => {
        const surface = t.surface_form;
        const reading = t.reading ? kataToHira(t.reading) : "";
        if (!hasKanji(surface) || !reading || reading === surface) {
          return <span key={i}>{surface}</span>;
        }
        return (
          <span key={i} className="inline-flex flex-col items-center align-middle mx-[0.04em]">
            <span className="text-[0.55em] leading-none text-muted-foreground font-normal mb-0.5">
              {reading}
            </span>
            <span className="leading-none">{surface}</span>
          </span>
        );
      })}
    </span>
  );
}
