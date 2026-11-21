package app.tatani.android.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
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

    @Query("SELECT * FROM word_cards WHERE word = :word AND learningLanguage = :lang LIMIT 1")
    suspend fun getWordCard(word: String, lang: String): WordCardEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertWordCards(cards: List<WordCardEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertWordCard(card: WordCardEntity)

    @Query("SELECT * FROM outbox_mutations ORDER BY queuedAtEpochMs ASC")
    suspend fun getOutboxMutations(): List<OutboxMutationEntity>

    @Query("SELECT COUNT(*) FROM outbox_mutations")
    fun observeOutboxCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertOutboxMutation(mutation: OutboxMutationEntity)

    @Query(
        """
        DELETE FROM outbox_mutations
        WHERE word = :word AND learningLanguage = :lang AND queuedAtEpochMs = :queuedAt
        """
    )
    suspend fun deleteOutboxIfUnchanged(word: String, lang: String, queuedAt: Long)

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

    @Query("DELETE FROM word_cards")
    suspend fun clearAllCards()

    @Query("DELETE FROM outbox_mutations")
    suspend fun clearAllOutbox()

    @Query("DELETE FROM library_episodes")
    suspend fun clearAllEpisodes()
}
