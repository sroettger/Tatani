import { useEffect, useState } from "react";
import Tokenizer from "@sglkc/kuromoji/src/Tokenizer";
import DynamicDictionaries from "@sglkc/kuromoji/src/dict/DynamicDictionaries";

type Token = { surface_form: string; reading?: string };

type KuromojiTokenizer = {
  tokenize: (text: string) => Token[];
};

let tokenizerPromise: Promise<KuromojiTokenizer> | null = null;

const loadBuffer = async (path: string) => {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  const normalized = path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
  const response = await fetch(normalized);
  if (!response.ok) throw new Error(`Failed to load dictionary file: ${normalized}`);
  return response.arrayBuffer();
};

function getTokenizer(): Promise<KuromojiTokenizer> {
  if (tokenizerPromise) return tokenizerPromise;
  tokenizerPromise = Promise.all([
    loadBuffer("/dict-raw/base.dat"),
    loadBuffer("/dict-raw/check.dat"),
    loadBuffer("/dict-raw/tid.dat"),
    loadBuffer("/dict-raw/tid_pos.dat"),
    loadBuffer("/dict-raw/tid_map.dat"),
    loadBuffer("/dict-raw/cc.dat"),
    loadBuffer("/dict-raw/unk.dat"),
    loadBuffer("/dict-raw/unk_pos.dat"),
    loadBuffer("/dict-raw/unk_map.dat"),
    loadBuffer("/dict-raw/unk_char.dat"),
    loadBuffer("/dict-raw/unk_compat.dat"),
    loadBuffer("/dict-raw/unk_invoke.dat"),
  ])
    .then(([base, check, tid, tidPos, tidMap, cc, unk, unkPos, unkMap, unkChar, unkCompat, unkInvoke]) => {
      const dic = new (DynamicDictionaries as any)();
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
      return new (Tokenizer as any)(dic) as KuromojiTokenizer;
    })
    .catch((error) => {
      console.error("[Furigana] tokenizer build failed", error);
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
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setTokens(null);
    setFailed(false);
    if (!text || !show) return;
    let cancelled = false;
    getTokenizer()
      .then((tk) => { if (!cancelled) setTokens(tk.tokenize(text)); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [text, show]);

  const showFurigana = show && tokens && !failed;

  if (!showFurigana) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {tokens!.map((t, i) => {
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
