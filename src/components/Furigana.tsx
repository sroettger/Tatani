import { useEffect, useState } from "react";
import kuromoji from "@sglkc/kuromoji";

type Token = { surface_form: string; reading?: string };

let tokenizerPromise: Promise<any> | null = null;
function getTokenizer(): Promise<any> {
  if (tokenizerPromise) return tokenizerPromise;
  tokenizerPromise = new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: "/dict" }).build((err: any, tk: any) => {
      if (err) {
        tokenizerPromise = null;
        reject(err);
      } else resolve(tk);
    });
  });
  return tokenizerPromise;
}

const kataToHira = (s: string) =>
  s.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

const hasKanji = (s: string) => /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(s);

export function Furigana({ text, className }: { text: string; className?: string }) {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!text) return;
    getTokenizer()
      .then((tk) => {
        if (cancelled) return;
        setTokens(tk.tokenize(text));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [text]);

  if (failed || !tokens) {
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
          <ruby key={i}>
            {surface}
            <rt className="text-[0.55em] text-muted-foreground font-normal">{reading}</rt>
          </ruby>
        );
      })}
    </span>
  );
}
