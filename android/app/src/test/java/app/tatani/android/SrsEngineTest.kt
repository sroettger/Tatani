package app.tatani.android

import app.tatani.android.domain.SrsEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SrsEngineTest {
    private val fixedNow = 1_795_176_000_000L // fixed epoch ms

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
        assertEquals(fixedNow + 24L * 3600_000L, grad.srsDueAtEpochMs)
        assertTrue(SrsEngine.isGraduatedForSrs(grad.preference, grad.knownSource, grad.srsDueAtEpochMs))
    }

    @Test
    fun advancesGraduatedWordAndResetsOnLapse() {
        val step0 = SrsEngine.computeNextSrsState(
            prev = null,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = true,
            nowMs = fixedNow,
        )
        val step1 = SrsEngine.computeNextSrsState(
            prev = step0,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = true,
            nowMs = fixedNow,
        )
        assertEquals(1, step1.srsLevel)
        assertEquals(fixedNow + 3L * 24L * 3600_000L, step1.srsDueAtEpochMs)

        val lapsed = SrsEngine.computeNextSrsState(
            prev = step1,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = false,
            nowMs = fixedNow,
        )
        assertEquals("learning", lapsed.state)
        assertEquals(0, lapsed.srsLevel)
        assertEquals(0, lapsed.correctStreak)
        assertEquals(fixedNow + 24L * 3600_000L, lapsed.srsDueAtEpochMs)
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
    fun rotatesEpisodeContextsAndHighlightsKanjiStems() {
        val contexts = listOf(
            SrsEngine.EpisodeContext(jp = "魔力を探知する。", en = "Detect mana.", episodeNumber = 1),
            SrsEngine.EpisodeContext(jp = "気配を探知した。", en = "Detected presence.", episodeNumber = 3),
        )
        assertEquals(1, SrsEngine.pickContextualSentence(contexts, 0)?.episodeNumber)
        assertEquals(3, SrsEngine.pickContextualSentence(contexts, 1)?.episodeNumber)

        val conjugated = SrsEngine.splitSentenceWithHighlight("早く食べよう", "食べる")
        assertTrue(conjugated.any { it.highlighted && it.text.startsWith("食") })

        assertEquals(listOf("探", "知"), SrsEngine.extractKanjiCharacters("探知する"))
    }
}
