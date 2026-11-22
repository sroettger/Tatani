import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { levelRank } from "@/lib/languages";
import { fetchAllPages, fetchBatchedPages } from "@/lib/supabase-pagination";
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
const FOCUS_SYNC_THROTTLE_MS = 30_000;
export const SRS_UPDATED_EVENT = "tatani:srs-updated";

export function srsDeckStorageKey(userId: string, lang: string): string {
  return `${STORAGE_PREFIX}${userId}:${lang}`;
}

function readSnapshot(userId: string, lang: string): CachedDeckSnapshot | null {
  try {
    const raw = localStorage.getItem(srsDeckStorageKey(userId, lang));
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
    localStorage.setItem(srsDeckStorageKey(userId, lang), JSON.stringify(snap));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

/**
 * Marks the local SRS cache stale (preserving offline cards & outbox) and broadcasts
 * `"tatani:srs-updated"` so any mounted `useSrsDeck` refreshes immediately.
 */
export function invalidateLocalSrsCache(userId?: string, lang?: string): void {
  if (userId && lang) {
    const snap = readSnapshot(userId, lang);
    if (snap) {
      writeSnapshot(userId, lang, { ...snap, updatedAt: 0 });
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(SRS_UPDATED_EVENT, { detail: { userId, learningLanguage: lang } }),
    );
  }
}

export function clearLocalSrsCache(userId: string, lang: string): void {
  try {
    localStorage.removeItem(srsDeckStorageKey(userId, lang));
  } catch {
    // Ignore storage errors cleanly
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(SRS_UPDATED_EVENT, {
        detail: { userId, learningLanguage: lang, cleared: true },
      }),
    );
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

type StateRow = {
  word: string;
  reading: string | null;
  level: string | null;
  state: string | null;
  preference: string | null;
  known_source: string | null;
  correct_streak: number | null;
  srs_level: number | null;
  srs_due_at: string | null;
  last_reviewed_at: string | null;
  marked_known_at: string | null;
};

type ChunkWordRow = {
  word: string;
  reading: string | null;
  meaning: string | null;
  part_of_speech: string | null;
  level: string | null;
  example_sentence_jp: string | null;
  example_sentence_en: string | null;
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
  const lastSyncAtRef = useRef<number>(0);

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
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const entries = Object.values(outboxRef.current);
    if (entries.length === 0) return;

    flushingRef.current = true;
    try {
      const rows = entries.map((entry) => ({
        user_id: userId,
        word: entry.record.word,
        reading: entry.record.reading ?? null,
        level: entry.record.level === "none" ? null : (entry.record.level ?? null),
        learning_language: entry.learningLanguage,
        state: entry.record.state,
        preference: entry.record.preference,
        known_source: entry.record.known_source ?? null,
        correct_streak: entry.record.correct_streak,
        srs_level: entry.record.srs_level,
        srs_due_at: entry.record.srs_due_at ?? null,
        last_reviewed_at: entry.record.last_reviewed_at ?? null,
        marked_known_at: entry.record.marked_known_at ?? null,
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
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    setSyncing(true);
    try {
      const [
        { data: stateRows, error: stateErr },
        { data: libRows, error: libErr },
        { data: chunkRows, error: chunkErr },
      ] = await Promise.all([
        fetchAllPages<StateRow>((from, to) =>
          supabase
            .from("user_word_state")
            .select("word,reading,level,state,preference,known_source,correct_streak,srs_level,srs_due_at,last_reviewed_at,marked_known_at")
            .eq("user_id", userId)
            .eq("learning_language", learningLanguage)
            .order("word", { ascending: true })
            .range(from, to),
        ),
        supabase
          .from("user_anime")
          .select("position, anime:anime_id(id,title_en,title_romaji)")
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .order("position", { ascending: true }),
        fetchAllPages<{ id: string }>((from, to) =>
          supabase
            .from("study_chunks")
            .select("id")
            .eq("user_id", userId)
            .eq("learning_language", learningLanguage)
            .order("id", { ascending: true })
            .range(from, to),
        ),
      ]);

      if (stateErr || libErr || chunkErr) {
        return;
      }

      const stateMap = new Map<string, WordSrsRecord>();
      for (const r of stateRows) {
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

      // 1. Hydrate from study_chunk_words if present (batched by 50 chunkIds + paginated)
      const chunkIds = chunkRows.map((c) => c.id);
      if (chunkIds.length > 0) {
        const { data: cWords, error: chunkWordsErr } = await fetchBatchedPages<string, ChunkWordRow>(
          chunkIds,
          50,
          (slice, from, to) =>
            supabase
              .from("study_chunk_words")
              .select("word,reading,meaning,part_of_speech,level,example_sentence_jp,example_sentence_en")
              .in("chunk_id", slice)
              .order("chunk_id", { ascending: true })
              .order("position", { ascending: true })
              .range(from, to),
        );
        if (chunkWordsErr) {
          return;
        }
        for (const w of cWords) {
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

      // 2. Hydrate from processed episodes in the user's anime library
      const myRank = levelRank(learningLanguage, userLevel);
      const isBelowLevel = (lvl: string | null | undefined) =>
        myRank > 0 && (levelRank(learningLanguage, lvl ?? "none") || 99) < myRank;

      let chosenNextEpisode: ActiveEpisodeTarget | null = null;
      const animeEntries = (libRows ?? []) as Array<{
        position: number;
        anime: { id: string; title_en: string | null; title_romaji: string } | null;
      }>;
      const animeIds = animeEntries.map((e) => e.anime?.id).filter(Boolean) as string[];

      if (animeIds.length > 0) {
        const { data: epList, error: epErr } = await fetchAllPages<{
          id: string;
          episode_number: number;
          seasons: { anime_id: string; season_number: number };
        }>((from, to) =>
          supabase
            .from("episodes")
            .select("id, episode_number, seasons!inner(anime_id, season_number)")
            .in("seasons.anime_id", animeIds)
            .eq("processing_status", "ready")
            .order("id", { ascending: true })
            .range(from, to),
        );
        if (epErr) {
          return;
        }

        const epIds = epList.map((e) => e.id);

        if (epIds.length > 0) {
          const { data: caches, error: cacheErr } = await fetchBatchedPages<
            string,
            { episode_id: string; vocab: unknown }
          >(epIds, 200, (slice, from, to) =>
            supabase
              .from("episode_vocab_cache")
              .select("episode_id, vocab")
              .in("episode_id", slice)
              .eq("language", learningLanguage)
              .order("episode_id", { ascending: true })
              .range(from, to),
          );
          if (cacheErr) {
            return;
          }

          const cacheByEp = new Map<string, RawEpisodeVocab[]>();
          for (const c of caches) {
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

      lastSyncAtRef.current = Date.now();
      setCards(mergedCards);
      setNextEpisode(chosenNextEpisode);
      persistLocal(mergedCards, chosenNextEpisode, outboxRef.current);
    } catch {
      // Preserve existing cached local deck on network/offline failure
    } finally {
      setSyncing(false);
    }
  }, [userId, learningLanguage, userLevel, persistLocal]);

  useEffect(() => {
    if (!userId) return;
    const snap = readSnapshot(userId, learningLanguage);
    if (snap) {
      cardsRef.current = snap.cards;
      nextEpisodeRef.current = snap.nextEpisode;
      setCards(snap.cards);
      setNextEpisode(snap.nextEpisode);
      outboxRef.current = snap.outbox;
      setPendingSyncCount(Object.keys(snap.outbox).length);
      setSyncing(false);
    } else {
      cardsRef.current = {};
      nextEpisodeRef.current = null;
      setCards({});
      setNextEpisode(null);
      outboxRef.current = {};
      setPendingSyncCount(0);
    }
    void flushOutbox().then(() => refreshFromServer());

    const onOnline = () => {
      void flushOutbox().then(() => refreshFromServer());
    };
    const onVisibilityChange = () => {
      if (document.hidden) return;
      if (Date.now() - lastSyncAtRef.current < FOCUS_SYNC_THROTTLE_MS) return;
      void flushOutbox().then(() => refreshFromServer());
    };
    const onSrsUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<{ userId?: string; learningLanguage?: string; cleared?: boolean }>).detail;
      if (detail?.userId && detail.userId !== userId) return;
      if (detail?.learningLanguage && detail.learningLanguage !== learningLanguage) return;
      if (detail?.cleared) {
        cardsRef.current = {};
        nextEpisodeRef.current = null;
        outboxRef.current = {};
        setCards({});
        setNextEpisode(null);
        setPendingSyncCount(0);
      }
      void flushOutbox().then(() => refreshFromServer());
    };

    window.addEventListener("online", onOnline);
    window.addEventListener(SRS_UPDATED_EVENT, onSrsUpdated);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener(SRS_UPDATED_EVENT, onSrsUpdated);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
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
