package app.tatani.android.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import app.tatani.android.domain.SrsEngine

@Entity(
    tableName = "word_cards",
    primaryKeys = ["word", "learningLanguage"],
)
data class WordCardEntity(
    val word: String,
    val learningLanguage: String,
    val reading: String? = null,
    val meaning: String = "",
    val partOfSpeech: String = "",
    val level: String? = null,
    val frequency: Int = 1,
    val hasServerState: Boolean = false,
    val state: String = "unknown",
    val preference: String = "study",
    val knownSource: String? = null,
    val correctStreak: Int = 0,
    val srsLevel: Int = 0,
    val srsDueAtEpochMs: Long? = null,
    val lastReviewedAtIso: String? = null,
    val markedKnownAtIso: String? = null,
    val primaryEpisodeId: String? = null,
    val animeOrder: Int = 999,
    val seasonNumber: Int = 1,
    val episodeNumber: Int = 1,
    val animeTitle: String = "",
    val contextsJson: String = "[]",
) {
    fun toSrsSnapshot(): SrsEngine.SrsSnapshot = SrsEngine.SrsSnapshot(
        word = word,
        reading = reading,
        level = level,
        state = state,
        preference = preference,
        knownSource = knownSource,
        correctStreak = correctStreak,
        srsLevel = srsLevel,
        srsDueAtEpochMs = srsDueAtEpochMs,
        lastReviewedAtIso = lastReviewedAtIso,
        markedKnownAtIso = markedKnownAtIso,
        hasServerState = hasServerState,
    )
}

@Entity(
    tableName = "outbox_mutations",
    primaryKeys = ["userId", "word", "learningLanguage"],
)
data class OutboxMutationEntity(
    @ColumnInfo(defaultValue = "") val userId: String,
    val word: String,
    val learningLanguage: String,
    val reading: String?,
    val level: String?,
    val state: String,
    val preference: String,
    val knownSource: String?,
    val correctStreak: Int,
    val srsLevel: Int,
    val srsDueAtEpochMs: Long?,
    val lastReviewedAtIso: String?,
    val markedKnownAtIso: String?,
    val queuedAtEpochMs: Long,
)

@Entity(
    tableName = "library_episodes",
    primaryKeys = ["episodeId", "learningLanguage"],
)
data class LibraryEpisodeEntity(
    val episodeId: String,
    val learningLanguage: String,
    val animeId: String,
    val animeTitle: String,
    val animeTitleJp: String?,
    val coverUrl: String?,
    val animePosition: Int,
    val seasonNumber: Int,
    val episodeNumber: Int,
    val processingStatus: String,
    val totalWords: Int,
    val knownWords: Int,
    val unlearnedWords: Int,
    val episodeTitleEn: String? = null,
    val episodeTitleJp: String? = null,
)
