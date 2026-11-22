package app.tatani.android.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface TataniDao {
    @Query(
        """
        SELECT * FROM word_cards
        WHERE learningLanguage = :lang
          AND meaning != ''
        """
    )
    fun observeDeckCards(lang: String): Flow<List<WordCardEntity>>

    @Query(
        """
        SELECT * FROM word_cards
        WHERE learningLanguage = :lang
          AND meaning != ''
        """
    )
    suspend fun getDeckCardsSnapshot(lang: String): List<WordCardEntity>

    @Query("SELECT word FROM word_cards WHERE learningLanguage = :lang")
    suspend fun getWordsForLang(lang: String): List<String>

    @Query("SELECT * FROM word_cards WHERE word = :word AND learningLanguage = :lang LIMIT 1")
    suspend fun getWordCard(word: String, lang: String): WordCardEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertWordCards(cards: List<WordCardEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertWordCard(card: WordCardEntity)

    @Query("DELETE FROM word_cards WHERE learningLanguage = :lang AND word IN (:words)")
    suspend fun deleteWordsForLang(lang: String, words: List<String>)

    @Query("SELECT * FROM outbox_mutations WHERE userId = :userId ORDER BY queuedAtEpochMs ASC")
    suspend fun getOutboxMutations(userId: String): List<OutboxMutationEntity>

    @Query("SELECT COUNT(*) FROM outbox_mutations WHERE userId = :userId")
    fun observeOutboxCount(userId: String): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertOutboxMutation(mutation: OutboxMutationEntity)

    @Query(
        """
        UPDATE OR IGNORE outbox_mutations
        SET userId = :userId
        WHERE userId = ''
        """
    )
    suspend fun claimUnassignedOutboxMutations(userId: String)

    @Query("DELETE FROM outbox_mutations WHERE userId = ''")
    suspend fun clearUnassignedOutbox()

    @Query("DELETE FROM outbox_mutations WHERE userId = :userId")
    suspend fun clearOutboxForUser(userId: String)

    @Query(
        """
        DELETE FROM outbox_mutations
        WHERE userId = :userId AND word = :word AND learningLanguage = :lang AND queuedAtEpochMs = :queuedAt
        """
    )
    suspend fun deleteOutboxIfUnchanged(userId: String, word: String, lang: String, queuedAt: Long)

    @Query(
        """
        SELECT * FROM library_episodes
        WHERE learningLanguage = :lang
        ORDER BY animePosition ASC, seasonNumber ASC, episodeNumber ASC
        """
    )
    fun observeLibraryEpisodes(lang: String): Flow<List<LibraryEpisodeEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertLibraryEpisodes(episodes: List<LibraryEpisodeEntity>)

    @Query("DELETE FROM library_episodes WHERE learningLanguage = :lang")
    suspend fun clearLibraryEpisodesForLang(lang: String)

    @Transaction
    suspend fun replaceLibraryAndPruneOrphans(
        lang: String,
        episodes: List<LibraryEpisodeEntity>,
        activeWords: List<WordCardEntity>,
        keepWords: Set<String>,
    ) {
        if (activeWords.isNotEmpty()) {
            upsertWordCards(activeWords)
        }
        val existingWords = getWordsForLang(lang)
        val orphans = existingWords.filter { it !in keepWords }
        for (chunk in orphans.chunked(500)) {
            deleteWordsForLang(lang, chunk)
        }
        clearLibraryEpisodesForLang(lang)
        if (episodes.isNotEmpty()) {
            upsertLibraryEpisodes(episodes)
        }
    }

    @Query("DELETE FROM word_cards")
    suspend fun clearAllCards()

    @Query("DELETE FROM outbox_mutations")
    suspend fun clearAllOutbox()

    @Query("DELETE FROM library_episodes")
    suspend fun clearAllEpisodes()
}
