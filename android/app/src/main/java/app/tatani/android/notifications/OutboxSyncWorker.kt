package app.tatani.android.notifications

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.tatani.android.TataniApp
import java.util.concurrent.TimeUnit

class OutboxSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as TataniApp
        if (app.sessionStore.session.value == null) return Result.success()
        val ok = app.repository.flushOutbox()
        return if (ok) Result.success() else Result.retry()
    }

    companion object {
        private const val UNIQUE_WORK_NAME = "tatani_outbox_sync"

        fun enqueue(context: Context) {
            val req = OneTimeWorkRequestBuilder<OutboxSyncWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                UNIQUE_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                req
            )
        }
    }
}
