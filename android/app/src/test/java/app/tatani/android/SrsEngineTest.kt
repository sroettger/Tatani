package app.tatani.android

import app.tatani.android.domain.SrsEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SrsEngineTest {
    private val fixedNow = 1_795_176_000_000L // fixed epoch ms
    private val dayMs = 24L * 3600_000L

    @Test
    fun graduatesNewlyEncodedWordAtLevelZero() {
        val grad = SrsEngine.computeNextSrsState(
            prev = null,
            word = "探知",
            reading = "たんち",
            level = "N2",
            remembered = true,
            nowMs = fixedNow,
        )
        assertEquals("known", grad.state)
        assertEquals("learned", grad.knownSource)
        assertEquals(0, grad.srsLevel)
        assertEquals(fixedNow + dayMs, grad.srsDueAtEpochMs)
        assertTrue(grad.hasServerState)
        assertTrue(SrsEngine.isGraduatedForSrs(grad.preference, grad.knownSource, grad.srsDueAtEpochMs))
    }

    @Test
    fun advancesDueGraduatedWordAndResetsOnLapse() {
        val step0 = SrsEngine.computeNextSrsState(
            prev = null,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = true,
            nowMs = fixedNow,
        )
        val dueNow = step0.srsDueAtEpochMs!!
        assertEquals(3, SrsEngine.nextIntervalDays(step0, remembered = true, nowMs = dueNow))

        val step1 = SrsEngine.computeNextSrsState(
            prev = step0,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = true,
            nowMs = dueNow,
        )
        assertEquals(1, step1.srsLevel)
        assertEquals(dueNow + 3L * dayMs, step1.srsDueAtEpochMs)

        val lapsed = SrsEngine.computeNextSrsState(
            prev = step1,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = false,
            nowMs = dueNow,
        )
        assertEquals("learning", lapsed.state)
        assertEquals(0, lapsed.srsLevel)
        assertEquals(0, lapsed.correctStreak)
        assertEquals(dueNow + dayMs, lapsed.srsDueAtEpochMs)
    }

    @Test
    fun intradayLapseRecoveryStaysAtOneDayInterval() {
        val graduated = SrsEngine.computeNextSrsState(
            prev = null,
            word = "結界",
            reading = "けっかい",
            level = "N1",
            remembered = true,
            nowMs = fixedNow,
        )
        val lapsed = SrsEngine.computeNextSrsState(
            prev = graduated,
            word = "結界",
            reading = "けっかい",
            level = "N1",
            remembered = false,
            nowMs = fixedNow + dayMs,
        )
        assertEquals("learning", lapsed.state)

        // Re-drilled 2 minutes later in Sprint after lapse: must graduate back at 1d (level 0), NOT 3d (level 1)!
        val retryTime = fixedNow + dayMs + 120_000L
        assertEquals(1, SrsEngine.nextIntervalDays(lapsed, remembered = true, nowMs = retryTime))

        val recovered = SrsEngine.computeNextSrsState(
            prev = lapsed,
            word = "結界",
            reading = "けっかい",
            level = "N1",
            remembered = true,
            nowMs = retryTime,
        )
        assertEquals("known", recovered.state)
        assertEquals(0, recovered.srsLevel)
        assertEquals(retryTime + dayMs, recovered.srsDueAtEpochMs)
    }

    @Test
    fun earlyCramReviewDoesNotInflateIntervals() {
        var card = SrsEngine.SrsSnapshot(
            word = "冒険",
            reading = "ぼうけん",
            level = "N3",
            state = "known",
            preference = "study",
            knownSource = "learned",
            correctStreak = 3,
            srsLevel = 2, // 7d interval
            srsDueAtEpochMs = fixedNow + 7L * dayMs,
            lastReviewedAtIso = null,
            markedKnownAtIso = null,
        )

        // Reviewing 5 times ahead of schedule in Cram Mode must keep srsLevel = 2 (7d) instead of inflating to 480d
        repeat(5) { idx ->
            val earlyNow = fixedNow + (idx + 1) * 60_000L
            assertEquals(7, SrsEngine.nextIntervalDays(card, remembered = true, nowMs = earlyNow))
            card = SrsEngine.computeNextSrsState(
                prev = card,
                word = card.word,
                reading = card.reading,
                level = card.level,
                remembered = true,
                nowMs = earlyNow,
            )
            assertEquals(2, card.srsLevel)
        }

        // Once the card is actually due, grading advances to srsLevel = 3 (14d)
        val onDueMs = card.srsDueAtEpochMs!!
        assertEquals(14, SrsEngine.nextIntervalDays(card, remembered = true, nowMs = onDueMs))
        val advanced = SrsEngine.computeNextSrsState(
            prev = card,
            word = card.word,
            reading = card.reading,
            level = card.level,
            remembered = true,
            nowMs = onDueMs,
        )
        assertEquals(3, advanced.srsLevel)
    }

    @Test
    fun ranksCefrC1BelowC2SoC2LearnersSkipC1Words() {
        assertEquals(1, SrsEngine.jlptRank("N5"))
        assertEquals(5, SrsEngine.jlptRank("N1"))
        assertEquals(1, SrsEngine.jlptRank("A1"))
        assertEquals(5, SrsEngine.jlptRank("C1"))
        assertEquals(6, SrsEngine.jlptRank("C2"))
        assertTrue(SrsEngine.jlptRank("C1") < SrsEngine.jlptRank("C2"))
        assertEquals(99, SrsEngine.jlptRank("none"))
        assertEquals(99, SrsEngine.jlptRank(null))
    }

    @Test
    fun enforcesLearnVsRepeatGateAndPriorKnownExclusion() {
        val prior = SrsEngine.computePriorKnownState(null, "私", "わたし", "N5", fixedNow)
        assertFalse(SrsEngine.isDueForSprint(prior.preference, prior.knownSource, prior.srsDueAtEpochMs, fixedNow))
        assertFalse(
            SrsEngine.isUnlearnedCandidate(
                hasExistingState = true,
                state = prior.state,
                preference = prior.preference,
                knownSource = prior.knownSource,
                srsDueAtEpochMs = prior.srsDueAtEpochMs,
                isBelowUserLevel = false,
            )
        )

        assertFalse(SrsEngine.isDueForSprint("study", null, null, fixedNow))
        assertTrue(
            SrsEngine.isUnlearnedCandidate(
                hasExistingState = false,
                state = "unknown",
                preference = "study",
                knownSource = null,
                srsDueAtEpochMs = null,
                isBelowUserLevel = false,
            )
        )
    }

    @Test
    fun rotatesEpisodeContextsSafelyIncludingIntMinValueAndHighlightsCompoundKanjiAndLatin() {
        val contexts = listOf(
            SrsEngine.EpisodeContext(jp = "魔力を探知する。", en = "Detect mana.", episodeNumber = 1),
            SrsEngine.EpisodeContext(jp = "気配を探知した。", en = "Detected presence.", episodeNumber = 3),
        )
        assertEquals(1, SrsEngine.pickContextualSentence(contexts, 0)?.episodeNumber)
        assertEquals(3, SrsEngine.pickContextualSentence(contexts, 1)?.episodeNumber)
        assertNotNull(SrsEngine.pickContextualSentence(contexts, Int.MIN_VALUE))

        val conjugated = SrsEngine.splitSentenceWithHighlight("早く食べよう", "食べる")
        assertTrue(conjugated.any { it.highlighted && it.text.startsWith("食") })

        // Compound Kanji verb with middle okurigana (思い出す -> 思い出した)
        val compound = SrsEngine.splitSentenceWithHighlight("やっと思い出した！", "思い出す")
        assertEquals(
            listOf(
                SrsEngine.SentenceSegment("やっと", false),
                SrsEngine.SentenceSegment("思い出した", true),
                SrsEngine.SentenceSegment("！", false),
            ),
            compound
        )

        // Case-insensitive Latin highlight preserving original sentence capitalization
        val latin = SrsEngine.splitSentenceWithHighlight("Hablar con amigos es fácil.", "hablar")
        assertEquals(
            listOf(
                SrsEngine.SentenceSegment("Hablar", true),
                SrsEngine.SentenceSegment(" con amigos es fácil.", false),
            ),
            latin
        )

        assertEquals(listOf("探", "知"), SrsEngine.extractKanjiCharacters("探知する"))
    }
}
