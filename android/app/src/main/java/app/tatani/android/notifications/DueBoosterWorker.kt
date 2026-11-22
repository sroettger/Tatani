package app.tatani.android.notifications

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.tatani.android.TataniApp
import app.tatani.android.domain.SrsEngine
import java.time.LocalTime
import java.util.concurrent.TimeUnit

class DueBoosterWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as TataniApp
        if (!app.sessionStore.boostersEnabled.value) return Result.success()

        val localHour = LocalTime.now().hour
        if (localHour !in 9..20) return Result.success()

        if (app.sessionStore.session.value == null) return Result.success()

        app.repository.syncAllFromServer()

        val session = app.sessionStore.session.value ?: return Result.success()
        if (!app.sessionStore.boostersEnabled.value) return Result.success()
        if (!BoosterActionReceiver.canPostNotifications(applicationContext)) {
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

        val card = dueGraduated.randomOrNull() ?: return Result.success()
        val contexts = app.repository.decodeContexts(card)
        BoosterActionReceiver.postCardPrompt(
            context = applicationContext,
            card = card,
            contexts = contexts,
            forcePeekReading = false,
            silentAudioAlert = false,
        )

        return Result.success()
    }

    companion object {
        private const val WORK_NAME = "tatani_graduated_srs_booster"

        fun syncSchedule(context: Context, enabled: Boolean, intervalMinutes: Int) {
            val wm = WorkManager.getInstance(context)
            if (!enabled) {
                wm.cancelUniqueWork(WORK_NAME)
                return
            }
            val periodMinutes = intervalMinutes.coerceAtLeast(15).toLong()
            val work = PeriodicWorkRequestBuilder<DueBoosterWorker>(periodMinutes, TimeUnit.MINUTES)
                .build()
            wm.enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                work,
            )
        }
    }
}
