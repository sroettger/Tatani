import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, Send, X, BrainCircuit } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  part_of_speech?: string;
  jlpt_level?: string;
  example_sentence_jp?: string;
  example_sentence_en?: string;
};

type Msg = { role: "user" | "assistant"; content: string };

type ToolCall = { name: string; args: any };

export type TutorChatProps = {
  vocab: VocabItem[];
  focusWord?: string | null;
  /** Called when the AI requests to start a mini quiz with N words from the vocab list. */
  onStartQuiz?: (count: number) => void;
  /** Called when the AI marks a word known so the parent can refresh local state. */
  onWordMarkedKnown?: (word: string) => void;
};

export function TutorChat({ vocab, focusWord, onStartQuiz, onWordMarkedKnown }: TutorChatProps) {
  const { user, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const greeting = useMemo(() => {
    if (focusWord) return `Hi! Want help with **${focusWord}**? Ask me anything — meaning, more examples, grammar, or say "quiz me".`;
    return `Hi! I'm your Japanese tutor for this episode. Ask about any word, request more example sentences, or say **"quiz me"** to practice.`;
  }, [focusWord]);

  // Auto-scroll on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // If focusWord changes while open, prefill input
  // Reset conversation whenever the focused word changes so context stays accurate.
  useEffect(() => {
    setMessages([]);
    setInput(focusWord ? `Tell me more about ${focusWord}` : "");
    abortRef.current?.abort();
    setLoading(false);
  }, [focusWord]);

  const markWordKnown = async (word: string) => {
    if (!user) return;
    const { data: existing } = await supabase
      .from("user_word_state")
      .select("reading,jlpt_level")
      .eq("user_id", user.id)
      .eq("word", word)
      .maybeSingle();
    const v = vocab.find((x) => x.word === word);
    await supabase.from("user_word_state").upsert(
      {
        user_id: user.id,
        word,
        reading: existing?.reading ?? v?.reading ?? word,
        jlpt_level: (existing?.jlpt_level ?? (v?.jlpt_level as any)) ?? null,
        state: "known",
        correct_streak: 3,
        last_reviewed_at: new Date().toISOString(),
      },
      { onConflict: "user_id,word" },
    );
    toast.success(`Marked "${word}" as known`);
    onWordMarkedKnown?.(word);
  };

  const handleToolCalls = (calls: ToolCall[]) => {
    for (const call of calls) {
      if (call.name === "mark_word_known" && call.args?.word) {
        markWordKnown(String(call.args.word));
      } else if (call.name === "start_mini_quiz") {
        const n = Math.max(3, Math.min(8, Number(call.args?.count) || 5));
        onStartQuiz?.(n);
        toast.success(`Starting a ${n}-question quiz`);
      }
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const userMsg: Msg = { role: "user", content: text };
    const next = [...messages, userMsg];
    setMessages(next);
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

    // Accumulate tool call arguments across deltas (they stream in fragments).
    const toolAccum: Record<number, { name: string; args: string }> = {};

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tutor-chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          messages: next,
          vocab,
          jlpt_level: profile?.jlpt_level ?? "none",
          focus_word: focusWord ?? null,
        }),
      });

      if (!resp.ok) {
        if (resp.status === 429) toast.error("Slow down — too many requests. Try again in a moment.");
        else if (resp.status === 402) toast.error("AI credits exhausted. Add funds in Workspace settings.");
        else toast.error("Tutor chat failed. Please try again.");
        setLoading(false);
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
          if (json === "[DONE]") {
            done = true;
            break;
          }
          try {
            const parsed = JSON.parse(json);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) upsertAssistant(delta.content);
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolAccum[idx]) toolAccum[idx] = { name: "", args: "" };
                if (tc.function?.name) toolAccum[idx].name = tc.function.name;
                if (tc.function?.arguments) toolAccum[idx].args += tc.function.arguments;
              }
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }

      // Fire any tool calls we accumulated
      const calls: ToolCall[] = Object.values(toolAccum)
        .filter((t) => t.name)
        .map((t) => {
          let args: any = {};
          try { args = t.args ? JSON.parse(t.args) : {}; } catch { /* ignore */ }
          return { name: t.name, args };
        });
      if (calls.length) handleToolCalls(calls);

      // If model returned ONLY tool calls with no text, surface a tiny confirmation
      if (!assistantSoFar && calls.length) {
        upsertAssistant("_(done)_");
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

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open AI tutor"
        className={cn(
          "fixed bottom-20 right-4 z-40 grid place-items-center h-14 w-14 rounded-full",
          "gradient-primary text-primary-foreground shadow-elegant",
          "transition-transform hover:scale-105 active:scale-95",
        )}
      >
        <Sparkles className="h-6 w-6" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="h-[85vh] p-0 flex flex-col gradient-card border-border/50">
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border/50">
            <SheetTitle className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-primary" />
              AI Tutor
            </SheetTitle>
          </SheetHeader>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.length === 0 && (
              <div className="rounded-lg bg-muted/40 px-4 py-3 text-sm">
                <ReactMarkdown>{greeting}</ReactMarkdown>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    "Quiz me on 5 words",
                    "More example sentences",
                    focusWord ? `Explain ${focusWord}` : "Hardest word here?",
                  ].map((s) => (
                    <Button key={s} size="sm" variant="outline" onClick={() => setInput(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-lg px-4 py-2.5 text-sm max-w-[88%] prose prose-sm prose-invert",
                  "prose-p:my-1 prose-headings:my-1 prose-ul:my-1 prose-ol:my-1",
                  m.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "bg-muted/50 text-foreground",
                )}
              >
                <ReactMarkdown>{m.content || "…"}</ReactMarkdown>
              </div>
            ))}

            {loading && messages[messages.length - 1]?.role === "user" && (
              <div className="rounded-lg bg-muted/50 px-4 py-2.5 text-sm max-w-[88%]">
                <span className="inline-flex gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse" />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:300ms]" />
                </span>
              </div>
            )}
          </div>

          <div className="px-3 py-3 border-t border-border/50 flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Ask about a word, grammar, or say 'quiz me'…"
              disabled={loading}
            />
            <Button onClick={send} disabled={loading || !input.trim()} size="icon" className="gradient-primary text-primary-foreground">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
