package app.tatani.android.notifications

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
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
 * Top-pinned translucent micro-sprint banner launched from notification actions.
 *
 * Uses the notification as a 1-tap hook ("foot-in-the-door") and turns the floating top banner
 * into an effortless micro-session: pre-loading due SRS cards, spacing re-checks for missed
 * cards, and offering ahead-of-schedule bonus cards or Learn entry once due reviews are cleared.
 */
class BoosterOverlayActivity : ComponentActivity() {

    internal enum class NextStepKind {
        DUE_CARD,
        MISSED_RECHECK,
        BONUS_CARD,
        DEMO_SAMPLE,
        START_LEARN,
        NONE,
    }

    internal data class CardPromptPayload(
        val word: String,
        val reading: String?,
        val meaning: String,
        val sentenceJp: String,
        val sentenceEn: String,
        val sourceCaption: String,
        val lang: String,
        val isDemo: Boolean,
        val isMissedRecheck: Boolean,
        val cardEntity: WordCardEntity?,
        val showReadingUpfront: Boolean,
        val knowIntervalLabel: String,
        val againIntervalLabel: String,
    )

    internal data class OverlayUiState(
        val card: CardPromptPayload,
        val showReadingInPrompt: Boolean,
        val isRevealed: Boolean,
        val remembered: Boolean,
        val appliedIntervalLabel: String,
        val sessionReviewedCount: Int,
        val justClearedAllDue: Boolean,
        val nextStepKind: NextStepKind,
        val remainingDueCount: Int,
        val unlearnedAvailableCount: Int,
        val preloadedNext: CardPromptPayload?,
    )

    private data class MissedEntry(
        val word: String,
        val missedAtTurn: Int,
    )

    private var uiState by mutableStateOf<OverlayUiState?>(null)
    private lateinit var tts: JapaneseTtsManager

    // Session state across chained cards in the current overlay streak
    private val reviewedWordsThisStreak = LinkedHashSet<String>()
    private val missedQueue = LinkedHashMap<String, MissedEntry>()
    private var turnCounter = 0
    private var startedWithDueCards = false
    private var announcedAllDueCleared = false

    override fun onCreate(savedInstanceState: Bundle?) {
        suppressWindowTransition()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
        }
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        tts = JapaneseTtsManager(applicationContext)

        BoosterActionReceiver.dismissActiveNotification(this)
        handleIncomingIntent(intent, resetSession = true)

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
                                tts.speak(
                                    current.card.reading ?: current.card.word,
                                    current.card.lang,
                                )
                            },
                            onPeekReading = {
                                uiState = current.copy(showReadingInPrompt = true)
                            },
                            onGradeFromPrompt = { remembered ->
                                gradePromptCard(current, remembered)
                            },
                            onUndoToMiss = {
                                undoCurrentToMiss(current)
                            },
                            onAdvanceNext = {
                                advanceToNext(current)
                            },
                            onOpenSprint = {
                                openDeepLink("tatani://sprint")
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
        handleIncomingIntent(intent, resetSession = true)
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

    private fun openDeepLink(uriString: String) {
        val openIntent = Intent(
            Intent.ACTION_VIEW,
            Uri.parse(uriString),
            this,
            MainActivity::class.java,
        ).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        startActivity(openIntent)
        dismissImmediately()
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

    private fun handleIncomingIntent(intent: Intent?, resetSession: Boolean) {
        if (intent == null) {
            dismissImmediately()
            return
        }
        if (resetSession) {
            reviewedWordsThisStreak.clear()
            missedQueue.clear()
            turnCounter = 0
            startedWithDueCards = false
            announcedAllDueCleared = false
        }

        val action = intent.action.orEmpty()
        val word = intent.getStringExtra(BoosterActionReceiver.EXTRA_WORD)
        if (word.isNullOrBlank()) {
            dismissImmediately()
            return
        }
        val lang = intent.getStringExtra(BoosterActionReceiver.EXTRA_LANG) ?: "ja"
        val isDemo = intent.getBooleanExtra(BoosterActionReceiver.EXTRA_IS_DEMO, false)
        val isGradeAction = action == BoosterActionReceiver.ACTION_GRADE_KNOW ||
            action == BoosterActionReceiver.ACTION_GRADE_AGAIN
        val remembered = action == BoosterActionReceiver.ACTION_GRADE_KNOW
        val forcePeek = action == BoosterActionReceiver.ACTION_PEEK_READING

        val app = applicationContext as TataniApp

        if (isDemo) {
            val initialPayload = CardPromptPayload(
                word = word,
                reading = intent.getStringExtra(BoosterActionReceiver.EXTRA_DEMO_READING),
                meaning = intent.getStringExtra(BoosterActionReceiver.EXTRA_DEMO_MEANING).orEmpty(),
                sentenceJp = intent.getStringExtra(BoosterActionReceiver.EXTRA_DEMO_JP).orEmpty(),
                sentenceEn = intent.getStringExtra(BoosterActionReceiver.EXTRA_DEMO_EN).orEmpty(),
                sourceCaption = "Sample SRS preview",
                lang = lang,
                isDemo = true,
                isMissedRecheck = false,
                cardEntity = null,
                showReadingUpfront = forcePeek,
                knowIntervalLabel = "1d",
                againIntervalLabel = "${SrsEngine.INITIAL_CONSOLIDATION_HOURS}h",
            )
            if (isGradeAction) {
                recordTurnOutcome(word, remembered)
            }
            val nextDemo = pickNextDemoPayload(excludeWord = word, lang = lang)
            uiState = OverlayUiState(
                card = initialPayload,
                showReadingInPrompt = forcePeek,
                isRevealed = isGradeAction,
                remembered = remembered,
                appliedIntervalLabel = if (remembered) {
                    initialPayload.knowIntervalLabel
                } else {
                    initialPayload.againIntervalLabel
                },
                sessionReviewedCount = reviewedWordsThisStreak.size,
                justClearedAllDue = false,
                nextStepKind = if (nextDemo != null) NextStepKind.DEMO_SAMPLE else NextStepKind.NONE,
                remainingDueCount = 0,
                unlearnedAvailableCount = 0,
                preloadedNext = nextDemo,
            )
            return
        }

        lifecycleScope.launch {
            val built = withContext(Dispatchers.IO) {
                val dao = app.database.dao()
                val card = dao.getWordCard(word, lang) ?: return@withContext null
                val now = System.currentTimeMillis()
                val wasInitiallyDue = SrsEngine.isDueForSprint(
                    preference = card.preference,
                    knownSource = card.knownSource,
                    srsDueAtEpochMs = card.srsDueAtEpochMs,
                    nowMs = now,
                )
                if (wasInitiallyDue) {
                    startedWithDueCards = true
                }

                val payload = buildPayloadFromEntity(app, card, now, isMissedRecheck = false)

                if (isGradeAction) {
                    persistGradeSafely(app, card, remembered, now)
                    recordTurnOutcome(card.word, remembered)
                }

                computeNextStepState(
                    app = app,
                    lang = lang,
                    currentPayload = payload,
                    showReadingInPrompt = payload.showReadingUpfront || forcePeek,
                    isRevealed = isGradeAction,
                    remembered = remembered,
                    appliedIntervalLabel = if (remembered) {
                        payload.knowIntervalLabel
                    } else {
                        payload.againIntervalLabel
                    },
                )
            }

            if (built == null) {
                dismissImmediately()
            } else {
                uiState = built
            }
        }
    }

    private fun gradePromptCard(current: OverlayUiState, remembered: Boolean) {
        val card = current.card
        val appliedLabel = if (remembered) card.knowIntervalLabel else card.againIntervalLabel
        recordTurnOutcome(card.word, remembered)

        if (card.isDemo) {
            val nextDemo = pickNextDemoPayload(excludeWord = card.word, lang = card.lang)
            uiState = current.copy(
                isRevealed = true,
                remembered = remembered,
                appliedIntervalLabel = appliedLabel,
                sessionReviewedCount = reviewedWordsThisStreak.size,
                nextStepKind = if (nextDemo != null) NextStepKind.DEMO_SAMPLE else NextStepKind.NONE,
                preloadedNext = nextDemo,
            )
            return
        }

        // Instant optimistic reveal on the UI thread, then compute exact remaining queue on IO
        uiState = current.copy(
            isRevealed = true,
            remembered = remembered,
            appliedIntervalLabel = appliedLabel,
            sessionReviewedCount = reviewedWordsThisStreak.size,
        )

        val app = applicationContext as TataniApp
        val entity = card.cardEntity ?: return
        lifecycleScope.launch {
            val refreshed = withContext(Dispatchers.IO) {
                val now = System.currentTimeMillis()
                persistGradeSafely(app, entity, remembered, now)
                computeNextStepState(
                    app = app,
                    lang = card.lang,
                    currentPayload = card,
                    showReadingInPrompt = current.showReadingInPrompt,
                    isRevealed = true,
                    remembered = remembered,
                    appliedIntervalLabel = appliedLabel,
                )
            }
            uiState = refreshed
        }
    }

    private fun undoCurrentToMiss(current: OverlayUiState) {
        val card = current.card
        missedQueue[card.word] = MissedEntry(word = card.word, missedAtTurn = turnCounter)

        if (card.isDemo) {
            uiState = current.copy(
                isRevealed = true,
                remembered = false,
                appliedIntervalLabel = card.againIntervalLabel,
            )
            return
        }

        uiState = current.copy(
            isRevealed = true,
            remembered = false,
            appliedIntervalLabel = card.againIntervalLabel,
        )

        val app = applicationContext as TataniApp
        val entity = card.cardEntity ?: return
        lifecycleScope.launch {
            val refreshed = withContext(Dispatchers.IO) {
                val now = System.currentTimeMillis()
                persistGradeSafely(app, entity, remembered = false, nowMs = now)
                computeNextStepState(
                    app = app,
                    lang = card.lang,
                    currentPayload = card,
                    showReadingInPrompt = current.showReadingInPrompt,
                    isRevealed = true,
                    remembered = false,
                    appliedIntervalLabel = card.againIntervalLabel,
                )
            }
            uiState = refreshed
        }
    }

    private fun advanceToNext(current: OverlayUiState) {
        if (current.nextStepKind == NextStepKind.START_LEARN) {
            openDeepLink("tatani://learn")
            return
        }

        val preloaded = current.preloadedNext
        if (preloaded != null) {
            // 0ms instant transition using preloaded card!
            uiState = OverlayUiState(
                card = preloaded,
                showReadingInPrompt = preloaded.showReadingUpfront,
                isRevealed = false,
                remembered = false,
                appliedIntervalLabel = preloaded.knowIntervalLabel,
                sessionReviewedCount = reviewedWordsThisStreak.size,
                justClearedAllDue = false,
                nextStepKind = NextStepKind.NONE,
                remainingDueCount = (current.remainingDueCount - if (current.nextStepKind == NextStepKind.DUE_CARD) 1 else 0)
                    .coerceAtLeast(0),
                unlearnedAvailableCount = current.unlearnedAvailableCount,
                preloadedNext = null,
            )
            return
        }

        dismissImmediately()
    }

    @Synchronized
    private fun recordTurnOutcome(word: String, remembered: Boolean) {
        turnCounter += 1
        reviewedWordsThisStreak.add(word)
        if (remembered) {
            missedQueue.remove(word)
        } else {
            missedQueue[word] = MissedEntry(word = word, missedAtTurn = turnCounter)
        }
    }

    private fun pickNextDemoPayload(excludeWord: String, lang: String): CardPromptPayload? {
        val nextSample = DEMO_SAMPLES.firstOrNull {
            it.first != excludeWord && it.first !in reviewedWordsThisStreak
        } ?: DEMO_SAMPLES.firstOrNull { it.first != excludeWord && it.first in missedQueue }
            ?: return null

        return CardPromptPayload(
            word = nextSample.first,
            reading = nextSample.second,
            meaning = nextSample.third,
            sentenceJp = nextSample.fourth,
            sentenceEn = nextSample.fifth,
            sourceCaption = "Sample SRS preview",
            lang = lang,
            isDemo = true,
            isMissedRecheck = nextSample.first in missedQueue,
            cardEntity = null,
            showReadingUpfront = false,
            knowIntervalLabel = "1d",
            againIntervalLabel = "${SrsEngine.INITIAL_CONSOLIDATION_HOURS}h",
        )
    }

    private suspend fun computeNextStepState(
        app: TataniApp,
        lang: String,
        currentPayload: CardPromptPayload,
        showReadingInPrompt: Boolean,
        isRevealed: Boolean,
        remembered: Boolean,
        appliedIntervalLabel: String,
    ): OverlayUiState {
        val dao = app.database.dao()
        val now = System.currentTimeMillis()
        val allDeck = dao.getDeckCardsSnapshot(lang)

        // 1. Strictly due SRS cards not yet answered in this streak (fragile/most-overdue first)
        val unseenDue = allDeck
            .filter {
                it.word != currentPayload.word &&
                    it.word !in reviewedWordsThisStreak &&
                    SrsEngine.isDueForSprint(
                        preference = it.preference,
                        knownSource = it.knownSource,
                        srsDueAtEpochMs = it.srsDueAtEpochMs,
                        nowMs = now,
                    )
            }
            .sortedWith(
                compareBy<WordCardEntity>(
                    { if (it.state == "learning") 0 else 1 },
                    { it.srsDueAtEpochMs ?: 0L },
                )
            )

        // 2. Missed cards from earlier in this streak ready for spaced retrieval (>= 2 turns ago)
        val spacedMissedReady = missedQueue.values
            .firstOrNull { it.word != currentPayload.word && (turnCounter - it.missedAtTurn) >= 2 }
            ?.let { entry -> allDeck.firstOrNull { it.word == entry.word } }

        // 3. Ahead-of-schedule graduated SRS cards (soonest due first) for bonus momentum
        val bonusGraduated = allDeck
            .filter {
                it.word != currentPayload.word &&
                    it.word !in reviewedWordsThisStreak &&
                    SrsEngine.isGraduatedForSrs(
                        preference = it.preference,
                        knownSource = it.knownSource,
                        srsDueAtEpochMs = it.srsDueAtEpochMs,
                    )
            }
            .sortedBy { it.srsDueAtEpochMs ?: Long.MAX_VALUE }

        // 4. Any remaining missed card (if no due or bonus spacer cards remain)
        val anyMissedFallback = missedQueue.values
            .firstOrNull { it.word != currentPayload.word }
            ?.let { entry -> allDeck.firstOrNull { it.word == entry.word } }

        // 5. Unlearned episode words waiting in Learn
        val userRank = SrsEngine.jlptRank(app.sessionStore.session.value?.userLevel)
        val unlearnedCount = allDeck.count { c ->
            val below = userRank in 1..50 && SrsEngine.jlptRank(c.level) < userRank
            SrsEngine.isUnlearnedCandidate(
                hasExistingState = c.hasServerState,
                state = c.state,
                preference = c.preference,
                knownSource = c.knownSource,
                srsDueAtEpochMs = c.srsDueAtEpochMs,
                isBelowUserLevel = below,
            ) && !c.primaryEpisodeId.isNullOrBlank()
        }

        val (nextKind, chosenEntity, isRecheck) = when {
            spacedMissedReady != null -> Triple(NextStepKind.MISSED_RECHECK, spacedMissedReady, true)
            unseenDue.isNotEmpty() -> Triple(NextStepKind.DUE_CARD, unseenDue.first(), false)
            bonusGraduated.isNotEmpty() -> Triple(NextStepKind.BONUS_CARD, bonusGraduated.first(), false)
            anyMissedFallback != null -> Triple(NextStepKind.MISSED_RECHECK, anyMissedFallback, true)
            unlearnedCount > 0 -> Triple(NextStepKind.START_LEARN, null, false)
            else -> Triple(NextStepKind.NONE, null, false)
        }

        val remainingDueTotal = unseenDue.size + missedQueue.keys.count { it != currentPayload.word || !remembered }
        val clearedDueNow = isRevealed &&
            startedWithDueCards &&
            !announcedAllDueCleared &&
            unseenDue.isEmpty() &&
            missedQueue.isEmpty()
        if (clearedDueNow) {
            announcedAllDueCleared = true
        }

        val preloaded = chosenEntity?.let {
            buildPayloadFromEntity(app, it, now, isMissedRecheck = isRecheck)
        }

        return OverlayUiState(
            card = currentPayload,
            showReadingInPrompt = showReadingInPrompt,
            isRevealed = isRevealed,
            remembered = remembered,
            appliedIntervalLabel = appliedIntervalLabel,
            sessionReviewedCount = reviewedWordsThisStreak.size,
            justClearedAllDue = clearedDueNow,
            nextStepKind = nextKind,
            remainingDueCount = unseenDue.size,
            unlearnedAvailableCount = unlearnedCount,
            preloadedNext = preloaded,
        )
    }

    private fun buildPayloadFromEntity(
        app: TataniApp,
        card: WordCardEntity,
        nowMs: Long,
        isMissedRecheck: Boolean,
    ): CardPromptPayload {
        val contexts = app.repository.decodeContexts(card)
        val ctx = SrsEngine.pickContextualSentence(contexts, card.srsLevel)
        val sourceCaption = when {
            ctx != null && ctx.animeTitle.isNotBlank() && ctx.episodeNumber > 0 ->
                "${ctx.animeTitle} · Ep ${ctx.episodeNumber}"
            card.animeTitle.isNotBlank() && card.episodeNumber > 0 ->
                "${card.animeTitle} · Ep ${card.episodeNumber}"
            else -> ""
        }
        val knowLabel = SrsEngine.nextIntervalLabel(card.toSrsSnapshot(), true, nowMs)
        val againLabel = SrsEngine.nextIntervalLabel(card.toSrsSnapshot(), false, nowMs)
        val defaultShowReading = !isMissedRecheck && SrsEngine.shouldShowReadingUpfront(
            word = card.word,
            reading = card.reading,
            state = card.state,
            srsLevel = card.srsLevel,
            correctStreak = card.correctStreak,
            preference = card.preference,
        )

        return CardPromptPayload(
            word = card.word,
            reading = card.reading,
            meaning = card.meaning,
            sentenceJp = ctx?.jp.orEmpty(),
            sentenceEn = ctx?.en.orEmpty(),
            sourceCaption = sourceCaption,
            lang = card.learningLanguage,
            isDemo = false,
            isMissedRecheck = isMissedRecheck,
            cardEntity = card,
            showReadingUpfront = defaultShowReading,
            knowIntervalLabel = knowLabel,
            againIntervalLabel = againLabel,
        )
    }

    private data class DemoTuple(
        val first: String,
        val second: String,
        val third: String,
        val fourth: String,
        val fifth: String,
    )

    companion object {
        private val persistScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        private val DEMO_SAMPLES = listOf(
            DemoTuple(
                "約束",
                "やくそく",
                "promise",
                "昔の約束を覚えているか。",
                "Do you remember our old promise?",
            ),
            DemoTuple(
                "仲間",
                "なかま",
                "companion, comrade",
                "大切な仲間を絶対に守る。",
                "I will definitely protect my precious comrades.",
            ),
            DemoTuple(
                "秘密",
                "ひみつ",
                "secret",
                "これは二人だけの秘密だよ。",
                "This is a secret just between the two of us.",
            ),
            DemoTuple(
                "世界",
                "せかい",
                "world",
                "まだ見ぬ世界へ踏み出そう。",
                "Let's step out into a world we haven't seen yet.",
            ),
        )

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
    onAdvanceNext: () -> Unit,
    onOpenSprint: () -> Unit,
    onDismiss: () -> Unit,
) {
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
        AnimatedContent(
            targetState = state,
            contentKey = { "${it.card.word}_${it.isRevealed}_${it.remembered}_${it.showReadingInPrompt}" },
            transitionSpec = {
                fadeIn(tween(130)) togetherWith fadeOut(tween(90))
            },
            label = "booster_card_transition",
        ) { s ->
            val card = s.card
            val hasDistinctReading = !card.reading.isNullOrBlank() && card.reading != card.word

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp, vertical = 14.dp),
            ) {
                // Top Header Pill + Streak Counter + Audio + Close
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    val badgeBg = when {
                        !s.isRevealed && card.isMissedRecheck -> AmberAccent.copy(alpha = 0.18f)
                        !s.isRevealed -> SumiElevated
                        s.remembered -> JadeSuccess.copy(alpha = 0.18f)
                        else -> AmberAccent.copy(alpha = 0.18f)
                    }
                    val badgeFg = when {
                        !s.isRevealed && card.isMissedRecheck -> AmberAccent
                        !s.isRevealed -> WashiMuted
                        s.remembered -> JadeSuccess
                        else -> AmberAccent
                    }
                    val badgeText = when {
                        !s.isRevealed && card.isDemo -> "SAMPLE SRS CARD"
                        !s.isRevealed && card.isMissedRecheck -> "↻ QUICK RE-CHECK"
                        !s.isRevealed && s.remainingDueCount > 0 -> "SRS · ${s.remainingDueCount + 1} DUE"
                        !s.isRevealed -> "BONUS REVIEW"
                        s.remembered -> "✓ Next in ${s.appliedIntervalLabel}"
                        else -> "↻ Review in ${s.appliedIntervalLabel}"
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

                    if (s.sessionReviewedCount >= 2) {
                        Surface(
                            shape = RoundedCornerShape(999.dp),
                            color = VermilionPrimary.copy(alpha = 0.16f),
                        ) {
                            Text(
                                text = "⚡ ${s.sessionReviewedCount} reviewed",
                                color = VermilionPrimary,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            )
                        }
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

                if (s.justClearedAllDue) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "🎉 All due cards cleared! Keep the streak rolling or tap outside when done.",
                        color = JadeSuccess,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }

                Spacer(modifier = Modifier.height(10.dp))

                // Word + Reading + Peek chip
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        text = card.word,
                        color = WashiForeground,
                        fontSize = 28.sp,
                        lineHeight = 34.sp,
                        fontWeight = FontWeight.Bold,
                    )

                    if (hasDistinctReading && (s.isRevealed || s.showReadingInPrompt)) {
                        Text(
                            text = card.reading.orEmpty(),
                            color = AmberAccent,
                            fontSize = 18.sp,
                            lineHeight = 34.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    } else if (hasDistinctReading && !s.isRevealed) {
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

                if (s.isRevealed) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = card.meaning,
                        color = if (s.remembered) JadeSuccess else WashiForeground,
                        fontSize = 20.sp,
                        lineHeight = 26.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }

                if (card.sentenceJp.isNotBlank() || (s.isRevealed && card.sentenceEn.isNotBlank())) {
                    Spacer(modifier = Modifier.height(10.dp))
                    Surface(
                        shape = RoundedCornerShape(14.dp),
                        color = SumiBackground,
                        border = BorderStroke(1.dp, SumiBorder),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                            if (card.sentenceJp.isNotBlank()) {
                                Text(
                                    text = card.sentenceJp,
                                    color = WashiForeground,
                                    fontSize = 15.sp,
                                    lineHeight = 22.sp,
                                )
                            }
                            if (s.isRevealed && card.sentenceEn.isNotBlank()) {
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = card.sentenceEn,
                                    color = WashiMuted,
                                    fontSize = 13.sp,
                                    lineHeight = 19.sp,
                                )
                            }
                            if (card.sourceCaption.isNotBlank()) {
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = card.sourceCaption,
                                    color = WashiMuted.copy(alpha = 0.72f),
                                    fontSize = 11.sp,
                                )
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Bottom Action Row: Designed to keep momentum rolling!
                if (!s.isRevealed) {
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
                                text = "I don't know (${card.againIntervalLabel})",
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
                                text = "I know (${card.knowIntervalLabel})",
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }

                    if (!card.isDemo) {
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
                    val primaryNextLabel = when (s.nextStepKind) {
                        BoosterOverlayActivity.NextStepKind.DUE_CARD ->
                            "Next card (${s.remainingDueCount} due) →"
                        BoosterOverlayActivity.NextStepKind.MISSED_RECHECK ->
                            "Re-check missed →"
                        BoosterOverlayActivity.NextStepKind.BONUS_CARD ->
                            "Bonus card →"
                        BoosterOverlayActivity.NextStepKind.DEMO_SAMPLE ->
                            "Next sample →"
                        BoosterOverlayActivity.NextStepKind.START_LEARN -> {
                            val batch = minOf(SrsEngine.LEARN_BATCH_SIZE, s.unlearnedAvailableCount)
                            "Learn +$batch new →"
                        }
                        BoosterOverlayActivity.NextStepKind.NONE -> null
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (s.remembered) {
                            OutlinedButton(
                                onClick = onUndoToMiss,
                                shape = RoundedCornerShape(12.dp),
                                border = BorderStroke(1.dp, CrimsonAgain.copy(alpha = 0.55f)),
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 11.dp),
                            ) {
                                Text(
                                    text = "Oops, missed",
                                    color = CrimsonAgain,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                        } else if (primaryNextLabel != null) {
                            TextButton(
                                onClick = onDismiss,
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 10.dp),
                            ) {
                                Text(
                                    text = "Done",
                                    color = WashiMuted,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Medium,
                                )
                            }
                        }

                        if (primaryNextLabel != null) {
                            val isDueUrgent =
                                s.nextStepKind == BoosterOverlayActivity.NextStepKind.DUE_CARD ||
                                    s.nextStepKind == BoosterOverlayActivity.NextStepKind.MISSED_RECHECK
                            Button(
                                onClick = onAdvanceNext,
                                modifier = Modifier.weight(1f),
                                shape = RoundedCornerShape(14.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = if (isDueUrgent) JadeSuccess else VermilionPrimary,
                                    contentColor = Color.White,
                                ),
                                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 11.dp),
                            ) {
                                Text(
                                    text = primaryNextLabel,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        } else {
                            Spacer(modifier = Modifier.weight(1f))
                            Button(
                                onClick = onDismiss,
                                shape = RoundedCornerShape(14.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = JadeSuccess,
                                    contentColor = Color.White,
                                ),
                                contentPadding = PaddingValues(horizontal = 22.dp, vertical = 11.dp),
                            ) {
                                Text(
                                    text = "All caught up ✓",
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
