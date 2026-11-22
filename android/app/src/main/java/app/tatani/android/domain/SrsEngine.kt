package app.tatani.android.domain

import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

object SrsEngine {
    val SRS_INTERVALS_DAYS = intArrayOf(1, 3, 7, 14, 30, 60, 120, 240, 480)
    const val INITIAL_CONSOLIDATION_HOURS = 4L
    const val LEARN_BATCH_SIZE = 8
    const val LEARN_GRADUATION_RECALLS = 3
    const val LEARN_MIN_INTERVENING_CARDS = 2
    const val SPRINT_LAPSE_REINSERT_GAP = 4
    const val WATCH_READY_COVERAGE_PCT = 85
    private const val HOUR_MS = 60L * 60L * 1000L
    private const val DAY_MS = 24L * HOUR_MS

    data class DrillStepResult(
        val nextHits: Int,
        val graduated: Boolean,
        val targetGap: Int,
    )

    data class MeaningChoice(
        val meaning: String,
        val isCorrect: Boolean,
    )

    data class DistractorCandidate(
        val word: String,
        val meaning: String,
        val partOfSpeech: String = "",
    )

    @Serializable
    data class EpisodeContext(
        val jp: String,
        val en: String = "",
        val animeTitle: String = "",
        val episodeNumber: Int = 0,
        val episodeId: String = "",
    )

    data class SrsSnapshot(
        val word: String,
        val reading: String?,
        val level: String?,
        val state: String,
        val preference: String,
        val knownSource: String?,
        val correctStreak: Int,
        val srsLevel: Int,
        val srsDueAtEpochMs: Long?,
        val lastReviewedAtIso: String?,
        val markedKnownAtIso: String?,
        val hasServerState: Boolean = true,
    )

    data class SentenceSegment(
        val text: String,
        val highlighted: Boolean,
    )

    /**
     * 3-stage scaffolded acquisition ladder (Pyc & Rawson, 2009; Nakata, 2015; Renkl & Atkinson, 2003):
     * - Hit 0 -> 1: Speed Blitz recognition (lag 4)
     * - Hit 1 -> 2: Phonological + contextual active recall with kana shown (lag 5)
     * - Hit 2 -> 3: Kanji-first active recall -> graduates to 4h intraday consolidation!
     * On miss: steps down one rung `(prevHits - 1).coerceAtLeast(0)` with short lag 2 (Karpicke & Roediger, 2007).
     */
    fun computeLearnDrillStep(prevHits: Int, recalled: Boolean): DrillStepResult {
        if (recalled) {
            val nextHits = prevHits + 1
            val graduated = nextHits >= LEARN_GRADUATION_RECALLS
            val gap = when (prevHits) {
                0 -> 4
                1 -> 5
                else -> 6
            }
            return DrillStepResult(nextHits = nextHits, graduated = graduated, targetGap = gap)
        }
        return DrillStepResult(
            nextHits = (prevHits - 1).coerceAtLeast(0),
            graduated = false,
            targetGap = 2,
        )
    }

    /**
     * Selects up to `LEARN_MIN_INTERVENING_CARDS - currentQueueSize` distinct spacer items so the
     * tail words of a batch are never tested back-to-back from phonological working memory.
     */
    fun <T> selectSpacerItems(
        currentQueueSize: Int,
        targetWord: String,
        queuedWords: Set<String>,
        pool: List<T>,
        cursor: Int,
        wordOf: (T) -> String,
    ): Pair<List<T>, Int> {
        val needed = (LEARN_MIN_INTERVENING_CARDS - currentQueueSize).coerceAtLeast(0)
        if (needed == 0 || pool.isEmpty()) return emptyList<T>() to cursor

        val chosen = ArrayList<T>(needed)
        val chosenWords = HashSet<String>(needed)
        var idx = cursor.mod(pool.size)
        var scanned = 0
        while (scanned < pool.size && chosen.size < needed) {
            val candidate = pool[idx]
            val w = wordOf(candidate)
            if (w != targetWord && w !in queuedWords && chosenWords.add(w)) {
                chosen += candidate
            }
            idx = (idx + 1) % pool.size
            scanned++
        }
        return chosen to idx
    }

    private fun computeNextRememberedLevel(prev: SrsSnapshot?, nowMs: Long): Int {
        val maxIdx = SRS_INTERVALS_DAYS.lastIndex
        val dueMs = prev?.srsDueAtEpochMs ?: return 0
        if (prev.state == "learning") return 0
        val prevLevel = prev.srsLevel.coerceIn(0, maxIdx)
        return when {
            prev.state == "known" && nowMs < dueMs -> prevLevel
            prev.state == "known" -> (prevLevel + 1).coerceAtMost(maxIdx)
            else -> 0
        }
    }

    /**
     * Disperses long-term batch reviews (14d+) across ±5% of the interval so a full
     * batch of words learned together does not pile onto the exact same future day.
     */
    fun fuzzedIntervalMs(word: String, nextLevel: Int): Long {
        val baseMs = SRS_INTERVALS_DAYS[nextLevel.coerceIn(0, SRS_INTERVALS_DAYS.lastIndex)] * DAY_MS
        if (nextLevel < 3 || word.isEmpty()) return baseMs
        val pctOffset = ((word.hashCode() and 0x7fffffff) % 11) - 5 // -5% .. +5%
        return baseMs + (baseMs * pctOffset) / 100L
    }

    fun nextIntervalDays(
        prev: SrsSnapshot?,
        remembered: Boolean,
        nowMs: Long = System.currentTimeMillis(),
    ): Int {
        if (!remembered) return SRS_INTERVALS_DAYS[0]
        return SRS_INTERVALS_DAYS[computeNextRememberedLevel(prev, nowMs)]
    }

    fun nextIntervalLabel(
        prev: SrsSnapshot?,
        remembered: Boolean,
        nowMs: Long = System.currentTimeMillis(),
    ): String {
        if (!remembered) return "${INITIAL_CONSOLIDATION_HOURS}h"
        val dueMs = prev?.srsDueAtEpochMs
        if (dueMs == null || prev.state == "unknown") {
            return "${INITIAL_CONSOLIDATION_HOURS}h"
        }
        if (prev.state == "learning" && prev.correctStreak >= 1 && nowMs < dueMs) {
            return "${INITIAL_CONSOLIDATION_HOURS}h"
        }
        return "${nextIntervalDays(prev, true, nowMs)}d"
    }

    fun nextIntervalDaysForGrade(
        prevSrsLevel: Int,
        prevSrsDueAtEpochMs: Long?,
        remembered: Boolean,
        prevState: String = "known",
        nowMs: Long = System.currentTimeMillis(),
    ): Int {
        if (!remembered || prevSrsDueAtEpochMs == null) return SRS_INTERVALS_DAYS[0]
        val snap = SrsSnapshot(
            word = "",
            reading = null,
            level = null,
            state = prevState,
            preference = "study",
            knownSource = "learned",
            correctStreak = 0,
            srsLevel = prevSrsLevel,
            srsDueAtEpochMs = prevSrsDueAtEpochMs,
            lastReviewedAtIso = null,
            markedKnownAtIso = null,
        )
        return nextIntervalDays(snap, remembered, nowMs)
    }

    fun computeNextSrsState(
        prev: SrsSnapshot?,
        word: String,
        reading: String?,
        level: String?,
        remembered: Boolean,
        nowMs: Long = System.currentTimeMillis(),
    ): SrsSnapshot {
        val nowIso = Instant.ofEpochMilli(nowMs).toString()
        val prevStreak = prev?.correctStreak ?: 0
        val consolidationMs = INITIAL_CONSOLIDATION_HOURS * HOUR_MS

        if (remembered) {
            val prevDueMs = prev?.srsDueAtEpochMs
            // Initial graduation from Learn -> 4-hour intraday consolidation step (Cepeda et al., 2008; Dumay & Gaskell, 2007)
            if (prevDueMs == null || prev.state == "unknown") {
                return SrsSnapshot(
                    word = word,
                    reading = reading ?: prev?.reading,
                    level = level ?: prev?.level,
                    state = "learning",
                    preference = prev?.preference ?: "study",
                    knownSource = "learned",
                    correctStreak = 1,
                    srsLevel = 0,
                    srsDueAtEpochMs = nowMs + consolidationMs,
                    lastReviewedAtIso = nowIso,
                    markedKnownAtIso = prev?.markedKnownAtIso ?: nowIso,
                    hasServerState = true,
                )
            }
            // Early cram review during the initial 4h consolidation window must not skip 4h spacing
            if (prev.state == "learning" && prevStreak >= 1 && nowMs < prevDueMs) {
                return SrsSnapshot(
                    word = word,
                    reading = reading ?: prev.reading,
                    level = level ?: prev.level,
                    state = "learning",
                    preference = prev.preference,
                    knownSource = "learned",
                    correctStreak = prevStreak + 1,
                    srsLevel = 0,
                    srsDueAtEpochMs = prevDueMs,
                    lastReviewedAtIso = nowIso,
                    markedKnownAtIso = prev.markedKnownAtIso ?: nowIso,
                    hasServerState = true,
                )
            }

            val nextLevel = computeNextRememberedLevel(prev, nowMs)
            val dueMs = nowMs + fuzzedIntervalMs(word, nextLevel)
            return SrsSnapshot(
                word = word,
                reading = reading ?: prev.reading,
                level = level ?: prev.level,
                state = "known",
                preference = prev.preference,
                knownSource = "learned",
                correctStreak = prevStreak + 1,
                srsLevel = nextLevel,
                srsDueAtEpochMs = dueMs,
                lastReviewedAtIso = nowIso,
                markedKnownAtIso = prev.markedKnownAtIso ?: nowIso,
                hasServerState = true,
            )
        }

        return SrsSnapshot(
            word = word,
            reading = reading ?: prev?.reading,
            level = level ?: prev?.level,
            state = "learning",
            preference = prev?.preference ?: "study",
            knownSource = "learned",
            correctStreak = 0,
            srsLevel = 0,
            srsDueAtEpochMs = nowMs + consolidationMs,
            lastReviewedAtIso = nowIso,
            markedKnownAtIso = prev?.markedKnownAtIso,
            hasServerState = true,
        )
    }

    fun computePriorKnownState(
        prev: SrsSnapshot?,
        word: String,
        reading: String?,
        level: String?,
        nowMs: Long = System.currentTimeMillis(),
    ): SrsSnapshot {
        val nowIso = Instant.ofEpochMilli(nowMs).toString()
        return SrsSnapshot(
            word = word,
            reading = reading ?: prev?.reading,
            level = level ?: prev?.level,
            state = "known",
            preference = prev?.preference ?: "study",
            knownSource = "prior",
            correctStreak = prev?.correctStreak ?: 0,
            srsLevel = 0,
            srsDueAtEpochMs = null,
            lastReviewedAtIso = prev?.lastReviewedAtIso,
            markedKnownAtIso = nowIso,
            hasServerState = true,
        )
    }

    fun isGraduatedForSrs(
        preference: String,
        knownSource: String?,
        srsDueAtEpochMs: Long?,
    ): Boolean {
        if (preference == "skip") return false
        if (knownSource == "prior") return false
        return srsDueAtEpochMs != null
    }

    fun isDueForSprint(
        preference: String,
        knownSource: String?,
        srsDueAtEpochMs: Long?,
        nowMs: Long = System.currentTimeMillis(),
    ): Boolean {
        if (!isGraduatedForSrs(preference, knownSource, srsDueAtEpochMs)) return false
        return srsDueAtEpochMs!! <= nowMs
    }

    fun isUnlearnedCandidate(
        hasExistingState: Boolean,
        state: String,
        preference: String,
        knownSource: String?,
        srsDueAtEpochMs: Long?,
        isBelowUserLevel: Boolean,
    ): Boolean {
        if (preference == "skip") return false
        if (knownSource == "prior") return false
        if (srsDueAtEpochMs != null) return false
        if (state == "known") return false
        if (!hasExistingState && isBelowUserLevel) return false
        return true
    }

    /**
     * Guidance-fading phonological scaffold (Renkl & Atkinson, 2003; Share, 1995):
     * - Returns true when a card has a distinct kana reading and is unencoded or recovering
     *   from a lapse (`state == "unknown"` or `correctStreak == 0`), repairing phonology -> meaning.
     * - Returns false once graduated (`correctStreak >= 1`, including 4h consolidation & 1d+ SRS)
     *   or when `preference == "kanji_only"`, fading to Kanji-first with zero-penalty 1-tap peek.
     */
    fun shouldShowReadingUpfront(
        word: String,
        reading: String?,
        state: String,
        srsLevel: Int,
        correctStreak: Int,
        preference: String = "study",
    ): Boolean {
        if (reading.isNullOrBlank() || reading == word) return false
        if (preference == "kanji_only") return false
        return state == "unknown" || correctStreak == 0
    }

    fun pickContextualSentence(
        contexts: List<EpisodeContext>,
        seed: Int = 0,
    ): EpisodeContext? {
        val valid = contexts.filter { it.jp.isNotBlank() }
        if (valid.isEmpty()) return null
        return valid[seed.mod(valid.size)]
    }

    fun splitSentenceWithHighlight(sentence: String, targetWord: String): List<SentenceSegment> {
        if (sentence.isEmpty()) return emptyList()
        val trimmed = targetWord.trim()
        if (trimmed.isEmpty()) return listOf(SentenceSegment(sentence, false))

        val exactIdx = sentence.indexOf(trimmed, ignoreCase = true)
        if (exactIdx == -1) {
            val lastKanjiIdx = trimmed.indexOfLast { isKanji(it) }
            if (lastKanjiIdx >= 0) {
                val kanjiStem = trimmed.substring(0, lastKanjiIdx + 1)
                val firstKanjiIdx = trimmed.indexOfFirst { isKanji(it) }
                val matchedStem = when {
                    sentence.indexOf(kanjiStem) != -1 -> kanjiStem
                    firstKanjiIdx > 0 -> trimmed.substring(firstKanjiIdx, lastKanjiIdx + 1)
                        .takeIf { sentence.indexOf(it) != -1 }
                    else -> null
                }
                if (!matchedStem.isNullOrEmpty()) {
                    val stemIdx = sentence.indexOf(matchedStem)
                    var end = stemIdx + matchedStem.length
                    while (end < sentence.length && isHiragana(sentence[end]) && end - stemIdx < trimmed.length + 3) {
                        end++
                    }
                    return buildList {
                        if (stemIdx > 0) add(SentenceSegment(sentence.substring(0, stemIdx), false))
                        add(SentenceSegment(sentence.substring(stemIdx, end), true))
                        if (end < sentence.length) add(SentenceSegment(sentence.substring(end), false))
                    }
                }
            }
            return listOf(SentenceSegment(sentence, false))
        }

        val segments = mutableListOf<SentenceSegment>()
        var cursor = 0
        while (cursor < sentence.length) {
            val found = sentence.indexOf(trimmed, cursor, ignoreCase = true)
            if (found == -1) {
                segments.add(SentenceSegment(sentence.substring(cursor), false))
                break
            }
            if (found > cursor) {
                segments.add(SentenceSegment(sentence.substring(cursor, found), false))
            }
            val end = (found + trimmed.length).coerceAtMost(sentence.length)
            segments.add(SentenceSegment(sentence.substring(found, end), true))
            cursor = end
        }
        return segments
    }

    fun extractKanjiCharacters(word: String): List<String> =
        word.filter { isKanji(it) }.map { it.toString() }.distinct()

    fun computeComprehensionPercent(knownCount: Int, totalCount: Int): Int {
        if (totalCount <= 0) return 0
        return ((knownCount.coerceAtLeast(0) * 100) / totalCount).coerceIn(0, 100)
    }

    /**
     * Builds a 4-option meaning recognition blitz (1 correct + 3 episode/deck distractors,
     * preferring matching part-of-speech) for Hit 1 of the Learn micro-drill before
     * graduating via unassisted Kanji-first active recall on Hit 2 (Kang et al., 2007).
     * Returns emptyList() if fewer than 3 distinct distractors are available.
     */
    fun buildMeaningChoices(
        targetWord: String,
        targetMeaning: String,
        targetPos: String,
        pool: List<DistractorCandidate>,
        seed: Int = 0,
    ): List<MeaningChoice> {
        val cleanTarget = targetMeaning.trim()
        if (cleanTarget.isEmpty()) return emptyList()
        val seenLower = hashSetOf(cleanTarget.lowercase())

        val samePos = mutableListOf<String>()
        val otherPos = mutableListOf<String>()
        val normPos = targetPos.trim().lowercase()

        for (c in pool) {
            if (c.word == targetWord) continue
            val m = c.meaning.trim()
            if (m.isEmpty()) continue
            if (!seenLower.add(m.lowercase())) continue
            if (normPos.isNotEmpty() && c.partOfSpeech.trim().lowercase() == normPos) {
                samePos += m
            } else {
                otherPos += m
            }
        }

        if (samePos.size + otherPos.size < 3) return emptyList()

        fun <T> deterministicPick(items: List<T>, salt: Int): List<T> {
            if (items.size <= 1) return items
            return items.sortedBy { item ->
                ((item.hashCode() * 31 + salt * 997 + targetWord.hashCode()) and 0x7fffffff)
            }
        }

        val orderedDistractors = deterministicPick(samePos, seed) + deterministicPick(otherPos, seed + 17)
        val picked = orderedDistractors.take(3)
        val correctSlot = ((targetWord.hashCode() xor (seed * 131)) and 0x7fffffff) % 4

        val choices = ArrayList<MeaningChoice>(4)
        var dIdx = 0
        for (slot in 0 until 4) {
            if (slot == correctSlot) {
                choices += MeaningChoice(cleanTarget, isCorrect = true)
            } else {
                choices += MeaningChoice(picked[dIdx++], isCorrect = false)
            }
        }
        return choices
    }

    fun computeDailyStreak(
        timestampsIso: Collection<String?>,
        zoneId: ZoneId = ZoneId.systemDefault(),
        nowMs: Long = System.currentTimeMillis(),
    ): Int {
        val activeDays = HashSet<LocalDate>()
        for (iso in timestampsIso) {
            if (iso.isNullOrBlank()) continue
            val day = runCatching { Instant.parse(iso).atZone(zoneId).toLocalDate() }.getOrNull()
            if (day != null) activeDays += day
        }
        if (activeDays.isEmpty()) return 0

        var cursor = Instant.ofEpochMilli(nowMs).atZone(zoneId).toLocalDate()
        if (cursor !in activeDays) {
            cursor = cursor.minusDays(1)
            if (cursor !in activeDays) return 0
        }
        var streak = 0
        while (cursor in activeDays) {
            streak++
            cursor = cursor.minusDays(1)
        }
        return streak
    }

    fun jlptRank(level: String?): Int = when (level?.uppercase()) {
        "N5", "A1" -> 1
        "N4", "A2" -> 2
        "N3", "B1" -> 3
        "N2", "B2" -> 4
        "N1", "C1" -> 5
        "C2" -> 6
        else -> 99
    }

    private fun isKanji(ch: Char): Boolean =
        ch in '\u4E00'..'\u9FAF' || ch in '\u3400'..'\u4DBF'

    private fun isHiragana(ch: Char): Boolean =
        ch in '\u3040'..'\u309F'
}
