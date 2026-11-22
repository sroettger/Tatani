package app.tatani.android

import android.app.Application
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import app.tatani.android.data.TataniRepository
import app.tatani.android.data.local.TataniDatabase
import app.tatani.android.data.remote.SessionStore
import app.tatani.android.data.remote.SupabaseClient
import app.tatani.android.notifications.BoosterActionReceiver
import app.tatani.android.notifications.DueBoosterWorker
import app.tatani.android.notifications.OutboxSyncWorker
import java.util.concurrent.TimeUnit

class TataniApp : Application() {
    lateinit var database: TataniDatabase
        private set
    lateinit var sessionStore: SessionStore
        private set
    lateinit var supabaseClient: SupabaseClient
        private set
    lateinit var repository: TataniRepository
        private set

    override fun onCreate() {
        super.onCreate()
        database = TataniDatabase.get(this)
        sessionStore = SessionStore(this)
        supabaseClient = SupabaseClient(sessionStore)
        repository = TataniRepository(
            dao = database.dao(),
            sessionStore = sessionStore,
            supabase = supabaseClient,
            onOutboxFlushFailed = { OutboxSyncWorker.enqueue(this) },
        )

        BoosterActionReceiver.ensureChannel(this)

        val work = PeriodicWorkRequestBuilder<DueBoosterWorker>(1, TimeUnit.HOURS)
            .build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "tatani_graduated_srs_booster",
            ExistingPeriodicWorkPolicy.UPDATE,
            work
        )
    }
}
