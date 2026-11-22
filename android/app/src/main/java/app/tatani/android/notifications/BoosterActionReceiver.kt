package app.tatani.android.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tatani.android.MainActivity
import app.tatani.android.R
import app.tatani.android.TataniApp
import app.tatani.android.domain.SrsEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class BoosterActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val word = intent.getStringExtra(EXTRA_WORD) ?: return
        val lang = intent.getStringExtra(EXTRA_LANG) ?: "ja"
        val remembered = intent.getBooleanExtra(EXTRA_REMEMBERED, false)
        val pendingResult = goAsync()

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val app = context.applicationContext as TataniApp
                val dao = app.database.dao()
                val card = dao.getWordCard(word, lang) ?: return@launch
                val now = System.currentTimeMillis()
                val nextDays = SrsEngine.nextIntervalDays(card.toSrsSnapshot(), remembered, now)
                app.repository.gradeCardOptimistic(card, remembered, nowMs = now, autoFlush = false)

                // Re-alert silently on the same notification ID with reading + meaning + example sentence
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
                ) {
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
                            append("\n")
                            append(ctx.jp)
                            if (ctx.en.isNotBlank()) {
                                append("\n")
                                append(ctx.en)
                            }
                        }
                    }

                    val openIntent = PendingIntent.getActivity(
                        context,
                        word.hashCode(),
                        Intent(context, MainActivity::class.java),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                    val feedback = NotificationCompat.Builder(context, CHANNEL_ID)
                        .setSmallIcon(R.drawable.ic_stat_tatani)
                        .setContentTitle(
                            if (remembered) "Correct · Next in ${nextDays}d"
                            else "Review again · 1d"
                        )
                        .setContentText(summaryLine)
                        .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
                        .setContentIntent(openIntent)
                        .setSilent(true)
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .build()

                    NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, feedback)
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
        const val EXTRA_WORD = "extra_word"
        const val EXTRA_LANG = "extra_lang"
        const val EXTRA_REMEMBERED = "extra_remembered"

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
    }
}
