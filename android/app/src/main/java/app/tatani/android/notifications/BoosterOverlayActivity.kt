package app.tatani.android.notifications

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import app.tatani.android.MainActivity
import app.tatani.android.TataniApp
import app.tatani.android.data.local.WordCardEntity
import app.tatani.android.domain.SrsEngine
import app.tatani.android.ui.JapaneseTtsManager
import app.tatani.android.ui.theme.AmberAccent
import app.tatani.android.ui.theme.CrimsonAgain
import app.tatani.android.ui.theme.JadeSuccess
import app.tatani.android.ui.theme.SumiBackground
import app.tatani.android.ui.theme.SumiBorder
import app.tatani.android.ui.theme.SumiElevated
import app.tatani.android.ui.theme.SumiSurface
import app.tatani.android.ui.theme.TataniTheme
import app.tatani.android.ui.theme.VermilionPrimary
import app.tatani.android.ui.theme.WashiForeground
import app.tatani.android.ui.theme.WashiMuted
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Top-pinned translucent flashcard banner launched directly from notification actions so the
 * revealed answer, reading peek, and chained due cards remain visible for as long as the user
 * wants—bypassing Android SystemUI's hardcoded 5-second Heads-Up auto-dismiss decay without
 * pulling MainActivity over the user's current foreground app.
 */
class BoosterOverlayActivity : ComponentActivity() {

    internal data class OverlayUiState(
        val word: String,
        val reading: String?,
        val meaning: String,
        val sentenceJp: String,
        val sentenceEn: String,
        val sourceCaption: String,
        val lang: String,
        val isDemo: Boolean,
        val cardSnapshotBeforeGrade: WordCardEntity?,
        val showReadingInPrompt: Boolean,
        val knowIntervalLabel: String,
        val againIntervalLabel: String,
        val isRevealed: Boolean,
        val remembered: Boolean,
        val appliedIntervalLabel: String,
        val remainingDueCount: Int,
    )

    private var uiState by mutableStateOf<OverlayUiState?>(null)
    private lateinit var tts: JapaneseTtsManager

    override fun onCreate(savedInstanceState: Bundle?) {
        suppressWindowTransition()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
        }
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        tts = JapaneseTtsManager(applicationContext)

        BoosterActionReceiver.dismissActiveNotification(this)
        handleActionIntent(intent)

        setContent {
            TataniTheme {
                val current = uiState
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                        ) {
                            dismissImmediately()
                        },
                    contentAlignment = Alignment.TopCenter,
                ) {
                    if (current != null) {
                        BoosterBannerCard(
                            state = current,
                            onSpeak = {
                                tts.speak(current.reading ?: current.word, current.lang)
                            },
                            onPeekReading = {
                                uiState = current.copy(showReadingInPrompt = true)
                            },
                            onGradeFromPrompt = { remembered ->
                                gradeFromPrompt(current, remembered)
                            },
                            onUndoToMiss = {
                                undoToMiss(current)
                            },
                            onNextDueCard = {
                                loadNextDueCard(current.lang, excludeWord = current.word)
                            },
                            onOpenSprint = {
                                val openIntent = Intent(
                                    Intent.ACTION_VIEW,
                                    Uri.parse("tatani://sprint"),
                                    this@BoosterOverlayActivity,
                                    MainActivity::class.java,
                                ).apply {
                                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                                        Intent.FLAG_ACTIVITY_CLEAR_TOP
                                }
                                startActivity(openIntent)
                                dismissImmediately()
                            },
                            onDismiss = ::dismissImmediately,
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        BoosterActionReceiver.dismissActiveNotification(this)
        handleActionIntent(intent)
    }

    override fun finish() {
        super.finish()
        suppressWindowTransition()
    }

    override fun onDestroy() {
        if (::tts.isInitialized) {
            tts.shutdown()
        }
        super.onDestroy()
    }

    private fun dismissImmediately() {
        finish()
        suppressWindowTransition()
    }

    private fun suppressWindowTransition() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            overrideActivityTransition(OVERRIDE_TRANSITION_OPEN, 0, 0)
            overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        } else {
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }

    private fun handleActionIntent(intent: Intent?) {
        if (intent == null) {
            dismissImmediately()
            return
        }
        val action = intent.action.orEmpty()
        val word = intent.getStringExtra(BoosterActionReceiver.EXTRA_WORD)
        if (word.isNullOrBlank()) {
            dismissImmediately()
            return
        }
        val lang = intent.getStringExtra(BoosterActionReceiver.EXTRA_LANG) ?: "ja"
        val isDemo = intent.getBooleanExtra(BoosterActionReceiver.EXTRA_IS_DEMO, false)

        if (isDemo) {
            val reading = intent.getStringExtra(BoosterActionReceiver.EXTRA_DEMO_READING)
            val meaning = intent.getStringExtra(BoosterActionReceiver.EXTRA_DEMO_MEANING).orEmpty()
            val sentenceJp = intent.getStringExtra(BoosterActionReceiver.EXTRA_DEMO_JP).orEmpty()
            val sentenceEn = intent.getStringExtra(BoosterActionReceiver.EXTRA_DEMO_EN).orEmpty()
            val isReveal = action == BoosterActionReceiver.ACTION_GRADE_KNOW ||
                action == BoosterActionReceiver.ACTION_GRADE_AGAIN
            val remembered = action == BoosterActionReceiver.ACTION_GRADE_KNOW
            val forcePeek = action == BoosterActionReceiver.ACTION_PEEK_READING

            uiState = OverlayUiState(
                word = word,
                reading = reading,
                meaning = meaning,
                sentenceJp = sentenceJp,
                sentenceEn = sentenceEn,
                sourceCaption = "Sample SRS preview",
                lang = lang,
                isDemo = true,
                cardSnapshotBeforeGrade = null,
                showReadingInPrompt = forcePeek,
                knowIntervalLabel = "1d",
                againIntervalLabel = "${SrsEngine.INITIAL_CONSOLIDATION_HOURS}h",
                isRevealed = isReveal,
                remembered = remembered,
                appliedIntervalLabel = if (remembered) "1d" else "${SrsEngine.INITIAL_CONSOLIDATION_HOURS}h",
                remainingDueCount = 0,
            )
            return
        }

        val app = applicationContext as TataniApp
        lifecycleScope.launch {
            val loaded = withContext(Dispatchers.IO) {
                val dao = app.database.dao()
                val card = dao.getWordCard(word, lang) ?: return@withContext null
                val now = System.currentTimeMillis()
                val contexts = app.repository.decodeContexts(card)
                val ctx = SrsEngine.pickContextualSentence(contexts, card.srsLevel)
                val sourceCaption = when {
                    ctx != null && ctx.animeTitle.isNotBlank() && ctx.episodeNumber > 0 ->
                        "${ctx.animeTitle} · Ep ${ctx.episodeNumber}"
                    card.animeTitle.isNotBlank() && card.episodeNumber > 0 ->
                        "${card.animeTitle} · Ep ${card.episodeNumber}"
                    else -> ""
                }
                val knowLabel = SrsEngine.nextIntervalLabel(card.toSrsSnapshot(), true, now)
                val againLabel = SrsEngine.nextIntervalLabel(card.toSrsSnapshot(), false, now)

                val isGradeAction = action == BoosterActionReceiver.ACTION_GRADE_KNOW ||
                    action == BoosterActionReceiver.ACTION_GRADE_AGAIN
                val remembered = action == BoosterActionReceiver.ACTION_GRADE_KNOW

                if (isGradeAction) {
                    persistGradeSafely(app, card, remembered, now)
                }

                val remainingDue = dao.getDeckCardsSnapshot(lang).count {
                    it.word != word && SrsEngine.isDueForSprint(
                        preference = it.preference,
                        knownSource = it.knownSource,
                        srsDueAtEpochMs = it.srsDueAtEpochMs,
                        nowMs = now,
                    )
                }

                val defaultShowReading = SrsEngine.shouldShowReadingUpfront(
                    word = card.word,
                    reading = card.reading,
                    state = card.state,
                    srsLevel = card.srsLevel,
                    correctStreak = card.correctStreak,
                    preference = card.preference,
                )

                OverlayUiState(
                    word = card.word,
                    reading = card.reading,
                    meaning = card.meaning,
                    sentenceJp = ctx?.jp.orEmpty(),
                    sentenceEn = ctx?.en.orEmpty(),
                    sourceCaption = sourceCaption,
                    lang = lang,
                    isDemo = false,
                    cardSnapshotBeforeGrade = card,
                    showReadingInPrompt = defaultShowReading || action == BoosterActionReceiver.ACTION_PEEK_READING,
                    knowIntervalLabel = knowLabel,
                    againIntervalLabel = againLabel,
                    isRevealed = isGradeAction,
                    remembered = remembered,
                    appliedIntervalLabel = if (remembered) knowLabel else againLabel,
                    remainingDueCount = remainingDue,
                )
            }

            if (loaded == null) {
                dismissImmediately()
            } else {
                uiState = loaded
            }
        }
    }

    private fun gradeFromPrompt(current: OverlayUiState, remembered: Boolean) {
        val appliedLabel = if (remembered) current.knowIntervalLabel else current.againIntervalLabel
        uiState = current.copy(
            isRevealed = true,
            remembered = remembered,
            appliedIntervalLabel = appliedLabel,
        )
        if (!current.isDemo && current.cardSnapshotBeforeGrade != null) {
            val app = applicationContext as TataniApp
            val card = current.cardSnapshotBeforeGrade
            persistScope.launch {
                val now = System.currentTimeMillis()
                persistGradeSafely(app, card, remembered, now)
            }
        }
    }

    private fun undoToMiss(current: OverlayUiState) {
        uiState = current.copy(
            isRevealed = true,
            remembered = false,
            appliedIntervalLabel = current.againIntervalLabel,
        )
        if (!current.isDemo && current.cardSnapshotBeforeGrade != null) {
            val app = applicationContext as TataniApp
            val baseCard = current.cardSnapshotBeforeGrade
            persistScope.launch {
                val now = System.currentTimeMillis()
                persistGradeSafely(app, baseCard, remembered = false, nowMs = now)
            }
        }
    }

    private fun loadNextDueCard(lang: String, excludeWord: String) {
        val app = applicationContext as TataniApp
        lifecycleScope.launch {
            val nextState = withContext(Dispatchers.IO) {
                val dao = app.database.dao()
                val now = System.currentTimeMillis()
                val dueCards = dao.getDeckCardsSnapshot(lang).filter {
                    it.word != excludeWord && SrsEngine.isDueForSprint(
                        preference = it.preference,
                        knownSource = it.knownSource,
                        srsDueAtEpochMs = it.srsDueAtEpochMs,
                        nowMs = now,
                    )
                }
                val card = dueCards.randomOrNull() ?: return@withContext null
                val contexts = app.repository.decodeContexts(card)
                val ctx = SrsEngine.pickContextualSentence(contexts, card.srsLevel)
                val sourceCaption = when {
                    ctx != null && ctx.animeTitle.isNotBlank() && ctx.episodeNumber > 0 ->
                        "${ctx.animeTitle} · Ep ${ctx.episodeNumber}"
                    card.animeTitle.isNotBlank() && card.episodeNumber > 0 ->
                        "${card.animeTitle} · Ep ${card.episodeNumber}"
                    else -> ""
                }
                val knowLabel = SrsEngine.nextIntervalLabel(card.toSrsSnapshot(), true, now)
                val againLabel = SrsEngine.nextIntervalLabel(card.toSrsSnapshot(), false, now)
                val showReading = SrsEngine.shouldShowReadingUpfront(
                    word = card.word,
                    reading = card.reading,
                    state = card.state,
                    srsLevel = card.srsLevel,
                    correctStreak = card.correctStreak,
                    preference = card.preference,
                )

                OverlayUiState(
                    word = card.word,
                    reading = card.reading,
                    meaning = card.meaning,
                    sentenceJp = ctx?.jp.orEmpty(),
                    sentenceEn = ctx?.en.orEmpty(),
                    sourceCaption = sourceCaption,
                    lang = lang,
                    isDemo = false,
                    cardSnapshotBeforeGrade = card,
                    showReadingInPrompt = showReading,
                    knowIntervalLabel = knowLabel,
                    againIntervalLabel = againLabel,
                    isRevealed = false,
                    remembered = false,
                    appliedIntervalLabel = knowLabel,
                    remainingDueCount = (dueCards.size - 1).coerceAtLeast(0),
                )
            }

            if (nextState == null) {
                dismissImmediately()
            } else {
                uiState = nextState
            }
        }
    }

    companion object {
        private val persistScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        private suspend fun persistGradeSafely(
            app: TataniApp,
            card: WordCardEntity,
            remembered: Boolean,
            nowMs: Long,
        ) {
            app.repository.gradeCardOptimistic(card, remembered, nowMs = nowMs, autoFlush = false)
            persistScope.launch {
                val flushed = withTimeoutOrNull(7_500L) {
                    app.repository.flushOutbox()
                } ?: false
                if (!flushed) {
                    OutboxSyncWorker.enqueue(app)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BoosterBannerCard(
    state: BoosterOverlayActivity.OverlayUiState,
    onSpeak: () -> Unit,
    onPeekReading: () -> Unit,
    onGradeFromPrompt: (Boolean) -> Unit,
    onUndoToMiss: () -> Unit,
    onNextDueCard: () -> Unit,
    onOpenSprint: () -> Unit,
    onDismiss: () -> Unit,
) {
    val hasDistinctReading = !state.reading.isNullOrBlank() && state.reading != state.word

    Surface(
        modifier = Modifier
            .statusBarsPadding()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .fillMaxWidth()
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { /* Consume taps inside banner so only outside backdrop taps dismiss */ }
            .pointerInput(Unit) {
                var cumulativeDragY = 0f
                detectVerticalDragGestures(
                    onDragStart = { cumulativeDragY = 0f },
                    onVerticalDrag = { _, dragAmount ->
                        cumulativeDragY += dragAmount
                        if (cumulativeDragY < -96f) {
                            onDismiss()
                        }
                    },
                )
            },
        shape = RoundedCornerShape(22.dp),
        color = SumiSurface,
        border = BorderStroke(
            width = 1.dp,
            color = when {
                !state.isRevealed -> SumiBorder
                state.remembered -> JadeSuccess.copy(alpha = 0.55f)
                else -> AmberAccent.copy(alpha = 0.55f)
            },
        ),
        shadowElevation = 18.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp, vertical = 14.dp),
        ) {
            // Top Header Pill + Audio + Close
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val badgeBg = when {
                    !state.isRevealed -> SumiElevated
                    state.remembered -> JadeSuccess.copy(alpha = 0.18f)
                    else -> AmberAccent.copy(alpha = 0.18f)
                }
                val badgeFg = when {
                    !state.isRevealed -> WashiMuted
                    state.remembered -> JadeSuccess
                    else -> AmberAccent
                }
                val badgeText = when {
                    !state.isRevealed && state.isDemo -> "SAMPLE SRS CARD"
                    !state.isRevealed -> "SRS SELF-CHECK"
                    state.remembered -> "✓ Remembered · Next in ${state.appliedIntervalLabel}"
                    else -> "↻ Review in ${state.appliedIntervalLabel}"
                }

                Surface(
                    shape = RoundedCornerShape(999.dp),
                    color = badgeBg,
                ) {
                    Text(
                        text = badgeText,
                        color = badgeFg,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                }

                Spacer(modifier = Modifier.weight(1f))

                IconButton(
                    onClick = onSpeak,
                    modifier = Modifier
                        .size(34.dp)
                        .background(SumiElevated, CircleShape),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.VolumeUp,
                        contentDescription = "Play Japanese pronunciation",
                        tint = WashiForeground,
                        modifier = Modifier.size(18.dp),
                    )
                }

                Spacer(modifier = Modifier.width(6.dp))

                IconButton(
                    onClick = onDismiss,
                    modifier = Modifier
                        .size(34.dp)
                        .background(SumiElevated, CircleShape),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = "Close card",
                        tint = WashiMuted,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            // Word + Reading + Peek chip
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = state.word,
                    color = WashiForeground,
                    fontSize = 28.sp,
                    lineHeight = 34.sp,
                    fontWeight = FontWeight.Bold,
                )

                if (hasDistinctReading && (state.isRevealed || state.showReadingInPrompt)) {
                    Text(
                        text = state.reading.orEmpty(),
                        color = AmberAccent,
                        fontSize = 18.sp,
                        lineHeight = 34.sp,
                        fontWeight = FontWeight.Medium,
                    )
                } else if (hasDistinctReading && !state.isRevealed) {
                    OutlinedButton(
                        onClick = onPeekReading,
                        shape = RoundedCornerShape(999.dp),
                        border = BorderStroke(1.dp, SumiBorder),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                        modifier = Modifier.height(32.dp),
                    ) {
                        Text(
                            text = "かな Peek",
                            color = AmberAccent,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }

            if (state.isRevealed) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = state.meaning,
                    color = if (state.remembered) JadeSuccess else WashiForeground,
                    fontSize = 20.sp,
                    lineHeight = 26.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }

            if (state.sentenceJp.isNotBlank() || (state.isRevealed && state.sentenceEn.isNotBlank())) {
                Spacer(modifier = Modifier.height(10.dp))
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = SumiBackground,
                    border = BorderStroke(1.dp, SumiBorder),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                        if (state.sentenceJp.isNotBlank()) {
                            Text(
                                text = state.sentenceJp,
                                color = WashiForeground,
                                fontSize = 15.sp,
                                lineHeight = 22.sp,
                            )
                        }
                        if (state.isRevealed && state.sentenceEn.isNotBlank()) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = state.sentenceEn,
                                color = WashiMuted,
                                fontSize = 13.sp,
                                lineHeight = 19.sp,
                            )
                        }
                        if (state.sourceCaption.isNotBlank()) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = state.sourceCaption,
                                color = WashiMuted.copy(alpha = 0.72f),
                                fontSize = 11.sp,
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            // Bottom Action Row
            if (!state.isRevealed) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedButton(
                        onClick = { onGradeFromPrompt(false) },
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(14.dp),
                        border = BorderStroke(1.dp, CrimsonAgain.copy(alpha = 0.6f)),
                        contentPadding = PaddingValues(vertical = 11.dp),
                    ) {
                        Text(
                            text = "I don't know (${state.againIntervalLabel})",
                            color = CrimsonAgain,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }

                    Button(
                        onClick = { onGradeFromPrompt(true) },
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = JadeSuccess,
                            contentColor = Color.White,
                        ),
                        contentPadding = PaddingValues(vertical = 11.dp),
                    ) {
                        Text(
                            text = "I know (${state.knowIntervalLabel})",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }

                if (!state.isDemo) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                    ) {
                        TextButton(
                            onClick = onOpenSprint,
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                        ) {
                            Text(
                                text = "Open full Sprint →",
                                color = WashiMuted,
                                fontSize = 12.sp,
                            )
                        }
                    }
                }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (state.remembered) {
                        OutlinedButton(
                            onClick = onUndoToMiss,
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(1.dp, CrimsonAgain.copy(alpha = 0.55f)),
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                        ) {
                            Text(
                                text = "Oops, missed",
                                color = CrimsonAgain,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }

                    Spacer(modifier = Modifier.weight(1f))

                    if (state.remainingDueCount > 0) {
                        OutlinedButton(
                            onClick = onNextDueCard,
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(1.dp, VermilionPrimary.copy(alpha = 0.7f)),
                            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                        ) {
                            Text(
                                text = "Next (${state.remainingDueCount})",
                                color = VermilionPrimary,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }

                    Button(
                        onClick = onDismiss,
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (state.remainingDueCount > 0) SumiElevated else JadeSuccess,
                            contentColor = if (state.remainingDueCount > 0) WashiForeground else Color.White,
                        ),
                        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 10.dp),
                    ) {
                        Text(
                            text = "Done",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
        }
    }
}
