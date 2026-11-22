package app.tatani.android

import app.tatani.android.domain.SrsEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SrsEngineTest {
    private val fixedNow = 1_795_176_000_000L // fixed epoch ms
    private val hourMs = 3600_000L
    private val dayMs = 24L * hourMs

    @Test
    fun graduatesNewlyEncodedWordToFourHourConsolidationAndBlocksEarlySkip() {
        val grad = SrsEngine.computeNextSrsState(
            prev = null,
            word = "探知",
            reading = "たんち",
            level = "N2",
            remembered = true,
            nowMs = fixedNow,
        )
        assertEquals("learning", grad.state)
        assertEquals("learned", grad.knownSource)
        assertEquals(0, grad.srsLevel)
        assertEquals(1, grad.correctStreak)
        assertEquals(fixedNow + 4L * hourMs, grad.srsDueAtEpochMs)
        assertTrue(grad.hasServerState)
        assertTrue(SrsEngine.isGraduatedForSrs(grad.preference, grad.knownSource, grad.srsDueAtEpochMs))

        // Cramming 5 minutes after Learn must NOT bypass the 4-hour consolidation spacing window
        val earlyCram = SrsEngine.computeNextSrsState(
            prev = grad,
            word = "探知",
            reading = "たんち",
            level = "N2",
            remembered = true,
            nowMs = fixedNow + 5L * 60_000L,
        )
        assertEquals("learning", earlyCram.state)
        assertEquals(fixedNow + 4L * hourMs, earlyCram.srsDueAtEpochMs)
        assertEquals("4h", SrsEngine.nextIntervalLabel(grad, remembered = true, nowMs = fixedNow + 60_000L))
    }

    @Test
    fun advancesFromFourHourConsolidationToOneDayToThreeDaysAndResetsToFourHoursOnLapse() {
        val step4h = SrsEngine.computeNextSrsState(
            prev = null,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = true,
            nowMs = fixedNow,
        )
        val due4h = step4h.srsDueAtEpochMs!!
        assertEquals("1d", SrsEngine.nextIntervalLabel(step4h, remembered = true, nowMs = due4h))

        // Reviewing once 4h consolidation is due promotes to known at 1d (level 0)
        val step1d = SrsEngine.computeNextSrsState(
            prev = step4h,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = true,
            nowMs = due4h,
        )
        assertEquals("known", step1d.state)
        assertEquals(0, step1d.srsLevel)
        assertEquals(due4h + dayMs, step1d.srsDueAtEpochMs)

        // Reviewing 1 day later promotes to 3d (level 1)
        val due1d = step1d.srsDueAtEpochMs!!
        assertEquals(3, SrsEngine.nextIntervalDays(step1d, remembered = true, nowMs = due1d))
        val step3d = SrsEngine.computeNextSrsState(
            prev = step1d,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = true,
            nowMs = due1d,
        )
        assertEquals("known", step3d.state)
        assertEquals(1, step3d.srsLevel)
        assertEquals(due1d + 3L * dayMs, step3d.srsDueAtEpochMs)

        // Lapsing drops back to 4h consolidation with streak 0 (re-scaffolding kana)
        val lapsed = SrsEngine.computeNextSrsState(
            prev = step3d,
            word = "魔法",
            reading = "まほう",
            level = "N4",
            remembered = false,
            nowMs = due1d,
        )
        assertEquals("learning", lapsed.state)
        assertEquals(0, lapsed.srsLevel)
        assertEquals(0, lapsed.correctStreak)
        assertEquals(due1d + 4L * hourMs, lapsed.srsDueAtEpochMs)
        assertEquals("4h", SrsEngine.nextIntervalLabel(step3d, remembered = false, nowMs = due1d))
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
        assertEquals(0, lapsed.correctStreak)

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
    fun threeStageDrillProgressionExpandsLagStepsDownOneRungAndSelectsSpacers() {
        assertEquals(8, SrsEngine.LEARN_BATCH_SIZE)
        assertEquals(3, SrsEngine.LEARN_GRADUATION_RECALLS)

        val hit1 = SrsEngine.computeLearnDrillStep(prevHits = 0, recalled = true)
        assertEquals(1, hit1.nextHits)
        assertFalse(hit1.graduated)
        assertEquals(4, hit1.targetGap)

        val hit2 = SrsEngine.computeLearnDrillStep(prevHits = 1, recalled = true)
        assertEquals(2, hit2.nextHits)
        assertFalse(hit2.graduated)
        assertEquals(5, hit2.targetGap)

        // Missing Kanji-first Hit 3 steps back ONE rung to Kana-assisted Hit 2 (not back to 0) with short lag 2
        val missOnHit3 = SrsEngine.computeLearnDrillStep(prevHits = 2, recalled = false)
        assertEquals(1, missOnHit3.nextHits)
        assertFalse(missOnHit3.graduated)
        assertEquals(2, missOnHit3.targetGap)

        val hit3 = SrsEngine.computeLearnDrillStep(prevHits = 2, recalled = true)
        assertEquals(3, hit3.nextHits)
        assertTrue(hit3.graduated)

        // Spacer cushion guarantees >= 2 intervening retrievals when queue shrinks at end of batch
        val pool = listOf("魔法", "約束", "冒険", "探知")
        val (spacers, nextCursor) = SrsEngine.selectSpacerItems(
            currentQueueSize = 0,
            targetWord = "探知",
            queuedWords = emptySet(),
            pool = pool,
            cursor = 2,
            wordOf = { it },
        )
        assertEquals(listOf("冒険", "魔法"), spacers)
        assertEquals(1, nextCursor)
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

    @Test
    fun fadesReadingScaffoldOnceGraduatedAndRescaffoldsOnLapse() {
        // Ungraduated / lapsed cards show kana reading upfront to repair phonological-semantic link
        assertTrue(
            SrsEngine.shouldShowReadingUpfront(
                word = "約束",
                reading = "やくそく",
                state = "learning",
                srsLevel = 0,
                correctStreak = 0,
            )
        )

        // Graduated cards (level >= 0, state = known, streak >= 1) fade to Kanji-first + 1-tap peek
        assertFalse(
            SrsEngine.shouldShowReadingUpfront(
                word = "約束",
                reading = "やくそく",
                state = "known",
                srsLevel = 0,
                correctStreak = 1,
            )
        )
        assertFalse(
            SrsEngine.shouldShowReadingUpfront(
                word = "約束",
                reading = "やくそく",
                state = "known",
                srsLevel = 2,
                correctStreak = 3,
            )
        )

        // Kanji-only preference or kana-only / Latin words never show redundant ruby upfront
        assertFalse(
            SrsEngine.shouldShowReadingUpfront(
                word = "約束",
                reading = "やくそく",
                state = "learning",
                srsLevel = 0,
                correctStreak = 0,
                preference = "kanji_only",
            )
        )
        assertFalse(
            SrsEngine.shouldShowReadingUpfront(
                word = "すごい",
                reading = "すごい",
                state = "learning",
                srsLevel = 0,
                correctStreak = 0,
            )
        )
        assertFalse(
            SrsEngine.shouldShowReadingUpfront(
                word = "hablar",
                reading = null,
                state = "learning",
                srsLevel = 0,
                correctStreak = 0,
            )
        )
    }

    @Test
    fun buildsSamePosMeaningChoicesAndDispersesLongIntervals() {
        val pool = listOf(
            SrsEngine.DistractorCandidate("探知", "detection", "名詞"),
            SrsEngine.DistractorCandidate("結界", "barrier", "名詞"),
            SrsEngine.DistractorCandidate("魔力", "mana", "名詞"),
            SrsEngine.DistractorCandidate("約束", "promise", "名詞"),
            SrsEngine.DistractorCandidate("走る", "to run", "動詞"),
        )
        val choices = SrsEngine.buildMeaningChoices(
            targetWord = "探知",
            targetMeaning = "detection",
            targetPos = "名詞",
            pool = pool,
            seed = 2,
        )
        assertEquals(4, choices.size)
        assertEquals(1, choices.count { it.isCorrect && it.meaning == "detection" })
        // Prefers matching 名詞 nouns over 動詞 verbs when 3+ noun distractors exist
        assertFalse(choices.any { it.meaning == "to run" })

        // Short intervals (0..2 = 1d, 3d, 7d) stay exact; long intervals (3+ = 14d+) stay within ±5%
        assertEquals(7L * dayMs, SrsEngine.fuzzedIntervalMs("探知", 2))
        val fuzzed14d = SrsEngine.fuzzedIntervalMs("探知", 3)
        assertTrue(fuzzed14d in (14L * dayMs * 95 / 100)..(14L * dayMs * 105 / 100))

        assertEquals(85, SrsEngine.computeComprehensionPercent(17, 20))
    }
}
