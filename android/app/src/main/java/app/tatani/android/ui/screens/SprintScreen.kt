package app.tatani.android.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.automirrored.outlined.VolumeOff
import androidx.compose.material.icons.automirrored.outlined.VolumeUp
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Headphones
import androidx.compose.material.icons.outlined.Title
import androidx.compose.material.icons.outlined.VideoLibrary
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.tatani.android.data.local.WordCardEntity
import app.tatani.android.domain.SrsEngine
import app.tatani.android.ui.TataniViewModel
import app.tatani.android.ui.components.HighlightedSentenceText
import app.tatani.android.ui.theme.AmberAccent
import app.tatani.android.ui.theme.CrimsonAgain
import app.tatani.android.ui.theme.JadeSuccess
import app.tatani.android.ui.theme.SumiBackground
import app.tatani.android.ui.theme.SumiBorder
import app.tatani.android.ui.theme.SumiElevated
import app.tatani.android.ui.theme.SumiSurface
import app.tatani.android.ui.theme.VermilionPrimary
import app.tatani.android.ui.theme.WashiForeground
import app.tatani.android.ui.theme.WashiMuted
import kotlin.math.abs
import kotlin.math.roundToInt

private data class SprintUndoEntry(
    val card: WordCardEntity,
    val prevSnapshot: SrsEngine.SrsSnapshot,
    val prevQueue: List<WordCardEntity>,
    val prevCramMode: Boolean,
    val prevCombo: Int,
)

@Composable
fun SprintScreen(
    viewModel: TataniViewModel,
    onOpenLibrary: () -> Unit,
    onOpenLearn: (String?) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    val swipeThresholdPx = with(density) { 96.dp.toPx() }
    val maxDragPx = with(density) { 220.dp.toPx() }

    val dueCards by viewModel.dueCards.collectAsState()
    val graduatedCards by viewModel.graduatedCards.collectAsState()
    val deckCards by viewModel.deckCards.collectAsState()
    val dailyStreak by viewModel.dailyStreak.collectAsState()
    val nextLearnTarget by viewModel.nextLearnTarget.collectAsState()
    val syncing by viewModel.syncing.collectAsState()
    val outboxCount by viewModel.outboxCount.collectAsState()
    val session by viewModel.session.collectAsState()

    val queue = remember { mutableStateListOf<WordCardEntity>() }
    val undoStack = remember { mutableStateListOf<SprintUndoEntry>() }
    var cramMode by remember { mutableStateOf(false) }
    var revealed by remember { mutableStateOf(false) }
    var readingPeeked by remember { mutableStateOf(false) }
    var listeningMode by remember { mutableStateOf(false) }
    var autoAudio by remember { mutableStateOf(false) }
    var reviewedCount by remember { mutableIntStateOf(0) }
    var sessionCombo by remember { mutableIntStateOf(0) }
    val sessionStartMs = remember { System.currentTimeMillis() }
    var dragOffsetX by remember { mutableFloatStateOf(0f) }

    LaunchedEffect(queue.size, cramMode) {
        if (cramMode && queue.isEmpty()) {
            cramMode = false
        }
    }

    // Seed and top-up Sprint queue seamlessly from Room SQLite without disrupting current card
    LaunchedEffect(dueCards, cramMode) {
        if (!cramMode) {
            if (queue.isEmpty() && dueCards.isNotEmpty()) {
                queue.addAll(dueCards)
            } else {
                val existing = queue.map { it.word }.toSet()
                val incoming = dueCards.filter { it.word !in existing }
                if (incoming.isNotEmpty()) queue.addAll(incoming)
            }
        }
    }

    val deckMap = remember(deckCards) { deckCards.associateBy { it.word } }
    val current = queue.firstOrNull()?.let { deckMap[it.word] ?: it }

    LaunchedEffect(current?.word, reviewedCount) {
        readingPeeked = false
    }

    val contexts = remember(current?.word, current?.contextsJson) {
        if (current == null) emptyList() else viewModel.repository.decodeContexts(current)
    }
    val activeContext = remember(contexts, current?.srsLevel, current?.correctStreak, reviewedCount) {
        if (current == null) null
        else SrsEngine.pickContextualSentence(
            contexts,
            current.srsLevel + current.correctStreak + reviewedCount
        )
    }

    LaunchedEffect(current?.word, revealed, listeningMode) {
        if (current != null && !revealed && listeningMode) {
            viewModel.tts.speak(current.reading ?: current.word, session?.learningLanguage ?: "ja")
        }
    }

    fun revealCard() {
        val card = current ?: return
        if (revealed) return
        revealed = true
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        if (autoAudio) {
            viewModel.tts.speak(card.reading ?: card.word, session?.learningLanguage ?: "ja")
        }
    }

    fun gradeCurrent(remembered: Boolean) {
        val card = current ?: return
        val snapshotQueue = queue.toList()
        val snapshotCram = cramMode
        val prevSnap = card.toSrsSnapshot()

        if (undoStack.size >= 20) undoStack.removeAt(0)
        undoStack.add(SprintUndoEntry(card, prevSnap, snapshotQueue, snapshotCram, sessionCombo))

        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        revealed = false
        readingPeeked = false
        dragOffsetX = 0f
        reviewedCount++
        sessionCombo = if (remembered) sessionCombo + 1 else 0

        if (queue.isNotEmpty()) {
            val head = queue.removeAt(0)
            if (!remembered) {
                val idx = SrsEngine.SPRINT_LAPSE_REINSERT_GAP.coerceAtMost(queue.size)
                queue.add(idx, head)
            }
        }
        if (cramMode && queue.isEmpty()) {
            cramMode = false
        }

        viewModel.gradeCard(card, remembered)
    }

    fun undoLast() {
        val last = undoStack.removeLastOrNull() ?: return
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        viewModel.restoreSnapshot(last.card, last.prevSnapshot)
        cramMode = last.prevCramMode
        sessionCombo = last.prevCombo
        queue.clear()
        queue.addAll(last.prevQueue)
        revealed = false
        readingPeeked = false
        dragOffsetX = 0f
        reviewedCount = (reviewedCount - 1).coerceAtLeast(0)
    }

    val cardsPerMin = remember(reviewedCount) {
        if (reviewedCount < 2) 0
        else {
            val mins = ((System.currentTimeMillis() - sessionStartMs) / 60000.0).coerceAtLeast(0.15)
            (reviewedCount / mins).roundToInt().coerceAtMost(99)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        // Minimal Distraction-Free Top Bar + Session Goal-Gradient Progress Bar
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Surface(
                        shape = CircleShape,
                        color = SumiElevated,
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.Bolt,
                                contentDescription = null,
                                tint = VermilionPrimary,
                                modifier = Modifier.size(15.dp),
                            )
                            Text(
                                text = if (cramMode) "${queue.size} ahead" else "${queue.size} due",
                                style = MaterialTheme.typography.labelMedium,
                                color = WashiForeground,
                            )
                        }
                    }

                    if (sessionCombo >= 3) {
                        Surface(
                            shape = CircleShape,
                            color = JadeSuccess.copy(alpha = 0.18f),
                        ) {
                            Text(
                                text = "⚡ ${sessionCombo}x",
                                style = MaterialTheme.typography.labelMedium,
                                color = JadeSuccess,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
                            )
                        }
                    } else if (dailyStreak > 0) {
                        Text(
                            text = "🔥 ${dailyStreak}d",
                            style = MaterialTheme.typography.labelMedium,
                            color = AmberAccent,
                            fontWeight = FontWeight.SemiBold,
                        )
                    } else if (cardsPerMin > 0) {
                        Text(
                            text = "$cardsPerMin/min",
                            style = MaterialTheme.typography.labelMedium,
                            color = WashiMuted,
                        )
                    } else if (outboxCount > 0) {
                        Text(
                            text = "Syncing…",
                            style = MaterialTheme.typography.labelMedium,
                            color = WashiMuted,
                        )
                    }

                    if (undoStack.isNotEmpty()) {
                        IconButton(
                            onClick = ::undoLast,
                            modifier = Modifier.size(34.dp),
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Outlined.Undo,
                                contentDescription = "Undo",
                                tint = WashiMuted,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    IconButton(
                        onClick = { listeningMode = !listeningMode },
                        modifier = Modifier.size(36.dp),
                    ) {
                        Icon(
                            imageVector = if (listeningMode) Icons.Outlined.Headphones else Icons.Outlined.Title,
                            contentDescription = "Toggle listening mode",
                            tint = if (listeningMode) VermilionPrimary else WashiForeground,
                            modifier = Modifier.size(19.dp),
                        )
                    }
                    IconButton(
                        onClick = { autoAudio = !autoAudio },
                        modifier = Modifier.size(36.dp),
                    ) {
                        Icon(
                            imageVector = if (autoAudio) Icons.AutoMirrored.Outlined.VolumeUp else Icons.AutoMirrored.Outlined.VolumeOff,
                            contentDescription = "Toggle auto audio",
                            tint = if (autoAudio) WashiForeground else WashiMuted,
                            modifier = Modifier.size(19.dp),
                        )
                    }
                    OutlinedButton(
                        onClick = onOpenLibrary,
                        shape = RoundedCornerShape(12.dp),
                        border = BorderStroke(1.dp, SumiBorder),
                        modifier = Modifier.height(36.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.VideoLibrary,
                            contentDescription = null,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(Modifier.size(6.dp))
                        Text("Library", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }

            if (current != null && (reviewedCount + queue.size) > 0) {
                val sessionPct = (reviewedCount.toFloat() / (reviewedCount + queue.size).coerceAtLeast(1))
                    .coerceIn(0.03f, 1f)
                LinearProgressIndicator(
                    progress = { sessionPct },
                    color = if (sessionCombo >= 3) JadeSuccess else VermilionPrimary,
                    trackColor = SumiElevated,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(4.dp)
                        .clip(RoundedCornerShape(4.dp)),
                )
            }
        }

        if (current != null) {
            val currentSnap = current.toSrsSnapshot()
            val knowLabel = SrsEngine.nextIntervalLabel(
                prev = currentSnap,
                remembered = true,
            )
            val againLabel = SrsEngine.nextIntervalLabel(
                prev = currentSnap,
                remembered = false,
            )
            val latestRevealed by rememberUpdatedState(revealed)
            val latestGradeCurrent by rememberUpdatedState(::gradeCurrent)
            val latestThresholdPx by rememberUpdatedState(swipeThresholdPx)
            val latestMaxDragPx by rememberUpdatedState(maxDragPx)

            val swipeProgress = (dragOffsetX / swipeThresholdPx.coerceAtLeast(1f)).coerceIn(-1f, 1f)
            val cardContainerColor = when {
                swipeProgress > 0f -> lerp(SumiSurface, JadeSuccess, 0.14f * swipeProgress)
                swipeProgress < 0f -> lerp(SumiSurface, CrimsonAgain, 0.14f * (-swipeProgress))
                else -> SumiSurface
            }
            val cardBorderColor = when {
                swipeProgress > 0.08f -> lerp(SumiBorder, JadeSuccess, swipeProgress)
                swipeProgress < -0.08f -> lerp(SumiBorder, CrimsonAgain, -swipeProgress)
                else -> SumiBorder
            }

            // Swipeable & Tappable 120Hz Flashcard Stage
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(vertical = 12.dp)
                    .offset { IntOffset(dragOffsetX.roundToInt(), 0) }
                    .pointerInput(current.word) {
                        detectHorizontalDragGestures(
                            onDragEnd = {
                                if (latestRevealed) {
                                    when {
                                        dragOffsetX > latestThresholdPx -> latestGradeCurrent(true)
                                        dragOffsetX < -latestThresholdPx -> latestGradeCurrent(false)
                                        else -> dragOffsetX = 0f
                                    }
                                } else {
                                    dragOffsetX = 0f
                                }
                            },
                            onDragCancel = { dragOffsetX = 0f },
                            onHorizontalDrag = { change, dragAmount ->
                                if (latestRevealed) {
                                    change.consume()
                                    dragOffsetX = (dragOffsetX + dragAmount)
                                        .coerceIn(-latestMaxDragPx, latestMaxDragPx)
                                }
                            },
                        )
                    }
                    .clickable(enabled = !revealed) { revealCard() },
                shape = RoundedCornerShape(22.dp),
                colors = CardDefaults.cardColors(containerColor = cardContainerColor),
                border = BorderStroke(1.dp, cardBorderColor),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(22.dp),
                    verticalArrangement = Arrangement.SpaceBetween,
                ) {
                    // Metadata Header
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.weight(1f),
                        ) {
                            if (!current.level.isNullOrBlank()) {
                                Surface(
                                    shape = RoundedCornerShape(8.dp),
                                    color = SumiElevated,
                                ) {
                                    Text(
                                        text = current.level.uppercase(),
                                        style = MaterialTheme.typography.labelMedium,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                    )
                                }
                            }
                            if (activeContext != null && activeContext.animeTitle.isNotBlank()) {
                                Text(
                                    text = "${activeContext.animeTitle} · Ep ${activeContext.episodeNumber}",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = WashiMuted,
                                )
                            }
                        }

                        Surface(
                            onClick = {
                                viewModel.tts.speak(
                                    current.reading ?: current.word,
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
                                    imageVector = Icons.AutoMirrored.Outlined.VolumeUp,
                                    contentDescription = "Replay pronunciation",
                                    modifier = Modifier.size(15.dp),
                                )
                                Text("Audio", style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }

                    // Center Prompt & Reveal Content (scrollable on compact screens)
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .padding(vertical = 8.dp)
                            .verticalScroll(rememberScrollState()),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                    ) {
                        if (listeningMode && !revealed) {
                            Surface(
                                shape = CircleShape,
                                color = VermilionPrimary.copy(alpha = 0.16f),
                                modifier = Modifier.size(68.dp),
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    Icon(
                                        imageVector = Icons.Outlined.Headphones,
                                        contentDescription = null,
                                        tint = VermilionPrimary,
                                        modifier = Modifier.size(30.dp),
                                    )
                                }
                            }
                            Text(
                                text = "Listen and recall meaning",
                                style = MaterialTheme.typography.bodyMedium,
                                color = WashiMuted,
                            )
                        } else {
                            val hasDistinctReading = !current.reading.isNullOrBlank() && current.reading != current.word
                            val showReadingNow = hasDistinctReading && (
                                revealed ||
                                    readingPeeked ||
                                    SrsEngine.shouldShowReadingUpfront(
                                        word = current.word,
                                        reading = current.reading,
                                        state = current.state,
                                        srsLevel = current.srsLevel,
                                        correctStreak = current.correctStreak,
                                        preference = current.preference,
                                    )
                            )
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                if (showReadingNow) {
                                    Text(
                                        text = current.reading!!,
                                        fontSize = 20.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = VermilionPrimary,
                                    )
                                    Spacer(Modifier.height(4.dp))
                                } else if (!revealed && hasDistinctReading) {
                                    Surface(
                                        onClick = {
                                            readingPeeked = true
                                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                        },
                                        shape = CircleShape,
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
                                    text = current.word,
                                    style = MaterialTheme.typography.displayLarge,
                                    textAlign = TextAlign.Center,
                                )
                            }
                        }

                        if (activeContext != null && (!listeningMode || revealed)) {
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
                                        targetWord = current.word,
                                    )
                                    if (revealed && activeContext.en.isNotBlank()) {
                                        Text(
                                            text = activeContext.en,
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = WashiMuted,
                                        )
                                    }
                                }
                            }
                        }

                        if (revealed) {
                            val lapseKanji = remember(current.word, current.state) {
                                if (current.state == "learning") SrsEngine.extractKanjiCharacters(current.word)
                                else emptyList()
                            }
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Text(
                                    text = current.meaning,
                                    style = MaterialTheme.typography.headlineMedium,
                                    textAlign = TextAlign.Center,
                                )
                                if (current.partOfSpeech.isNotBlank()) {
                                    Text(
                                        text = current.partOfSpeech,
                                        style = MaterialTheme.typography.labelMedium,
                                        color = WashiMuted,
                                    )
                                }
                                if (lapseKanji.size > 1) {
                                    Row(
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        for (ch in lapseKanji) {
                                            Surface(
                                                shape = RoundedCornerShape(8.dp),
                                                color = SumiElevated,
                                                border = BorderStroke(1.dp, SumiBorder),
                                            ) {
                                                Text(
                                                    text = ch,
                                                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
                                                    fontWeight = FontWeight.SemiBold,
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    val footerHint = when {
                        !revealed -> "Recall English meaning · Tap card to reveal"
                        swipeProgress >= 0.35f -> "Release right · Know (+$knowLabel)"
                        swipeProgress <= -0.35f -> "Release left · Again ($againLabel)"
                        else -> "Swipe left/right or tap below"
                    }
                    val footerColor = when {
                        swipeProgress >= 0.35f -> JadeSuccess
                        swipeProgress <= -0.35f -> CrimsonAgain
                        else -> WashiMuted.copy(alpha = 0.7f)
                    }
                    Text(
                        text = footerHint,
                        style = MaterialTheme.typography.labelMedium,
                        color = footerColor,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            // Bottom Ergonomic Thumb Bar
            if (!revealed) {
                Button(
                    onClick = ::revealCard,
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SumiElevated,
                        contentColor = WashiForeground,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(64.dp),
                ) {
                    Text("Tap to Reveal", style = MaterialTheme.typography.titleMedium)
                }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    OutlinedButton(
                        onClick = { gradeCurrent(false) },
                        shape = RoundedCornerShape(16.dp),
                        border = BorderStroke(1.dp, CrimsonAgain.copy(alpha = 0.55f)),
                        modifier = Modifier
                            .weight(1f)
                            .height(64.dp),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.Close,
                                    contentDescription = null,
                                    tint = CrimsonAgain,
                                    modifier = Modifier.size(18.dp),
                                )
                                Text(
                                    text = "Again",
                                    color = CrimsonAgain,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            Text(
                                text = "Re-drill · $againLabel",
                                style = MaterialTheme.typography.labelMedium,
                                color = WashiMuted,
                            )
                        }
                    }

                    Button(
                        onClick = { gradeCurrent(true) },
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = JadeSuccess,
                            contentColor = WashiForeground,
                        ),
                        modifier = Modifier
                            .weight(1f)
                            .height(64.dp),
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Outlined.Check,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Text(
                                    text = "Know",
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            Text(
                                text = "Next · $knowLabel",
                                style = MaterialTheme.typography.labelMedium,
                                color = WashiForeground.copy(alpha = 0.88f),
                            )
                        }
                    }
                }
            }
        } else {
            // Caught-Up Ready State
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center,
            ) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(22.dp),
                    colors = CardDefaults.cardColors(containerColor = SumiSurface),
                    border = BorderStroke(1.dp, SumiBorder),
                ) {
                    Column(
                        modifier = Modifier.padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(18.dp),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = if (syncing) "Syncing deck…" else "All caught up",
                                    style = MaterialTheme.typography.headlineMedium,
                                )
                                if (dailyStreak > 0) {
                                    Surface(
                                        shape = CircleShape,
                                        color = AmberAccent.copy(alpha = 0.16f),
                                    ) {
                                        Text(
                                            text = "🔥 ${dailyStreak}d streak",
                                            style = MaterialTheme.typography.labelMedium,
                                            color = AmberAccent,
                                            fontWeight = FontWeight.SemiBold,
                                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                                        )
                                    }
                                }
                            }
                            Text(
                                text = "Zero SRS reviews due right now. Encode a small batch of new anime words in context or open your library.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = WashiMuted,
                            )
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            MetricTile(
                                value = reviewedCount.toString(),
                                label = "Reviewed",
                                modifier = Modifier.weight(1f),
                            )
                            MetricTile(
                                value = graduatedCards.size.toString(),
                                label = "In SRS",
                                modifier = Modifier.weight(1f),
                            )
                            val due24h = remember(graduatedCards) {
                                val horizon = System.currentTimeMillis() + 24L * 3600_000L
                                graduatedCards.count { (it.srsDueAtEpochMs ?: Long.MAX_VALUE) <= horizon }
                            }
                            MetricTile(
                                value = due24h.toString(),
                                label = "In 24h",
                                modifier = Modifier.weight(1f),
                            )
                        }

                        val learnTarget = nextLearnTarget
                        if (learnTarget != null && learnTarget.unlearnedWords.isNotEmpty()) {
                            val n = learnTarget.unlearnedWords.size.coerceAtMost(SrsEngine.LEARN_BATCH_SIZE)
                            Button(
                                onClick = { onOpenLearn(learnTarget.episodeId) },
                                shape = RoundedCornerShape(14.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(54.dp),
                            ) {
                                Text(
                                    text = "Learn $n new words · ${learnTarget.animeTitle} Ep ${learnTarget.episodeNumber}",
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                        } else {
                            Button(
                                onClick = onOpenLibrary,
                                shape = RoundedCornerShape(14.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(52.dp),
                            ) {
                                Text("Open Anime Library", fontWeight = FontWeight.SemiBold)
                            }
                        }

                        if (graduatedCards.isNotEmpty()) {
                            OutlinedButton(
                                onClick = {
                                    cramMode = true
                                    queue.clear()
                                    queue.addAll(graduatedCards.sortedBy { it.srsDueAtEpochMs ?: 0L }.take(25))
                                    revealed = false
                                    readingPeeked = false
                                },
                                shape = RoundedCornerShape(14.dp),
                                border = BorderStroke(1.dp, SumiBorder),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(48.dp),
                            ) {
                                Text("Practice ahead (${graduatedCards.size.coerceAtMost(25)})")
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun MetricTile(
    value: String,
    label: String,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = SumiBackground.copy(alpha = 0.6f),
        border = BorderStroke(1.dp, SumiBorder),
    ) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(text = value, style = MaterialTheme.typography.titleMedium)
            Text(text = label, style = MaterialTheme.typography.labelMedium, color = WashiMuted)
        }
    }
}
