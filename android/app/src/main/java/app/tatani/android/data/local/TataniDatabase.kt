package app.tatani.android.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        WordCardEntity::class,
        OutboxMutationEntity::class,
        LibraryEpisodeEntity::class,
    ],
    version = 2,
    exportSchema = false,
)
abstract class TataniDatabase : RoomDatabase() {
    abstract fun dao(): TataniDao

    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `library_episodes` ADD COLUMN `episodeTitleEn` TEXT")
                db.execSQL("ALTER TABLE `library_episodes` ADD COLUMN `episodeTitleJp` TEXT")

                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `outbox_mutations_new` (
                        `userId` TEXT NOT NULL DEFAULT '',
                        `word` TEXT NOT NULL,
                        `learningLanguage` TEXT NOT NULL,
                        `reading` TEXT,
                        `level` TEXT,
                        `state` TEXT NOT NULL,
                        `preference` TEXT NOT NULL,
                        `knownSource` TEXT,
                        `correctStreak` INTEGER NOT NULL,
                        `srsLevel` INTEGER NOT NULL,
                        `srsDueAtEpochMs` INTEGER,
                        `lastReviewedAtIso` TEXT,
                        `markedKnownAtIso` TEXT,
                        `queuedAtEpochMs` INTEGER NOT NULL,
                        PRIMARY KEY(`userId`, `word`, `learningLanguage`)
                    )
                    """.trimIndent()
                )
                db.execSQL(
                    """
                    INSERT INTO `outbox_mutations_new` (
                        `userId`, `word`, `learningLanguage`, `reading`, `level`, `state`,
                        `preference`, `knownSource`, `correctStreak`, `srsLevel`,
                        `srsDueAtEpochMs`, `lastReviewedAtIso`, `markedKnownAtIso`, `queuedAtEpochMs`
                    )
                    SELECT
                        '', `word`, `learningLanguage`, `reading`, `level`, `state`,
                        `preference`, `knownSource`, `correctStreak`, `srsLevel`,
                        `srsDueAtEpochMs`, `lastReviewedAtIso`, `markedKnownAtIso`, `queuedAtEpochMs`
                    FROM `outbox_mutations`
                    """.trimIndent()
                )
                db.execSQL("DROP TABLE `outbox_mutations`")
                db.execSQL("ALTER TABLE `outbox_mutations_new` RENAME TO `outbox_mutations`")
            }
        }

        @Volatile
        private var instance: TataniDatabase? = null

        fun get(context: Context): TataniDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    TataniDatabase::class.java,
                    "tatani_local.db"
                ).addMigrations(MIGRATION_1_2).build().also { instance = it }
            }
    }
}
