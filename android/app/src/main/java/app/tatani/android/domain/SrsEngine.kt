package app.tatani.android.domain

import kotlinx.serialization.Serializable
import java.time.Instant

object SrsEngine {
    val SRS_INTERVALS_DAYS = intArrayOf(1, 3, 7, 14, 30, 60, 120, 240, 480)
    const val LEARN_BATCH_SIZE = 6
    const val LEARN_GRADUATION_RECALLS = 2
    const val SPRINT_LAPSE_REINSERT_GAP = 4
    private const val DAY_MS = 24L * 60L * 60L * 1000L

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

    fun nextIntervalDays(
        prev: SrsSnapshot?,
        remembered: Boolean,
        nowMs: Long = System.currentTimeMillis(),
    ): Int {
        if (!remembered) return SRS_INTERVALS_DAYS[0]
        return SRS_INTERVALS_DAYS[computeNextRememberedLevel(prev, nowMs)]
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

        if (remembered) {
            val nextLevel = computeNextRememberedLevel(prev, nowMs)
            val dueMs = nowMs + SRS_INTERVALS_DAYS[nextLevel] * DAY_MS
            return SrsSnapshot(
                word = word,
                reading = reading ?: prev?.reading,
                level = level ?: prev?.level,
                state = "known",
                preference = prev?.preference ?: "study",
                knownSource = "learned",
                correctStreak = prevStreak + 1,
                srsLevel = nextLevel,
                srsDueAtEpochMs = dueMs,
                lastReviewedAtIso = nowIso,
                markedKnownAtIso = prev?.markedKnownAtIso ?: nowIso,
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
            srsDueAtEpochMs = nowMs + SRS_INTERVALS_DAYS[0] * DAY_MS,
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
     * - Returns true when a card has a distinct kana reading and is ungraduated or
     *   recovering from a lapse (state != "known" || (srsLevel == 0 && correctStreak == 0)),
     *   re-anchoring phonology + orthography -> meaning after errors.
     * - Returns false once graduated (state == "known", correctStreak >= 1) or when
     *   preference == "kanji_only", fading to Kanji-first with zero-penalty 1-tap reading peek
     *   so permanent furigana does not block orthographic Kanji acquisition.
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
        return state != "known" || (srsLevel == 0 && correctStreak == 0)
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
