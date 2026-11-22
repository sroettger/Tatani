package app.tatani.android.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tatani.android.MainActivity
import app.tatani.android.R
import app.tatani.android.TataniApp
import app.tatani.android.data.local.WordCardEntity
import app.tatani.android.domain.SrsEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class BoosterActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val app = context.applicationContext as TataniApp
                val dao = app.database.dao()
                val action = intent.action.orEmpty()
                val lang = intent.getStringExtra(EXTRA_LANG) ?: "ja"

                if (action == ACTION_NEXT_CARD) {
                    val now = System.currentTimeMillis()
                    val dueCards = dao.getDeckCardsSnapshot(lang).filter {
                        SrsEngine.isDueForSprint(
                            preference = it.preference,
                            knownSource = it.knownSource,
                            srsDueAtEpochMs = it.srsDueAtEpochMs,
                            nowMs = now,
                        )
                    }
                    val nextCard = dueCards.randomOrNull()
                    if (nextCard != null) {
                        val contexts = app.repository.decodeContexts(nextCard)
                        postCardPrompt(
                            context = context,
                            card = nextCard,
                            contexts = contexts,
                            forcePeekReading = false,
                            silentUpdate = false,
                        )
                    } else {
                        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
                    }
                    return@launch
                }

                val word = intent.getStringExtra(EXTRA_WORD) ?: return@launch
                val isDemo = intent.getBooleanExtra(EXTRA_IS_DEMO, false)

                if (action == ACTION_PEEK_READING) {
                    if (isDemo) {
                        postDemoPrompt(
                            context = context,
                            word = word,
                            reading = intent.getStringExtra(EXTRA_DEMO_READING),
                            meaning = intent.getStringExtra(EXTRA_DEMO_MEANING).orEmpty(),
                            sentenceJp = intent.getStringExtra(EXTRA_DEMO_JP).orEmpty(),
                            sentenceEn = intent.getStringExtra(EXTRA_DEMO_EN).orEmpty(),
                            lang = lang,
                            forcePeekReading = true,
                            silentUpdate = true,
                        )
                    } else {
                        val card = dao.getWordCard(word, lang) ?: return@launch
                        val contexts = app.repository.decodeContexts(card)
                        postCardPrompt(
                            context = context,
                            card = card,
                            contexts = contexts,
                            forcePeekReading = true,
                            silentUpdate = true,
                        )
                    }
                    return@launch
                }

                val remembered = when (action) {
                    ACTION_GRADE_KNOW -> true
                    ACTION_GRADE_AGAIN -> false
                    else -> intent.getBooleanExtra(EXTRA_REMEMBERED, false)
                }

                if (isDemo) {
                    if (canPostNotifications(context)) {
                        val reading = intent.getStringExtra(EXTRA_DEMO_READING)
                        val meaning = intent.getStringExtra(EXTRA_DEMO_MEANING).orEmpty()
                        val sentenceJp = intent.getStringExtra(EXTRA_DEMO_JP).orEmpty()
                        val sentenceEn = intent.getStringExtra(EXTRA_DEMO_EN).orEmpty()
                        val label = if (!reading.isNullOrBlank() && reading != word) "$word ($reading)" else word
                        val summaryLine = "$label — $meaning"
                        val bigText = buildString {
                            append(summaryLine)
                            if (sentenceJp.isNotBlank()) {
                                append("\n").append(sentenceJp)
                            }
                            if (sentenceEn.isNotBlank()) {
                                append("\n").append(sentenceEn)
                            }
                        }
                        val feedback = NotificationCompat.Builder(context, CHANNEL_ID)
                            .setSmallIcon(R.drawable.ic_stat_tatani)
                            .setContentTitle(
                                if (remembered) "✓ Correct · Sample SRS preview"
                                else "↻ Review again · Sample SRS preview"
                            )
                            .setContentText(summaryLine)
                            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
                            .setContentIntent(buildOpenSprintIntent(context, word.hashCode()))
                            .setSilent(true)
                            .setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .build()
                        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, feedback)
                    }
                    return@launch
                }

                val card = dao.getWordCard(word, lang) ?: return@launch
                val now = System.currentTimeMillis()
                val nextLabel = SrsEngine.nextIntervalLabel(card.toSrsSnapshot(), remembered, now)
                app.repository.gradeCardOptimistic(card, remembered, nowMs = now, autoFlush = false)

                val remainingDueCount = dao.getDeckCardsSnapshot(lang).count {
                    it.word != word && SrsEngine.isDueForSprint(
                        preference = it.preference,
                        knownSource = it.knownSource,
                        srsDueAtEpochMs = it.srsDueAtEpochMs,
                        nowMs = now,
                    )
                }

                if (canPostNotifications(context)) {
                    val label = if (!card.reading.isNullOrBlank() && card.reading != card.word) {
                        "${card.word} (${card.reading})"
                    } else {
                        card.word
                    }
                    val summaryLine = "$label — ${card.meaning}"
                    val contexts = app.repository.decodeContexts(card)
                    val ctx = SrsEngine.pickContextualSentence(contexts, card.srsLevel)
                    val bigText = buildString {
                        append(summaryLine)
                        if (ctx != null) {
                            append("\n").append(ctx.jp)
                            if (ctx.en.isNotBlank()) {
                                append("\n").append(ctx.en)
                            }
                        }
                    }

                    val feedbackBuilder = NotificationCompat.Builder(context, CHANNEL_ID)
                        .setSmallIcon(R.drawable.ic_stat_tatani)
                        .setContentTitle(
                            if (remembered) "✓ Correct · Next in $nextLabel"
                            else "↻ Review again · $nextLabel"
                        )
                        .setContentText(summaryLine)
                        .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
                        .setContentIntent(buildOpenSprintIntent(context, word.hashCode()))
                        .setSilent(true)
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)

                    if (remainingDueCount > 0) {
                        val nextIntent = Intent(context, BoosterActionReceiver::class.java).apply {
                            this.action = ACTION_NEXT_CARD
                            putExtra(EXTRA_LANG, lang)
                        }
                        val nextPending = PendingIntent.getBroadcast(
                            context,
                            204,
                            nextIntent,
                            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                        )
                        feedbackBuilder.addAction(0, "Next card ($remainingDueCount due)", nextPending)
                    }

                    NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, feedbackBuilder.build())
                }

                val flushed = withTimeoutOrNull(7_500L) {
                    app.repository.flushOutbox()
                } ?: false

                if (!flushed) {
                    OutboxSyncWorker.enqueue(context)
                }
            } finally {
                pendingResult.finish()
            }
        }
    }

    companion object {
        const val CHANNEL_ID = "tatani_srs_boosters"
        const val NOTIFICATION_ID = 4102
        const val ACTION_GRADE_KNOW = "app.tatani.android.ACTION_BOOSTER_KNOW"
        const val ACTION_GRADE_AGAIN = "app.tatani.android.ACTION_BOOSTER_AGAIN"
        const val ACTION_PEEK_READING = "app.tatani.android.ACTION_BOOSTER_PEEK"
        const val ACTION_NEXT_CARD = "app.tatani.android.ACTION_BOOSTER_NEXT"

        const val EXTRA_WORD = "extra_word"
        const val EXTRA_LANG = "extra_lang"
        const val EXTRA_REMEMBERED = "extra_remembered"
        const val EXTRA_IS_DEMO = "extra_is_demo"
        const val EXTRA_DEMO_READING = "extra_demo_reading"
        const val EXTRA_DEMO_MEANING = "extra_demo_meaning"
        const val EXTRA_DEMO_JP = "extra_demo_jp"
        const val EXTRA_DEMO_EN = "extra_demo_en"

        fun canPostNotifications(context: Context): Boolean {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                return false
            }
            return NotificationManagerCompat.from(context).areNotificationsEnabled()
        }

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "Graduated SRS Flashcard Boosters",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Contextual self-check flashcards for graduated SRS words"
                }
                nm.createNotificationChannel(channel)
            }
        }

        private fun buildOpenSprintIntent(context: Context, reqCode: Int): PendingIntent {
            val openIntent = Intent(
                Intent.ACTION_VIEW,
                Uri.parse("tatani://sprint"),
                context,
                MainActivity::class.java
            ).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            return PendingIntent.getActivity(
                context,
                reqCode,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        fun postCardPrompt(
            context: Context,
            card: WordCardEntity,
            contexts: List<SrsEngine.EpisodeContext>,
            forcePeekReading: Boolean = false,
            silentUpdate: Boolean = false,
        ): Boolean {
            if (!canPostNotifications(context)) return false
            ensureChannel(context)

            val hasDistinctReading = !card.reading.isNullOrBlank() && card.reading != card.word
            val showReading = forcePeekReading || SrsEngine.shouldShowReadingUpfront(
                word = card.word,
                reading = card.reading,
                state = card.state,
                srsLevel = card.srsLevel,
                correctStreak = card.correctStreak,
                preference = card.preference,
            )
            val promptTitle = if (showReading && hasDistinctReading) {
                "${card.word}（${card.reading}）"
            } else {
                card.word
            }

            val ctx = SrsEngine.pickContextualSentence(contexts, card.srsLevel)
            val promptBody = when {
                ctx == null -> "Due in SRS · Tap to open Sprint"
                ctx.animeTitle.isNotBlank() && ctx.episodeNumber > 0 ->
                    "${ctx.jp}\n${ctx.animeTitle} · Ep ${ctx.episodeNumber}"
                else -> ctx.jp
            }

            fun actionPending(action: String, remembered: Boolean?, reqCode: Int): PendingIntent {
                val i = Intent(context, BoosterActionReceiver::class.java).apply {
                    this.action = action
                    putExtra(EXTRA_WORD, card.word)
                    putExtra(EXTRA_LANG, card.learningLanguage)
                    putExtra(EXTRA_IS_DEMO, false)
                    if (remembered != null) {
                        putExtra(EXTRA_REMEMBERED, remembered)
                    }
                }
                return PendingIntent.getBroadcast(
                    context,
                    reqCode,
                    i,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }

            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_tatani)
                .setContentTitle(promptTitle)
                .setContentText(ctx?.jp ?: promptBody)
                .setStyle(NotificationCompat.BigTextStyle().bigText(promptBody))
                .setContentIntent(buildOpenSprintIntent(context, 100))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setSilent(silentUpdate)
                .setAutoCancel(true)
                .addAction(0, "I know", actionPending(ACTION_GRADE_KNOW, true, 201))
                .addAction(0, "I don't know", actionPending(ACTION_GRADE_AGAIN, false, 202))

            if (!showReading && hasDistinctReading) {
                builder.addAction(0, "かな Peek", actionPending(ACTION_PEEK_READING, null, 203))
            }

            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build())
            return true
        }

        fun postDemoPrompt(
            context: Context,
            word: String = "約束",
            reading: String? = "やくそく",
            meaning: String = "promise",
            sentenceJp: String = "昔の約束を覚えているか。",
            sentenceEn: String = "Do you remember our old promise?",
            lang: String = "ja",
            forcePeekReading: Boolean = false,
            silentUpdate: Boolean = false,
        ): Boolean {
            if (!canPostNotifications(context)) return false
            ensureChannel(context)

            val hasDistinctReading = !reading.isNullOrBlank() && reading != word
            val promptTitle = if (forcePeekReading && hasDistinctReading) {
                "$word（$reading）"
            } else {
                word
            }
            val promptBody = "$sentenceJp\nSample SRS preview · Tap I know / I don't know"

            fun demoPending(action: String, remembered: Boolean?, reqCode: Int): PendingIntent {
                val i = Intent(context, BoosterActionReceiver::class.java).apply {
                    this.action = action
                    putExtra(EXTRA_WORD, word)
                    putExtra(EXTRA_LANG, lang)
                    putExtra(EXTRA_IS_DEMO, true)
                    putExtra(EXTRA_DEMO_READING, reading)
                    putExtra(EXTRA_DEMO_MEANING, meaning)
                    putExtra(EXTRA_DEMO_JP, sentenceJp)
                    putExtra(EXTRA_DEMO_EN, sentenceEn)
                    if (remembered != null) {
                        putExtra(EXTRA_REMEMBERED, remembered)
                    }
                }
                return PendingIntent.getBroadcast(
                    context,
                    reqCode,
                    i,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }

            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_tatani)
                .setContentTitle(promptTitle)
                .setContentText(sentenceJp)
                .setStyle(NotificationCompat.BigTextStyle().bigText(promptBody))
                .setContentIntent(buildOpenSprintIntent(context, 101))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setSilent(silentUpdate)
                .setAutoCancel(true)
                .addAction(0, "I know", demoPending(ACTION_GRADE_KNOW, true, 201))
                .addAction(0, "I don't know", demoPending(ACTION_GRADE_AGAIN, false, 202))

            if (!forcePeekReading && hasDistinctReading) {
                builder.addAction(0, "かな Peek", demoPending(ACTION_PEEK_READING, null, 203))
            }

            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build())
            return true
        }
    }
}
