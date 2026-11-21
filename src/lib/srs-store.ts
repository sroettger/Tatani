import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { levelRank } from "@/lib/languages";
import {
  computeNextSrsState,
  computePriorKnownState,
  isDueForSprint,
  isGraduatedForSrs,
  isUnlearnedCandidate,
  SrsDeckCard,
  WordContextSentence,
  WordPreferenceKind,
  WordSrsRecord,
  WordStateKind,
  KnownSourceKind,
} from "@/lib/srs";

export interface ActiveEpisodeTarget {
  episodeId: string;
  episodeNumber: number;
  animeTitle: string;
  unlearnedCount: number;
  knownCount: number;
  totalCount: number;
  words: SrsDeckCard[];
}

interface OutboxMutation {
  word: string;
  learningLanguage: string;
  record: WordSrsRecord;
  wasQuizReview?: boolean;
  wasCorrect?: boolean;
  queuedAt: number;
}

interface CachedDeckSnapshot {
  updatedAt: number;
  cards: Record<string, SrsDeckCard>;
  nextEpisode: ActiveEpisodeTarget | null;
  outbox: Record<string, OutboxMutation>;
}

const STORAGE_PREFIX = "tatani-srs-deck-v1:";

function cacheKey(userId: string, lang: string) {
  return `${STORAGE_PREFIX}${userId}:${lang}`;
}

function readSnapshot(userId: string, lang: string): CachedDeckSnapshot | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId, lang));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDeckSnapshot;
    if (!parsed || typeof parsed.cards !== "object") return null;
    return {
      updatedAt: parsed.updatedAt ?? 0,
      cards: parsed.cards ?? {},
      nextEpisode: parsed.nextEpisode ?? null,
      outbox: parsed.outbox ?? {},
    };
  } catch {
    return null;
  }
}

function writeSnapshot(userId: string, lang: string, snap: CachedDeckSnapshot) {
  try {
    localStorage.setItem(cacheKey(userId, lang), JSON.stringify(snap));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

type RawEpisodeVocab = {
  word: string;
  reading?: string;
  meaning?: string;
  part_of_speech?: string;
  jlpt_level?: string;
  level?: string;
  example_sentence_jp?: string;
  example_sentence_en?: string;
  frequency?: number;
};

export function useSrsDeck(
  userId: string | undefined,
  learningLanguage: string,
  userLevel: string | undefined,
) {
  const initial = useMemo(
    () => (userId ? readSnapshot(userId, learningLanguage) : null),
    [userId, learningLanguage],
  );

  const [cards, setCards] = useState<Record<string, SrsDeckCard>>(() => initial?.cards ?? {});
  const [nextEpisode, setNextEpisode] = useState<ActiveEpisodeTarget | null>(() => initial?.nextEpisode ?? null);
  const [syncing, setSyncing] = useState<boolean>(() => !initial);
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(() => Object.keys(initial?.outbox ?? {}).length);
  const outboxRef = useRef<Record<string, OutboxMutation>>(initial?.outbox ?? {});
  const cardsRef = useRef<Record<string, SrsDeckCard>>(initial?.cards ?? {});
  const nextEpisodeRef = useRef<ActiveEpisodeTarget | null>(initial?.nextEpisode ?? null);
  const flushingRef = useRef(false);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    nextEpisodeRef.current = nextEpisode;
  }, [nextEpisode]);

  const persistLocal = useCallback(
    (nextCards: Record<string, SrsDeckCard>, nextEp: ActiveEpisodeTarget | null, nextOutbox: Record<string, OutboxMutation>) => {
      if (!userId) return;
      writeSnapshot(userId, learningLanguage, {
        updatedAt: Date.now(),
        cards: nextCards,
        nextEpisode: nextEp,
        outbox: nextOutbox,
      });
    },
    [userId, learningLanguage],
  );

  const flushOutbox = useCallback(async () => {
    if (!userId || flushingRef.current) return;
    const entries = Object.values(outboxRef.current);
    if (entries.length === 0) return;

    flushingRef.current = true;
    try {
      const rows = entries.map((entry) => ({
        user_id: userId,
        word: entry.record.word,
        reading: entry.record.reading,
        level: entry.record.level === "none" ? null : entry.record.level,
        learning_language: entry.learningLanguage,
        state: entry.record.state,
        preference: entry.record.preference,
        known_source: entry.record.known_source,
        correct_streak: entry.record.correct_streak,
        srs_level: entry.record.srs_level,
        srs_due_at: entry.record.srs_due_at,
        last_reviewed_at: entry.record.last_reviewed_at,
        ...(entry.record.marked_known_at ? { marked_known_at: entry.record.marked_known_at } : {}),
      }));

      const { error } = await supabase
        .from("user_word_state")
        .upsert(rows, { onConflict: "user_id,word,learning_language" });

      if (!error) {
        // Clear only mutations that haven't been superseded while request was in flight
        const nextOutbox = { ...outboxRef.current };
        for (const sent of entries) {
          if (nextOutbox[sent.word]?.queuedAt === sent.queuedAt) {
            delete nextOutbox[sent.word];
          }
        }
        outboxRef.current = nextOutbox;
        setPendingSyncCount(Object.keys(nextOutbox).length);
        persistLocal(cardsRef.current, nextEpisodeRef.current, nextOutbox);
      }
    } catch {
      // Keep durable local outbox for automatic retry
    } finally {
      flushingRef.current = false;
    }
  }, [userId, persistLocal]);

  const refreshFromServer = useCallback(async () => {
    if (!userId) return;
    setSyncing(true);
    try {
      const [{ data: stateRows }, { data: libRows }, { data: chunkRows }] = await Promise.all([
        supabase
          .from("user_word_state")
          .select("word,reading,level,state,preference,known_source,correct_streak,srs_level,srs_due_at,last_reviewed_at,marked_known_at")
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage),
        supabase
          .from("user_anime")
          .select("position, anime:anime_id(id,title_en,title_romaji)")
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .order("position", { ascending: true }),
        supabase
          .from("study_chunks")
          .select("id")
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .limit(100),
      ]);

      const stateMap = new Map<string, WordSrsRecord>();
      for (const r of stateRows ?? []) {
        stateMap.set(r.word, {
          word: r.word,
          reading: r.reading ?? null,
          level: r.level ?? null,
          state: (r.state ?? "unknown") as WordStateKind,
          preference: (r.preference ?? "study") as WordPreferenceKind,
          known_source: (r.known_source ?? null) as KnownSourceKind,
          correct_streak: r.correct_streak ?? 0,
          srs_level: r.srs_level ?? 0,
          srs_due_at: r.srs_due_at ?? null,
          last_reviewed_at: r.last_reviewed_at ?? null,
          marked_known_at: r.marked_known_at ?? null,
        });
      }

      // Overlay any unsynced local outbox mutations so optimistic updates never regress
      for (const pending of Object.values(outboxRef.current)) {
        if (pending.learningLanguage === learningLanguage) {
          stateMap.set(pending.word, pending.record);
        }
      }

      const mergedCards: Record<string, SrsDeckCard> = {};
      const ensureCard = (
        word: string,
        meta: {
          reading?: string | null;
          meaning?: string | null;
          part_of_speech?: string | null;
          level?: string | null;
          frequency?: number;
          context?: WordContextSentence | null;
        },
      ) => {
        const st = stateMap.get(word);
        const existing = mergedCards[word];
        const contexts: WordContextSentence[] = existing ? [...existing.contexts] : [];
        if (meta.context && meta.context.jp.trim()) {
          if (!contexts.some((c) => c.jp === meta.context!.jp)) {
            contexts.push(meta.context);
          }
        }
        mergedCards[word] = {
          word,
          reading: meta.reading ?? existing?.reading ?? st?.reading ?? null,
          meaning: meta.meaning || existing?.meaning || "",
          part_of_speech: meta.part_of_speech || existing?.part_of_speech || "",
          level: meta.level ?? existing?.level ?? st?.level ?? null,
          frequency: Math.max(meta.frequency ?? 0, existing?.frequency ?? 0),
          state: st?.state ?? existing?.state ?? "unknown",
          preference: st?.preference ?? existing?.preference ?? "study",
          known_source: st?.known_source ?? existing?.known_source ?? null,
          correct_streak: st?.correct_streak ?? existing?.correct_streak ?? 0,
          srs_level: st?.srs_level ?? existing?.srs_level ?? 0,
          srs_due_at: st?.srs_due_at ?? existing?.srs_due_at ?? null,
          last_reviewed_at: st?.last_reviewed_at ?? existing?.last_reviewed_at ?? null,
          marked_known_at: st?.marked_known_at ?? existing?.marked_known_at ?? null,
          contexts,
        };
      };

      // 1. Hydrate from study_chunk_words if present
      const chunkIds = (chunkRows ?? []).map((c: { id: string }) => c.id);
      if (chunkIds.length > 0) {
        const { data: cWords } = await supabase
          .from("study_chunk_words")
          .select("word,reading,meaning,part_of_speech,level,example_sentence_jp,example_sentence_en")
          .in("chunk_id", chunkIds);
        for (const w of cWords ?? []) {
          ensureCard(w.word, {
            reading: w.reading,
            meaning: w.meaning,
            part_of_speech: w.part_of_speech,
            level: w.level,
            context: w.example_sentence_jp
              ? { jp: w.example_sentence_jp, en: w.example_sentence_en ?? "" }
              : null,
          });
        }
      }

      // 2. Hydrate from processed episodes in the user's anime library (gives multi-episode context + next learn target!)
      const myRank = levelRank(learningLanguage, userLevel);
      const isBelowLevel = (lvl: string | null | undefined) =>
        myRank > 0 && (levelRank(learningLanguage, lvl ?? "none") || 99) < myRank;

      let chosenNextEpisode: ActiveEpisodeTarget | null = null;
      const animeEntries = (libRows ?? []) as Array<{ position: number; anime: { id: string; title_en: string | null; title_romaji: string } | null }>;
      const animeIds = animeEntries.map((e) => e.anime?.id).filter(Boolean) as string[];

      if (animeIds.length > 0) {
        const { data: epRows } = await supabase
          .from("episodes")
          .select("id, episode_number, seasons!inner(anime_id, season_number)")
          .in("seasons.anime_id", animeIds)
          .eq("processing_status", "ready");

        const epList = (epRows ?? []) as Array<{
          id: string;
          episode_number: number;
          seasons: { anime_id: string; season_number: number };
        }>;
        const epIds = epList.map((e) => e.id);

        if (epIds.length > 0) {
          const { data: caches } = await supabase
            .from("episode_vocab_cache")
            .select("episode_id, vocab")
            .in("episode_id", epIds)
            .eq("language", learningLanguage);

          const cacheByEp = new Map<string, RawEpisodeVocab[]>();
          for (const c of caches ?? []) {
            cacheByEp.set(c.episode_id, (Array.isArray(c.vocab) ? c.vocab : []) as RawEpisodeVocab[]);
          }

          const animeOrder = new Map<string, { pos: number; title: string }>();
          animeEntries.forEach((entry, idx) => {
            if (entry.anime) {
              animeOrder.set(entry.anime.id, {
                pos: idx,
                title: entry.anime.title_en ?? entry.anime.title_romaji,
              });
            }
          });

          const sortedEpisodes = [...epList].sort((a, b) => {
            const pa = animeOrder.get(a.seasons.anime_id)?.pos ?? 999;
            const pb = animeOrder.get(b.seasons.anime_id)?.pos ?? 999;
            if (pa !== pb) return pa - pb;
            if (a.seasons.season_number !== b.seasons.season_number) {
              return a.seasons.season_number - b.seasons.season_number;
            }
            return a.episode_number - b.episode_number;
          });

          for (const ep of sortedEpisodes) {
            const vocab = cacheByEp.get(ep.id) ?? [];
            const animeTitle = animeOrder.get(ep.seasons.anime_id)?.title ?? "";
            const epUnlearned: SrsDeckCard[] = [];
            let epKnown = 0;

            for (const v of vocab) {
              if (!v.word || !v.meaning) continue;
              const lvl = v.level ?? v.jlpt_level ?? null;
              ensureCard(v.word, {
                reading: v.reading ?? null,
                meaning: v.meaning,
                part_of_speech: v.part_of_speech ?? "",
                level: lvl === "none" ? null : lvl,
                frequency: v.frequency ?? 1,
                context: v.example_sentence_jp
                  ? {
                      jp: v.example_sentence_jp,
                      en: v.example_sentence_en ?? "",
                      animeTitle,
                      episodeNumber: ep.episode_number,
                      episodeId: ep.id,
                    }
                  : null,
              });

              const card = mergedCards[v.word];
              if (isUnlearnedCandidate(stateMap.get(v.word), isBelowLevel(lvl))) {
                epUnlearned.push(card);
              } else {
                epKnown++;
              }
            }

            if (!chosenNextEpisode && epUnlearned.length > 0) {
              const sortedUnlearned = [...epUnlearned].sort((a, b) => {
                const rankA = levelRank(learningLanguage, a.level ?? "none") || 6;
                const rankB = levelRank(learningLanguage, b.level ?? "none") || 6;
                const scoreA = a.frequency * 10 + Math.max(0, 6 - rankA);
                const scoreB = b.frequency * 10 + Math.max(0, 6 - rankB);
                return scoreB - scoreA;
              });
              chosenNextEpisode = {
                episodeId: ep.id,
                episodeNumber: ep.episode_number,
                animeTitle,
                unlearnedCount: sortedUnlearned.length,
                knownCount: epKnown,
                totalCount: vocab.length,
                words: sortedUnlearned,
              };
            }
          }
        }
      }

      // Preserve any previously cached meaning for state rows if episode cache wasn't scanned
      for (const [word, st] of stateMap.entries()) {
        if (!mergedCards[word] && cardsRef.current[word]?.meaning) {
          mergedCards[word] = {
            ...cardsRef.current[word],
            ...st,
          };
        }
      }

      setCards(mergedCards);
      setNextEpisode(chosenNextEpisode);
      persistLocal(mergedCards, chosenNextEpisode, outboxRef.current);
    } finally {
      setSyncing(false);
    }
  }, [userId, learningLanguage, userLevel, persistLocal]);

  useEffect(() => {
    if (!userId) return;
    const snap = readSnapshot(userId, learningLanguage);
    if (snap) {
      setCards(snap.cards);
      setNextEpisode(snap.nextEpisode);
      outboxRef.current = snap.outbox;
      setPendingSyncCount(Object.keys(snap.outbox).length);
      setSyncing(false);
    }
    void flushOutbox().then(() => refreshFromServer());

    const onOnline = () => { void flushOutbox(); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [userId, learningLanguage, flushOutbox, refreshFromServer]);

  const applyOptimisticRecord = useCallback(
    (cardMeta: SrsDeckCard, nextRecord: WordSrsRecord, wasQuizReview = false, wasCorrect?: boolean) => {
      const updatedCard: SrsDeckCard = {
        ...cardMeta,
        ...nextRecord,
      };
      const nextCards = {
        ...cardsRef.current,
        [cardMeta.word]: updatedCard,
      };
      cardsRef.current = nextCards;
      setCards(nextCards);

      if (nextEpisodeRef.current) {
        const ep = nextEpisodeRef.current;
        const stillUnlearned = ep.words.filter((w) => w.word !== cardMeta.word);
        if (stillUnlearned.length !== ep.words.length) {
          const updatedEp: ActiveEpisodeTarget = {
            ...ep,
            words: stillUnlearned,
            unlearnedCount: stillUnlearned.length,
            knownCount: ep.knownCount + 1,
          };
          nextEpisodeRef.current = updatedEp;
          setNextEpisode(updatedEp);
        }
      }

      const nextOutbox: Record<string, OutboxMutation> = {
        ...outboxRef.current,
        [cardMeta.word]: {
          word: cardMeta.word,
          learningLanguage,
          record: nextRecord,
          wasQuizReview,
          wasCorrect,
          queuedAt: Date.now(),
        },
      };
      outboxRef.current = nextOutbox;
      setPendingSyncCount(Object.keys(nextOutbox).length);
      persistLocal(nextCards, nextEpisodeRef.current, nextOutbox);
      void flushOutbox();
    },
    [learningLanguage, persistLocal, flushOutbox],
  );

  const gradeCard = useCallback(
    (card: SrsDeckCard, remembered: boolean): WordSrsRecord => {
      const prev = cardsRef.current[card.word] ?? card;
      const next = computeNextSrsState(
        prev,
        { word: card.word, reading: card.reading, level: card.level },
        remembered,
      );
      applyOptimisticRecord(card, next, true, remembered);
      return prev;
    },
    [applyOptimisticRecord],
  );

  const markPriorKnown = useCallback(
    (card: SrsDeckCard): WordSrsRecord => {
      const prev = cardsRef.current[card.word] ?? card;
      const next = computePriorKnownState(prev, {
        word: card.word,
        reading: card.reading,
        level: card.level,
      });
      applyOptimisticRecord(card, next, false);
      return prev;
    },
    [applyOptimisticRecord],
  );

  const restoreRecord = useCallback(
    (card: SrsDeckCard, previous: WordSrsRecord) => {
      applyOptimisticRecord(card, previous, false);
    },
    [applyOptimisticRecord],
  );

  const allCards = useMemo(() => Object.values(cards).filter((c) => Boolean(c.meaning)), [cards]);

  const dueCards = useMemo(() => {
    const now = Date.now();
    return allCards
      .filter((c) => isDueForSprint(c, now))
      .sort((a, b) => new Date(a.srs_due_at!).getTime() - new Date(b.srs_due_at!).getTime());
  }, [allCards]);

  const graduatedCards = useMemo(
    () => allCards.filter((c) => isGraduatedForSrs(c)),
    [allCards],
  );

  const dueWithin24hCount = useMemo(() => {
    const horizon = Date.now() + 24 * 60 * 60 * 1000;
    return graduatedCards.filter((c) => new Date(c.srs_due_at!).getTime() <= horizon).length;
  }, [graduatedCards]);

  return {
    cards,
    allCards,
    dueCards,
    graduatedCards,
    dueWithin24hCount,
    nextEpisode,
    syncing,
    pendingSyncCount,
    gradeCard,
    markPriorKnown,
    restoreRecord,
    refreshFromServer,
    flushOutbox,
  };
}
