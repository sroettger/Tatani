import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageCircle, Send, Volume2, RotateCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Msg = { role: "user" | "assistant"; content: string };

type Props = {
  episodeId: string;
  studiedWordCount: number;
};

// Strip markers + meta lines for TTS (don't read corrections or English aloud)
const stripMd = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith(">") && !/^\s*\*\(English:/.test(l))
    .join("\n")
    .replace(/\*\*/g, "")
    .trim();

// Render text: extract correction block (leading lines starting with >),
// highlight **word**, and italicize *(English: ...)* line.
function FormattedMsg({ text }: { text: string }) {
  const lines = text.split("\n");
  const correctionLines: string[] = [];
  const bodyLines: string[] = [];
  let inCorrection = true;
  for (const line of lines) {
    if (inCorrection && line.trim().startsWith(">")) {
      correctionLines.push(line.replace(/^\s*>\s?/, ""));
    } else if (inCorrection && line.trim() === "" && correctionLines.length > 0) {
      inCorrection = false; // blank line ends correction block
    } else {
      inCorrection = false;
      bodyLines.push(line);
    }
  }
  const body = bodyLines.join("\n").trim();

  const englishMatch = body.match(/\*\(English:([^)]*)\)\*\s*$/);
  const main = englishMatch ? body.slice(0, englishMatch.index).trim() : body;
  const english = englishMatch?.[1]?.trim();

  const renderInline = (s: string, keyPrefix: string) => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => {
      if (p.startsWith("**") && p.endsWith("**")) {
        return (
          <span key={`${keyPrefix}-${i}`} className="px-1 py-0.5 rounded bg-primary/15 text-primary font-medium">
            {p.slice(2, -2)}
          </span>
        );
      }
      return <span key={`${keyPrefix}-${i}`}>{p}</span>;
    });
  };

  return (
    <div className="space-y-2">
      {correctionLines.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs space-y-0.5">
          {correctionLines.map((l, i) => {
            const isEnglishNote = /^\s*\*\(.*\)\*\s*$/.test(l);
            const cleaned = isEnglishNote ? l.replace(/^\s*\*\(/, "").replace(/\)\*\s*$/, "") : l;
            return (
              <p
                key={i}
                className={cn(
                  isEnglishNote ? "text-muted-foreground italic" : "font-jp text-foreground",
                )}
              >
                {renderInline(cleaned, `c${i}`)}
              </p>
            );
          })}
        </div>
      )}
      {main && <p className="font-jp text-sm leading-relaxed">{renderInline(main, "m")}</p>}
      {english && <p className="text-xs text-muted-foreground italic mt-1.5">{english}</p>}
    </div>
  );
}

export function EpisodeDiscussion({ episodeId, studiedWordCount }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Reset on episode change
  useEffect(() => {
    setMessages([]);
    setInput("");
    abortRef.current?.abort();
    setLoading(false);
  }, [episodeId]);

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(stripMd(text));
    u.lang = "ja-JP";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  const send = async (overrideText?: string, opts?: { autoStart?: boolean }) => {
    const isAutoStart = !!opts?.autoStart;
    const text = (overrideText ?? input).trim();
    if (!isAutoStart && (!text || loading)) return;
    if (isAutoStart && loading) return;
    setInput("");
    let next: Msg[] = messages;
    if (!isAutoStart) {
      const userMsg: Msg = { role: "user", content: text };
      next = [...messages, userMsg];
      setMessages(next);
    }
    setLoading(true);

    let assistantSoFar = "";
    const upsertAssistant = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantSoFar } : m));
        }
        return [...prev, { role: "assistant", content: assistantSoFar }];
      });
    };

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/episode-discuss`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        signal: controller.signal,
        body: JSON.stringify({ episode_id: episodeId, messages: next, auto_start: isAutoStart }),
      });

      if (!resp.ok) {
        if (resp.status === 429) toast.error("Slow down — too many requests.");
        else if (resp.status === 402) toast.error("AI credits exhausted.");
        else toast.error("Discussion failed. Please try again.");
        setLoading(false);
        // remove the optimistic user message? leave it so they can retry
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") { done = true; break; }
          try {
            const parsed = JSON.parse(json);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) upsertAssistant(delta.content);
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        console.error(e);
        toast.error("Connection lost.");
      }
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
  };

  return (
    <Card className="p-4 mb-6 gradient-card border-border/50">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-primary" /> Discuss in Japanese
        </h3>
        {messages.length > 0 && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={reset} title="New conversation">
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {studiedWordCount === 0 ? (
        <p className="text-xs text-muted-foreground">
          Study at least one chunk to unlock a Japanese conversation about this episode.
        </p>
      ) : (
        <>
          <div ref={scrollRef} className="max-h-80 overflow-y-auto space-y-2.5 mb-3">
            {messages.length === 0 && !loading && (
              <div className="flex flex-col items-start gap-2">
                <div className="text-xs text-muted-foreground">
                  Chat in Japanese with an AI partner who watched this episode with you.
                </div>
                <Button
                  size="sm"
                  className="gradient-primary text-primary-foreground h-9"
                  onClick={() => send(undefined, { autoStart: true })}
                >
                  <MessageCircle className="h-4 w-4" /> Start the conversation
                </Button>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-lg px-3 py-2 text-sm max-w-[92%]",
                  m.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground font-jp"
                    : "bg-muted/50",
                )}
              >
                {m.role === "assistant" ? (
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <FormattedMsg text={m.content || "…"} />
                    </div>
                    {m.content && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 shrink-0 -mr-1 -mt-0.5"
                        onClick={() => speak(m.content)}
                        title="Listen"
                      >
                        <Volume2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ) : (
                  <div>{m.content}</div>
                )}
              </div>
            ))}

            {loading && messages[messages.length - 1]?.role !== "assistant" && (
              <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm max-w-[88%]">
                <span className="inline-flex gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse" />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:300ms]" />
                </span>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="日本語で書いてみよう…"
              className="font-jp"
              disabled={loading}
            />
            <Button
              onClick={() => send()}
              disabled={loading || !input.trim()}
              size="icon"
              className="gradient-primary text-primary-foreground shrink-0"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
