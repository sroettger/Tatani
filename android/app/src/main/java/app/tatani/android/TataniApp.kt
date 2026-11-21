package app.tatani.android

import android.app.Application
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import app.tatani.android.data.TataniRepository
import app.tatani.android.data.local.TataniDatabase
import app.tatani.android.data.remote.SessionStore
import app.tatani.android.data.remote.SupabaseClient
import app.tatani.android.notifications.BoosterActionReceiver
import app.tatani.android.notifications.DueBoosterWorker
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
        repository = TataniRepository(database.dao(), sessionStore, supabaseClient)

        BoosterActionReceiver.ensureChannel(this)

        val work = PeriodicWorkRequestBuilder<DueBoosterWorker>(1, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "tatani_graduated_srs_booster",
            ExistingPeriodicWorkPolicy.KEEP,
            work
        )
    }
}
