package app.tatani.android.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.VolumeUp
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.FastForward
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.tatani.android.data.local.WordCardEntity
import app.tatani.android.domain.SrsEngine
import app.tatani.android.ui.TataniViewModel
import app.tatani.android.ui.components.HighlightedSentenceText
import app.tatani.android.ui.theme.CrimsonAgain
import app.tatani.android.ui.theme.JadeSuccess
import app.tatani.android.ui.theme.SumiBackground
import app.tatani.android.ui.theme.SumiBorder
import app.tatani.android.ui.theme.SumiElevated
import app.tatani.android.ui.theme.SumiSurface
import app.tatani.android.ui.theme.VermilionPrimary
import app.tatani.android.ui.theme.WashiForeground
import app.tatani.android.ui.theme.WashiMuted

private enum class LearnPhase { ENCODE, DRILL, DONE }

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LearnScreen(
    viewModel: TataniViewModel,
    episodeId: String?,
    onBack: () -> Unit,
    onGoSprint: () -> Unit,
    onGoLibrary: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val deckCards by viewModel.deckCards.collectAsState()
    val nextLearnTarget by viewModel.nextLearnTarget.collectAsState()
    val session by viewModel.session.collectAsState()

    val targetEpId = episodeId ?: nextLearnTarget?.episodeId
    val skippedInSession = remember { mutableStateListOf<String>() }

    val availableUnlearned = remember(deckCards, targetEpId, session?.userLevel, skippedInSession.size) {
        val skippedSet = skippedInSession.toHashSet()
        val userRank = SrsEngine.jlptRank(session?.userLevel)
        deckCards.filter { c ->
            if (c.word in skippedSet) return@filter false
            val matchesEp = targetEpId == null || c.primaryEpisodeId == targetEpId ||
                viewModel.repository.decodeContexts(c).any { it.episodeId == targetEpId }
            val below = userRank in 1..50 && SrsEngine.jlptRank(c.level) < userRank
            matchesEp && SrsEngine.isUnlearnedCandidate(
                hasExistingState = c.hasServerState,
                state = c.state,
                preference = c.preference,
                knownSource = c.knownSource,
                srsDueAtEpochMs = c.srsDueAtEpochMs,
                isBelowUserLevel = below,
            )
        }.sortedByDescending { c ->
            c.frequency * 10 + (7 - SrsEngine.jlptRank(c.level).coerceAtMost(7)).coerceAtLeast(0)
        }
    }

    var phase by remember { mutableStateOf(LearnPhase.ENCODE) }
    val batch = remember { mutableStateListOf<WordCardEntity>() }
    var encodeIdx by remember { mutableIntStateOf(0) }
    val drillQueue = remember { mutableStateListOf<WordCardEntity>() }
    val drillHits = remember { mutableStateMapOf<String, Int>() }
    var drillRevealed by remember { mutableStateOf(false) }
    var drillReadingPeeked by remember { mutableStateOf(false) }
    var graduatedCount by remember { mutableIntStateOf(0) }
    var confirmExitDrill by remember { mutableStateOf(false) }

    val activeDrillInProgress = phase == LearnPhase.DRILL && drillQueue.isNotEmpty()
    BackHandler(enabled = activeDrillInProgress) {
        confirmExitDrill = true
    }

    LaunchedEffect(availableUnlearned, phase) {
        if (batch.isEmpty() && availableUnlearned.isNotEmpty() && phase == LearnPhase.ENCODE) {
            batch.addAll(availableUnlearned.take(SrsEngine.LEARN_BATCH_SIZE))
            encodeIdx = 0
        }
    }

    val encodeCard = batch.getOrNull(encodeIdx)
    val drillCard = drillQueue.firstOrNull()
    val activeCard = when (phase) {
        LearnPhase.ENCODE -> encodeCard
        LearnPhase.DRILL -> drillCard
        LearnPhase.DONE -> null
    }
    val activeContext = remember(activeCard?.word, activeCard?.contextsJson) {
        if (activeCard == null) null
        else {
            val all = viewModel.repository.decodeContexts(activeCard)
            all.firstOrNull { it.episodeId == targetEpId }
                ?: SrsEngine.pickContextualSentence(all, 0)
        }
    }

    fun startDrillPhase() {
        if (batch.isEmpty()) {
            phase = LearnPhase.DONE
            return
        }
        phase = LearnPhase.DRILL
        drillQueue.clear()
        drillQueue.addAll(batch)
        drillHits.clear()
        drillRevealed = false
        drillReadingPeeked = false
        graduatedCount = 0
    }

    fun onAlreadyKnow() {
        val card = encodeCard ?: return
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        if (card.word !in skippedInSession) {
            skippedInSession.add(card.word)
        }
        viewModel.markPriorKnown(card)
        val excluded = (batch.map { it.word } + skippedInSession).toHashSet()
        val replacement = availableUnlearned.firstOrNull { it.word !in excluded }
        batch.removeAt(encodeIdx)
        if (replacement != null) {
            batch.add(encodeIdx, replacement)
        } else if (encodeIdx >= batch.size) {
            startDrillPhase()
        }
    }

    fun onGotItEncode() {
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        if (encodeIdx + 1 < batch.size) {
            encodeIdx++
        } else {
            startDrillPhase()
        }
    }

    fun onDrillGrade(recalled: Boolean) {
        val head = drillQueue.removeFirstOrNull() ?: return
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        drillRevealed = false
        drillReadingPeeked = false
        val nextHits = if (recalled) (drillHits[head.word] ?: 0) + 1 else 0
        drillHits[head.word] = nextHits

        if (recalled && nextHits >= SrsEngine.LEARN_GRADUATION_RECALLS) {
            viewModel.gradeCard(head, true)
            graduatedCount++
            if (drillQueue.isEmpty()) {
                phase = LearnPhase.DONE
            }
            return
        }

        val gap = if (recalled) 3.coerceAtMost(drillQueue.size) else 2.coerceAtMost(drillQueue.size)
        val idx = if (drillQueue.isNotEmpty()) gap.coerceAtLeast(1) else 0
        drillQueue.add(idx, head)
    }

    val progressFraction = when (phase) {
        LearnPhase.ENCODE -> (encodeIdx.toFloat() / (batch.size.coerceAtLeast(1) * 2f))
        LearnPhase.DRILL -> 0.5f + (graduatedCount.toFloat() / (batch.size.coerceAtLeast(1) * 2f))
        LearnPhase.DONE -> 1f
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        // Header + Progress
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = {
                        if (activeDrillInProgress) confirmExitDrill = true else onBack()
                    },
                    modifier = Modifier.size(36.dp),
                ) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                }
                Text(
                    text = when (phase) {
                        LearnPhase.ENCODE -> "Step 1/2 · Contextual Encoding"
                        LearnPhase.DRILL -> "Step 2/2 · Short-Lag Recall ($graduatedCount/${batch.size})"
                        LearnPhase.DONE -> if (graduatedCount > 0) "Batch Graduated" else "Batch Complete"
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = WashiMuted,
                )
                TextButton(
                    onClick = {
                        if (activeDrillInProgress) confirmExitDrill = true else onGoSprint()
                    }
                ) {
                    Icon(
                        imageVector = Icons.Outlined.Bolt,
                        contentDescription = null,
                        tint = VermilionPrimary,
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.size(4.dp))
                    Text("Sprint", style = MaterialTheme.typography.labelMedium)
                }
            }
            LinearProgressIndicator(
                progress = { progressFraction },
                color = VermilionPrimary,
                trackColor = SumiElevated,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        when {
            batch.isEmpty() && phase != LearnPhase.DONE -> {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(containerColor = SumiSurface),
                    border = BorderStroke(1.dp, SumiBorder),
                ) {
                    Column(
                        modifier = Modifier.padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("No unlearned words ready", style = MaterialTheme.typography.headlineMedium)
                        Text(
                            "Open an anime episode in your library and fetch subtitles to extract new contextual vocabulary.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = WashiMuted,
                            textAlign = TextAlign.Center,
                        )
                        Button(
                            onClick = onGoLibrary,
                            colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.fillMaxWidth().height(50.dp),
                        ) {
                            Text("Open Anime Library")
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }

            phase == LearnPhase.DONE -> {
                val nextCount = availableUnlearned.size.coerceAtMost(SrsEngine.LEARN_BATCH_SIZE)
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(22.dp),
                    colors = CardDefaults.cardColors(containerColor = SumiSurface),
                    border = BorderStroke(1.dp, SumiBorder),
                ) {
                    Column(
                        modifier = Modifier.padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Text(
                            text = if (graduatedCount > 0) "Batch graduated to SRS" else "All words marked known",
                            style = MaterialTheme.typography.headlineMedium,
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            text = when (graduatedCount) {
                                0 -> "Skipped known vocabulary — no SRS drills needed for this batch."
                                1 -> "1 word encoded in context and scheduled for fast Sprint reviews."
                                else -> "$graduatedCount words encoded in context and scheduled for fast Sprint reviews."
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = WashiMuted,
                            textAlign = TextAlign.Center,
                        )
                        if (nextCount > 0) {
                            Button(
                                onClick = {
                                    batch.clear()
                                    encodeIdx = 0
                                    graduatedCount = 0
                                    phase = LearnPhase.ENCODE
                                },
                                colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                                shape = RoundedCornerShape(14.dp),
                                modifier = Modifier.fillMaxWidth().height(52.dp),
                            ) {
                                Text("Learn next $nextCount words", fontWeight = FontWeight.SemiBold)
                            }
                        }
                        OutlinedButton(
                            onClick = onGoSprint,
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, SumiBorder),
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                        ) {
                            Text("Back to Sprint")
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }

            phase == LearnPhase.ENCODE && encodeCard != null -> {
                val kanjiList = remember(encodeCard.word) {
                    SrsEngine.extractKanjiCharacters(encodeCard.word)
                }

                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(vertical = 12.dp),
                    shape = RoundedCornerShape(22.dp),
                    colors = CardDefaults.cardColors(containerColor = SumiSurface),
                    border = BorderStroke(1.dp, SumiBorder),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(22.dp),
                        verticalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "${encodeIdx + 1} / ${batch.size}",
                                style = MaterialTheme.typography.labelMedium,
                                color = WashiMuted,
                            )
                            Surface(
                                onClick = {
                                    viewModel.tts.speak(
                                        encodeCard.reading ?: encodeCard.word,
                                        session?.learningLanguage ?: "ja"
                                    )
                                },
                                shape = RoundedCornerShape(10.dp),
                                color = SumiElevated,
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    Icon(
                                        Icons.AutoMirrored.Outlined.VolumeUp,
                                        contentDescription = "Audio",
                                        modifier = Modifier.size(15.dp),
                                    )
                                    Text("Audio", style = MaterialTheme.typography.labelMedium)
                                }
                            }
                        }

                        // Guided Errorless Encoding: Reading + Kanji + Meaning + Breakdown
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .padding(vertical = 8.dp)
                                .verticalScroll(rememberScrollState()),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
                        ) {
                            if (!encodeCard.reading.isNullOrBlank() && encodeCard.reading != encodeCard.word) {
                                Text(
                                    text = encodeCard.reading,
                                    fontSize = 21.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = VermilionPrimary,
                                )
                            }
                            Text(
                                text = encodeCard.word,
                                style = MaterialTheme.typography.displayLarge,
                                textAlign = TextAlign.Center,
                            )
                            Text(
                                text = encodeCard.meaning,
                                style = MaterialTheme.typography.headlineMedium,
                                textAlign = TextAlign.Center,
                            )
                            if (encodeCard.partOfSpeech.isNotBlank()) {
                                Text(
                                    text = encodeCard.partOfSpeech,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = WashiMuted,
                                )
                            }
                            if (kanjiList.size > 1) {
                                FlowRow(
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    for (ch in kanjiList) {
                                        Surface(
                                            shape = RoundedCornerShape(8.dp),
                                            color = SumiElevated,
                                            border = BorderStroke(1.dp, SumiBorder),
                                        ) {
                                            Text(
                                                text = ch,
                                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                                                fontWeight = FontWeight.SemiBold,
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        // Anime Scene Context Sentence + Translation
                        if (activeContext != null) {
                            Surface(
                                shape = RoundedCornerShape(14.dp),
                                color = SumiBackground.copy(alpha = 0.65f),
                                border = BorderStroke(1.dp, SumiBorder),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column(
                                    modifier = Modifier.padding(14.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    if (activeContext.animeTitle.isNotBlank()) {
                                        Text(
                                            text = "${activeContext.animeTitle} · Ep ${activeContext.episodeNumber}",
                                            style = MaterialTheme.typography.labelMedium,
                                            color = WashiMuted,
                                        )
                                    }
                                    HighlightedSentenceText(
                                        sentence = activeContext.jp,
                                        targetWord = encodeCard.word,
                                    )
                                    if (activeContext.en.isNotBlank()) {
                                        Text(
                                            text = activeContext.en,
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = WashiMuted,
                                        )
                                    }
                                }
                            }
                        } else {
                            Spacer(Modifier.height(4.dp))
                        }
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    OutlinedButton(
                        onClick = ::onAlreadyKnow,
                        shape = RoundedCornerShape(16.dp),
                        border = BorderStroke(1.dp, SumiBorder),
                        modifier = Modifier
                            .weight(0.42f)
                            .height(62.dp),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Icon(Icons.Outlined.FastForward, contentDescription = null, modifier = Modifier.size(16.dp))
                                Text("Known", fontWeight = FontWeight.SemiBold)
                            }
                            Text("Skip SRS", style = MaterialTheme.typography.labelMedium, color = WashiMuted)
                        }
                    }

                    Button(
                        onClick = ::onGotItEncode,
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                        modifier = Modifier
                            .weight(0.58f)
                            .height(62.dp),
                    ) {
                        Text(
                            text = if (encodeIdx + 1 < batch.size) "Got it — Next" else "Start Recall Drill",
                            fontWeight = FontWeight.SemiBold,
                        )
                        Spacer(Modifier.size(6.dp))
                        Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null, modifier = Modifier.size(18.dp))
                    }
                }
            }

            phase == LearnPhase.DRILL && drillCard != null -> {
                val hits = drillHits[drillCard.word] ?: 0
                val hasDistinctReading = !drillCard.reading.isNullOrBlank() && drillCard.reading != drillCard.word
                val showDrillReading = hasDistinctReading && (drillRevealed || drillReadingPeeked || hits == 0)
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(vertical = 12.dp)
                        .clickable(enabled = !drillRevealed) {
                            drillRevealed = true
                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        },
                    shape = RoundedCornerShape(22.dp),
                    colors = CardDefaults.cardColors(containerColor = SumiSurface),
                    border = BorderStroke(1.dp, SumiBorder),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(22.dp),
                        verticalArrangement = Arrangement.SpaceBetween,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "Recall English meaning",
                                style = MaterialTheme.typography.labelMedium,
                                color = WashiMuted,
                            )
                            Surface(
                                onClick = {
                                    viewModel.tts.speak(
                                        drillCard.reading ?: drillCard.word,
                                        session?.learningLanguage ?: "ja"
                                    )
                                },
                                shape = RoundedCornerShape(10.dp),
                                color = SumiElevated,
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    Icon(
                                        Icons.AutoMirrored.Outlined.VolumeUp,
                                        contentDescription = "Audio",
                                        modifier = Modifier.size(15.dp),
                                    )
                                    Text("Audio", style = MaterialTheme.typography.labelMedium)
                                }
                            }
                        }

                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .padding(vertical = 8.dp)
                                .verticalScroll(rememberScrollState()),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                if (showDrillReading) {
                                    Text(
                                        text = drillCard.reading!!,
                                        fontSize = 20.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = VermilionPrimary,
                                    )
                                    Spacer(Modifier.height(4.dp))
                                } else if (!drillRevealed && hasDistinctReading) {
                                    Surface(
                                        onClick = {
                                            drillReadingPeeked = true
                                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                        },
                                        shape = RoundedCornerShape(50),
                                        color = SumiElevated,
                                        border = BorderStroke(1.dp, SumiBorder),
                                    ) {
                                        Text(
                                            text = "かな · Peek reading",
                                            style = MaterialTheme.typography.labelMedium,
                                            color = WashiMuted,
                                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                                        )
                                    }
                                    Spacer(Modifier.height(8.dp))
                                }
                                Text(
                                    text = drillCard.word,
                                    style = MaterialTheme.typography.displayLarge,
                                    textAlign = TextAlign.Center,
                                )
                            }

                            if (activeContext != null) {
                                Surface(
                                    shape = RoundedCornerShape(14.dp),
                                    color = SumiBackground.copy(alpha = 0.65f),
                                    border = BorderStroke(1.dp, SumiBorder),
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Column(
                                        modifier = Modifier.padding(14.dp),
                                        verticalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        HighlightedSentenceText(
                                            sentence = activeContext.jp,
                                            targetWord = drillCard.word,
                                        )
                                        if (drillRevealed && activeContext.en.isNotBlank()) {
                                            Text(
                                                text = activeContext.en,
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = WashiMuted,
                                            )
                                        }
                                    }
                                }
                            }

                            if (drillRevealed) {
                                Column(
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    Text(
                                        text = drillCard.meaning,
                                        style = MaterialTheme.typography.headlineMedium,
                                        textAlign = TextAlign.Center,
                                    )
                                    if (drillCard.partOfSpeech.isNotBlank()) {
                                        Surface(
                                            shape = RoundedCornerShape(8.dp),
                                            color = SumiElevated,
                                        ) {
                                            Text(
                                                text = drillCard.partOfSpeech,
                                                style = MaterialTheme.typography.labelMedium,
                                                color = WashiMuted,
                                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        Text(
                            text = if (!drillRevealed) "Recall English meaning · Tap card to reveal" else "",
                            style = MaterialTheme.typography.labelMedium,
                            color = WashiMuted,
                        )
                    }
                }

                if (!drillRevealed) {
                    Button(
                        onClick = {
                            drillRevealed = true
                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        },
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = SumiElevated,
                            contentColor = WashiForeground,
                        ),
                        modifier = Modifier.fillMaxWidth().height(64.dp),
                    ) {
                        Text("Tap to Reveal", style = MaterialTheme.typography.titleMedium)
                    }
                } else {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        OutlinedButton(
                            onClick = { onDrillGrade(false) },
                            shape = RoundedCornerShape(16.dp),
                            border = BorderStroke(1.dp, CrimsonAgain.copy(alpha = 0.55f)),
                            modifier = Modifier.weight(1f).height(64.dp),
                        ) {
                            Icon(Icons.Outlined.Close, contentDescription = null, tint = CrimsonAgain, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(4.dp))
                            Text("Show again", color = CrimsonAgain, fontWeight = FontWeight.SemiBold)
                        }

                        Button(
                            onClick = { onDrillGrade(true) },
                            shape = RoundedCornerShape(16.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = JadeSuccess),
                            modifier = Modifier.weight(1f).height(64.dp),
                        ) {
                            Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.size(4.dp))
                            Text(
                                "Recalled (${hits + 1}/${SrsEngine.LEARN_GRADUATION_RECALLS})",
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            }
        }
    }

    if (confirmExitDrill) {
        AlertDialog(
            onDismissRequest = { confirmExitDrill = false },
            containerColor = SumiSurface,
            title = { Text("Leave recall drill?") },
            text = {
                Text(
                    "Words still in this drill haven't graduated to SRS yet ($graduatedCount/${batch.size} graduated).",
                    color = WashiMuted,
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        confirmExitDrill = false
                        onBack()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = CrimsonAgain),
                ) {
                    Text("Leave drill")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmExitDrill = false }) {
                    Text("Keep drilling")
                }
            },
        )
    }
}
