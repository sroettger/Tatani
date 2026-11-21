package app.tatani.android.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        WordCardEntity::class,
        OutboxMutationEntity::class,
        LibraryEpisodeEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class TataniDatabase : RoomDatabase() {
    abstract fun dao(): TataniDao

    companion object {
        @Volatile
        private var instance: TataniDatabase? = null

        fun get(context: Context): TataniDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    TataniDatabase::class.java,
                    "tatani_local.db"
                ).fallbackToDestructiveMigration().build().also { instance = it }
            }
    }
}
