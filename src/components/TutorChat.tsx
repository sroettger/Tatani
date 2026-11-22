import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, Send, BrainCircuit } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import { scaleLabel } from "@/lib/languages";
import {
  computeNextSrsState,
  KnownSourceKind,
  WordPreferenceKind,
  WordStateKind,
} from "@/lib/srs";
import { invalidateLocalSrsCache } from "@/lib/srs-store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  part_of_speech?: string;
  jlpt_level?: string;
  level?: string;
  example_sentence_jp?: string;
  example_sentence_en?: string;
};

type Msg = { role: "user" | "assistant"; content: string };

type ToolCall = { name: string; args: Record<string, unknown> };

interface StreamToolCallDelta {
  id?: string;
  index?: number;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface AccumulatedToolCall {
  id?: string;
  streamIndex?: number;
  name: string;
  args: string;
}

function isCompleteJsonObject(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export type TutorChatProps = {
  vocab: VocabItem[];
  focusWord?: string | null;
  /** Called when the AI requests to start a mini quiz with N words from the vocab list. */
  onStartQuiz?: (count: number) => void;
  /** Called when the AI marks a word known so the parent can refresh local state. */
  onWordMarkedKnown?: (word: string) => void;
};

export function TutorChat({ vocab, focusWord, onStartQuiz, onWordMarkedKnown }: TutorChatProps) {
  const { user, progress, learningLanguage, learningLanguageInfo } = useAuth();
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const greeting = useMemo(() => {
    if (focusWord) return t("tutor.greetingFocus", { word: focusWord });
    return t("tutor.greeting");
  }, [focusWord, t]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Abort any in-flight SSE stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

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
      .select("reading,level,state,preference,known_source,correct_streak,srs_level,srs_due_at,last_reviewed_at,marked_known_at")
      .eq("user_id", user.id)
      .eq("word", word)
      .eq("learning_language", learningLanguage)
      .maybeSingle();
    const v = vocab.find((x) => x.word === word);
    const rawLevel = existing?.level ?? v?.level ?? v?.jlpt_level ?? null;
    const next = computeNextSrsState(
      existing
        ? {
            word,
            reading: existing.reading ?? null,
            level: existing.level ?? null,
            state: (existing.state ?? "unknown") as WordStateKind,
            preference: (existing.preference ?? "study") as WordPreferenceKind,
            known_source: (existing.known_source ?? null) as KnownSourceKind,
            correct_streak: existing.correct_streak ?? 0,
            srs_level: existing.srs_level ?? 0,
            srs_due_at: existing.srs_due_at ?? null,
            last_reviewed_at: existing.last_reviewed_at ?? null,
            marked_known_at: existing.marked_known_at ?? null,
          }
        : undefined,
      {
        word,
        reading: existing?.reading ?? v?.reading ?? word,
        level: rawLevel === "none" ? null : rawLevel,
      },
      true,
    );

    await supabase.from("user_word_state").upsert(
      {
        user_id: user.id,
        word: next.word,
        reading: next.reading,
        level: next.level,
        learning_language: learningLanguage,
        state: next.state,
        preference: next.preference,
        known_source: next.known_source,
        correct_streak: Math.max(3, next.correct_streak),
        srs_level: next.srs_level,
        srs_due_at: next.srs_due_at,
        last_reviewed_at: next.last_reviewed_at,
        marked_known_at: next.marked_known_at ?? null,
      },
      { onConflict: "user_id,word,learning_language" },
    );
    invalidateLocalSrsCache(user.id, learningLanguage);
    toast.success(t("tutor.markedKnown", { word }));
    onWordMarkedKnown?.(word);
  };

  const handleToolCalls = (calls: ToolCall[]) => {
    for (const call of calls) {
      if (call.name === "mark_word_known" && call.args?.word) {
        void markWordKnown(String(call.args.word));
      } else if (call.name === "start_mini_quiz") {
        const n = Math.max(3, Math.min(8, Number(call.args?.count) || 5));
        onStartQuiz?.(n);
        toast.success(t("tutor.startingQuiz", { n }));
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

    const toolAccum: AccumulatedToolCall[] = [];
    const accumulateToolDelta = (tc: StreamToolCallDelta, arrayPos: number) => {
      const fnName = tc.function?.name;
      const fnArgs = tc.function?.arguments ?? "";

      if (tc.id) {
        const byId = toolAccum.find((entry) => entry.id === tc.id);
        if (byId) {
          if (fnName && !byId.name) byId.name = fnName;
          byId.args += fnArgs;
          return;
        }
        toolAccum.push({
          id: tc.id,
          streamIndex: tc.index ?? arrayPos,
          name: fnName ?? "",
          args: fnArgs,
        });
        return;
      }

      const targetIndex = tc.index ?? arrayPos;
      let existing: AccumulatedToolCall | undefined;
      for (let i = toolAccum.length - 1; i >= 0; i--) {
        if (toolAccum[i].streamIndex === targetIndex) {
          existing = toolAccum[i];
          break;
        }
      }

      if (
        existing &&
        (!fnName || !existing.name || (existing.name === fnName && !isCompleteJsonObject(existing.args)))
      ) {
        if (fnName && !existing.name) existing.name = fnName;
        existing.args += fnArgs;
        return;
      }

      toolAccum.push({
        streamIndex: targetIndex,
        name: fnName ?? "",
        args: fnArgs,
      });
    };

    const processSseLine = (rawLine: string): "continue" | "done" | "incomplete" => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith(":") || line.trim() === "") return "continue";
      if (!line.startsWith("data: ")) return "continue";
      const json = line.slice(6).trim();
      if (json === "[DONE]") return "done";
      try {
        const parsed = JSON.parse(json) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: StreamToolCallDelta[];
            };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) upsertAssistant(delta.content);
        if (Array.isArray(delta?.tool_calls)) {
          delta.tool_calls.forEach((tc, pos) => accumulateToolDelta(tc, pos));
        }
        return "continue";
      } catch {
        return "incomplete";
      }
    };

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tutor-chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        signal: controller.signal,
        body: JSON.stringify({
          messages: next,
          vocab,
          jlpt_level: progress?.level ?? "none",
          learning_language: learningLanguage,
          learning_language_name: learningLanguageInfo.name,
          level_scale: scaleLabel(learningLanguage),
          focus_word: focusWord ?? null,
          ui_language: lang,
        }),
      });

      if (!resp.ok) {
        if (resp.status === 429) toast.error(t("tutor.slowDown"));
        else if (resp.status === 402) toast.error(t("tutor.creditsExhausted"));
        else toast.error(t("tutor.chatFailed"));
        setLoading(false);
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 1);
          const status = processSseLine(line);
          if (status === "done") {
            done = true;
            break;
          }
          if (status === "incomplete") {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }

      // Flush any trailing buffered lines after stream close
      if (!done && buffer.trim()) {
        for (const trailingLine of buffer.split("\n")) {
          if (processSseLine(trailingLine) === "done") break;
        }
      }

      const calls: ToolCall[] = toolAccum
        .filter((item) => item.name)
        .map((item) => {
          let args: Record<string, unknown> = {};
          try {
            args = item.args ? (JSON.parse(item.args) as Record<string, unknown>) : {};
          } catch {
            // Ignore malformed tool args
          }
          return { name: item.name, args };
        });
      if (calls.length) handleToolCalls(calls);

      if (!assistantSoFar && calls.length) {
        upsertAssistant("_(done)_");
      }
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        console.error(e);
        toast.error(t("tutor.connectionLost"));
      }
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={t("tutor.openAiTutor")}
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
              {t("tutor.aiTutor")}
            </SheetTitle>
          </SheetHeader>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.length === 0 && (
              <div className="rounded-lg bg-muted/40 px-4 py-3 text-sm">
                <ReactMarkdown>{greeting}</ReactMarkdown>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    t("tutor.suggestQuiz"),
                    t("tutor.suggestExamples"),
                    focusWord ? t("tutor.suggestExplain", { word: focusWord }) : t("tutor.suggestHardest"),
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
              placeholder={t("tutor.inputPlaceholder")}
              disabled={loading}
            />
            <Button onClick={() => void send()} disabled={loading || !input.trim()} size="icon" className="gradient-primary text-primary-foreground">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
