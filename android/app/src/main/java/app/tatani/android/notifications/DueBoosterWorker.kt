package app.tatani.android.notifications

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.tatani.android.MainActivity
import app.tatani.android.R
import app.tatani.android.TataniApp
import app.tatani.android.domain.SrsEngine

class DueBoosterWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as TataniApp
        val session = app.sessionStore.session.value ?: return Result.success()

        app.repository.syncAllFromServer()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return Result.success()
        }

        val now = System.currentTimeMillis()
        val dueGraduated = app.database.dao()
            .getDeckCardsSnapshot(session.learningLanguage)
            .filter {
                SrsEngine.isDueForSprint(
                    preference = it.preference,
                    knownSource = it.knownSource,
                    srsDueAtEpochMs = it.srsDueAtEpochMs,
                    nowMs = now,
                )
            }

        if (dueGraduated.isEmpty()) return Result.success()

        val card = dueGraduated.random()
        val contexts = app.repository.decodeContexts(card)
        val example = SrsEngine.pickContextualSentence(contexts, card.srsLevel)?.jp

        BoosterActionReceiver.ensureChannel(applicationContext)

        val title = if (!card.reading.isNullOrBlank() && card.reading != card.word) {
            "${card.word} (${card.reading})"
        } else {
            card.word
        }

        fun buildActionIntent(remembered: Boolean, reqCode: Int): PendingIntent {
            val i = Intent(applicationContext, BoosterActionReceiver::class.java).apply {
                putExtra(BoosterActionReceiver.EXTRA_WORD, card.word)
                putExtra(BoosterActionReceiver.EXTRA_LANG, card.learningLanguage)
                putExtra(BoosterActionReceiver.EXTRA_REMEMBERED, remembered)
            }
            return PendingIntent.getBroadcast(
                applicationContext,
                reqCode,
                i,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        val tapIntent = PendingIntent.getActivity(
            applicationContext,
            100,
            Intent(applicationContext, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(applicationContext, BoosterActionReceiver.CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(example ?: "Due in SRS · Tap to open Sprint")
            .setStyle(NotificationCompat.BigTextStyle().bigText(example ?: "Due in SRS · Tap to open Sprint"))
            .setContentIntent(tapIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .addAction(0, "I know", buildActionIntent(true, 201))
            .addAction(0, "I don't know", buildActionIntent(false, 202))

        NotificationManagerCompat.from(applicationContext)
            .notify(BoosterActionReceiver.NOTIFICATION_ID, builder.build())

        return Result.success()
    }
}
