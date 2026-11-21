package app.tatani.android.data

import app.tatani.android.data.local.LibraryEpisodeEntity
import app.tatani.android.data.local.OutboxMutationEntity
import app.tatani.android.data.local.TataniDao
import app.tatani.android.data.local.WordCardEntity
import app.tatani.android.data.remote.AnimeSearchResultDto
import app.tatani.android.data.remote.SessionStore
import app.tatani.android.data.remote.SupabaseClient
import app.tatani.android.data.remote.UserWordStateDto
import app.tatani.android.domain.SrsEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import java.time.Instant

class TataniRepository(
    private val dao: TataniDao,
    val sessionStore: SessionStore,
    val supabase: SupabaseClient,
) {
    private val bgScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val flushMutex = Mutex()
    private val syncMutex = Mutex()

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

    val outboxCount: Flow<Int> = dao.observeOutboxCount()

    fun observeDeckCards(lang: String): Flow<List<WordCardEntity>> =
        dao.observeDeckCards(lang)

    fun observeLibraryEpisodes(lang: String): Flow<List<LibraryEpisodeEntity>> =
        dao.observeLibraryEpisodes(lang)

    fun decodeContexts(card: WordCardEntity): List<SrsEngine.EpisodeContext> {
        if (card.contextsJson.isBlank() || card.contextsJson == "[]") return emptyList()
        return runCatching {
            supabase.json.decodeFromString<List<SrsEngine.EpisodeContext>>(card.contextsJson)
        }.getOrDefault(emptyList())
    }

    /**
     * Optimistic <2ms local SQLite grade + non-blocking background outbox flush.
     */
    suspend fun gradeCardOptimistic(
        card: WordCardEntity,
        remembered: Boolean,
        nowMs: Long = System.currentTimeMillis(),
    ): SrsEngine.SrsSnapshot {
        val previous = card.toSrsSnapshot()
        val next = SrsEngine.computeNextSrsState(
            prev = previous,
            word = card.word,
            reading = card.reading,
            level = card.level,
            remembered = remembered,
            nowMs = nowMs,
        )
        persistSnapshotOptimistic(card, next, nowMs)
        return previous
    }

    suspend fun markPriorKnownOptimistic(
        card: WordCardEntity,
        nowMs: Long = System.currentTimeMillis(),
    ): SrsEngine.SrsSnapshot {
        val previous = card.toSrsSnapshot()
        val next = SrsEngine.computePriorKnownState(
            prev = previous,
            word = card.word,
            reading = card.reading,
            level = card.level,
            nowMs = nowMs,
        )
        persistSnapshotOptimistic(card, next, nowMs)
        return previous
    }

    suspend fun restoreSnapshotOptimistic(
        card: WordCardEntity,
        snapshot: SrsEngine.SrsSnapshot,
    ) {
        persistSnapshotOptimistic(card, snapshot, System.currentTimeMillis())
    }

    private suspend fun persistSnapshotOptimistic(
        card: WordCardEntity,
        snap: SrsEngine.SrsSnapshot,
        nowMs: Long,
    ) {
        val updatedCard = card.copy(
            reading = snap.reading,
            level = snap.level,
            hasServerState = true,
            state = snap.state,
            preference = snap.preference,
            knownSource = snap.knownSource,
            correctStreak = snap.correctStreak,
            srsLevel = snap.srsLevel,
            srsDueAtEpochMs = snap.srsDueAtEpochMs,
            lastReviewedAtIso = snap.lastReviewedAtIso,
            markedKnownAtIso = snap.markedKnownAtIso,
        )
        dao.upsertWordCard(updatedCard)
        dao.upsertOutboxMutation(
            OutboxMutationEntity(
                word = card.word,
                learningLanguage = card.learningLanguage,
                reading = snap.reading,
                level = snap.level,
                state = snap.state,
                preference = snap.preference,
                knownSource = snap.knownSource,
                correctStreak = snap.correctStreak,
                srsLevel = snap.srsLevel,
                srsDueAtEpochMs = snap.srsDueAtEpochMs,
                lastReviewedAtIso = snap.lastReviewedAtIso,
                markedKnownAtIso = snap.markedKnownAtIso,
                queuedAtEpochMs = nowMs,
            )
        )
        bgScope.launch { flushOutbox() }
    }

    suspend fun flushOutbox(): Boolean = flushMutex.withLock {
        val session = sessionStore.session.value ?: return@withLock false
        val pending = dao.getOutboxMutations()
        if (pending.isEmpty()) return@withLock true

        val dtos = pending.map { m ->
            UserWordStateDto(
                userId = session.userId,
                word = m.word,
                reading = m.reading,
                level = m.level?.takeIf { it != "none" },
                learningLanguage = m.learningLanguage,
                state = m.state,
                preference = m.preference,
                knownSource = m.knownSource,
                correctStreak = m.correctStreak,
                srsLevel = m.srsLevel,
                srsDueAt = m.srsDueAtEpochMs?.let { Instant.ofEpochMilli(it).toString() },
                lastReviewedAt = m.lastReviewedAtIso,
                markedKnownAt = m.markedKnownAtIso,
            )
        }

        val ok = runCatching { supabase.upsertWordStates(dtos) }.getOrDefault(false)
        if (ok) {
            for (sent in pending) {
                dao.deleteOutboxIfUnchanged(sent.word, sent.learningLanguage, sent.queuedAtEpochMs)
            }
        }
        ok
    }

    fun triggerBackgroundSync() {
        bgScope.launch { syncAllFromServer() }
    }

    suspend fun syncAllFromServer() {
        syncMutex.withLock {
            val currentSession = sessionStore.session.value ?: return@withLock
            _syncing.value = true
            try {
                flushOutbox()
                val (lang, userLevel) = supabase.fetchProfileAndProgress(currentSession.userId)
                val userRank = SrsEngine.jlptRank(userLevel)
                fun isBelowUserLevel(lvl: String?): Boolean =
                    userRank in 1..50 && SrsEngine.jlptRank(lvl) < userRank

                val serverStates = supabase.fetchWordStates(currentSession.userId, lang)
                val stateMap = serverStates.associateBy { it.word }.toMutableMap()

                // Overlay any remaining local outbox entries so local edits never flicker
                for (pending in dao.getOutboxMutations().filter { it.learningLanguage == lang }) {
                    stateMap[pending.word] = UserWordStateDto(
                        userId = currentSession.userId,
                        word = pending.word,
                        reading = pending.reading,
                        level = pending.level,
                        learningLanguage = lang,
                        state = pending.state,
                        preference = pending.preference,
                        knownSource = pending.knownSource,
                        correctStreak = pending.correctStreak,
                        srsLevel = pending.srsLevel,
                        srsDueAt = pending.srsDueAtEpochMs?.let { Instant.ofEpochMilli(it).toString() },
                        lastReviewedAt = pending.lastReviewedAtIso,
                        markedKnownAt = pending.markedKnownAtIso,
                    )
                }

                data class MutableCard(
                    val word: String,
                    var reading: String? = null,
                    var meaning: String = "",
                    var partOfSpeech: String = "",
                    var level: String? = null,
                    var frequency: Int = 1,
                    var primaryEpisodeId: String? = null,
                    var animeOrder: Int = 999,
                    var seasonNumber: Int = 1,
                    var episodeNumber: Int = 1,
                    var animeTitle: String = "",
                    val contexts: MutableList<SrsEngine.EpisodeContext> = mutableListOf(),
                )

                val cardBuilder = linkedMapOf<String, MutableCard>()

                // 1. Hydrate from study_chunk_words
                for (cw in supabase.fetchChunkWords(currentSession.userId, lang)) {
                    if (cw.word.isBlank() || cw.meaning.isNullOrBlank()) continue
                    val entry = cardBuilder.getOrPut(cw.word) { MutableCard(cw.word) }
                    if (entry.reading == null) entry.reading = cw.reading
                    if (entry.meaning.isBlank()) entry.meaning = cw.meaning
                    if (entry.partOfSpeech.isBlank()) entry.partOfSpeech = cw.partOfSpeech.orEmpty()
                    if (entry.level == null) entry.level = cw.level
                    if (!cw.exampleSentenceJp.isNullOrBlank() && entry.contexts.none { it.jp == cw.exampleSentenceJp }) {
                        entry.contexts += SrsEngine.EpisodeContext(
                            jp = cw.exampleSentenceJp,
                            en = cw.exampleSentenceEn.orEmpty(),
                        )
                    }
                }

                // 2. Hydrate from user_anime -> episodes -> episode_vocab_cache
                val userAnime = supabase.fetchUserAnime(currentSession.userId, lang)
                val animeMetaById = userAnime.mapIndexedNotNull { idx, row ->
                    val anime = row.anime ?: return@mapIndexedNotNull null
                    anime.id to Triple(idx, anime.titleEn ?: anime.titleRomaji, anime)
                }.toMap()

                val episodes = supabase.fetchEpisodesForAnimeIds(animeMetaById.keys.toList())
                val readyEpisodeIds = episodes.filter { it.processingStatus == "ready" }.map { it.id }
                val cachesByEpisode = supabase.fetchEpisodeVocabCaches(readyEpisodeIds, lang)
                    .associateBy { it.episodeId }

                val sortedEpisodes = episodes.sortedWith(
                    compareBy<app.tatani.android.data.remote.EpisodeRowDto>(
                        { animeMetaById[it.seasons.animeId]?.first ?: 999 },
                        { it.seasons.seasonNumber },
                        { it.episodeNumber },
                    )
                )

                val libraryEntities = mutableListOf<LibraryEpisodeEntity>()

                for (ep in sortedEpisodes) {
                    val meta = animeMetaById[ep.seasons.animeId] ?: continue
                    val animePos = meta.first
                    val animeTitle = meta.second
                    val catalog = meta.third
                    val vocabList = cachesByEpisode[ep.id]?.vocab.orEmpty()

                    var knownCount = 0
                    var unlearnedCount = 0

                    for (v in vocabList) {
                        if (v.word.isBlank() || v.meaning.isNullOrBlank()) continue
                        val lvl = (v.level ?: v.jlptLevel)?.takeIf { it != "none" }
                        val entry = cardBuilder.getOrPut(v.word) {
                            MutableCard(
                                word = v.word,
                                primaryEpisodeId = ep.id,
                                animeOrder = animePos,
                                seasonNumber = ep.seasons.seasonNumber,
                                episodeNumber = ep.episodeNumber,
                                animeTitle = animeTitle,
                            )
                        }
                        if (entry.primaryEpisodeId == null || animePos < entry.animeOrder) {
                            entry.primaryEpisodeId = ep.id
                            entry.animeOrder = animePos
                            entry.seasonNumber = ep.seasons.seasonNumber
                            entry.episodeNumber = ep.episodeNumber
                            entry.animeTitle = animeTitle
                        }
                        if (entry.reading == null) entry.reading = v.reading
                        if (entry.meaning.isBlank()) entry.meaning = v.meaning
                        if (entry.partOfSpeech.isBlank()) entry.partOfSpeech = v.partOfSpeech.orEmpty()
                        if (entry.level == null) entry.level = lvl
                        entry.frequency = maxOf(entry.frequency, v.frequency ?: 1)

                        if (!v.exampleSentenceJp.isNullOrBlank() && entry.contexts.none { it.jp == v.exampleSentenceJp }) {
                            entry.contexts += SrsEngine.EpisodeContext(
                                jp = v.exampleSentenceJp,
                                en = v.exampleSentenceEn.orEmpty(),
                                animeTitle = animeTitle,
                                episodeNumber = ep.episodeNumber,
                                episodeId = ep.id,
                            )
                        }

                        val st = stateMap[v.word]
                        val dueMs = st?.srsDueAt?.let { parseIsoMillis(it) }
                        val unlearned = SrsEngine.isUnlearnedCandidate(
                            hasExistingState = st != null,
                            state = st?.state ?: "unknown",
                            preference = st?.preference ?: "study",
                            knownSource = st?.knownSource,
                            srsDueAtEpochMs = dueMs,
                            isBelowUserLevel = isBelowUserLevel(lvl),
                        )
                        if (unlearned) unlearnedCount++ else knownCount++
                    }

                    libraryEntities += LibraryEpisodeEntity(
                        episodeId = ep.id,
                        learningLanguage = lang,
                        animeId = catalog.id,
                        animeTitle = animeTitle,
                        animeTitleJp = catalog.titleJp,
                        coverUrl = catalog.coverUrl,
                        animePosition = animePos,
                        seasonNumber = ep.seasons.seasonNumber,
                        episodeNumber = ep.episodeNumber,
                        processingStatus = ep.processingStatus,
                        totalWords = vocabList.size,
                        knownWords = knownCount,
                        unlearnedWords = unlearnedCount,
                    )
                }

                val entities = cardBuilder.values.map { item ->
                    val st = stateMap[item.word]
                    val dueMs = st?.srsDueAt?.let { parseIsoMillis(it) }
                    val defaultKnownByLevel = st == null && isBelowUserLevel(item.level)
                    WordCardEntity(
                        word = item.word,
                        learningLanguage = lang,
                        reading = item.reading ?: st?.reading,
                        meaning = item.meaning,
                        partOfSpeech = item.partOfSpeech,
                        level = item.level ?: st?.level,
                        frequency = item.frequency,
                        hasServerState = st != null,
                        state = st?.state ?: if (defaultKnownByLevel) "known" else "unknown",
                        preference = st?.preference ?: "study",
                        knownSource = st?.knownSource ?: if (defaultKnownByLevel) "prior" else null,
                        correctStreak = st?.correctStreak ?: 0,
                        srsLevel = st?.srsLevel ?: 0,
                        srsDueAtEpochMs = dueMs,
                        lastReviewedAtIso = st?.lastReviewedAt,
                        markedKnownAtIso = st?.markedKnownAt,
                        primaryEpisodeId = item.primaryEpisodeId,
                        animeOrder = item.animeOrder,
                        seasonNumber = item.seasonNumber,
                        episodeNumber = item.episodeNumber,
                        animeTitle = item.animeTitle,
                        contextsJson = supabase.json.encodeToString(item.contexts),
                    )
                }

                if (entities.isNotEmpty()) {
                    dao.upsertWordCards(entities)
                }
                dao.clearLibraryEpisodesForLang(lang)
                if (libraryEntities.isNotEmpty()) {
                    dao.upsertLibraryEpisodes(libraryEntities)
                }
            } catch (_: Throwable) {
                // Offline-safe: retain cached Room entities
            } finally {
                _syncing.value = false
            }
        }
    }

    suspend fun searchAnime(query: String): Result<List<AnimeSearchResultDto>> =
        supabase.searchAnime(query)

    suspend fun addAnimeAndSync(anime: AnimeSearchResultDto): Result<Unit> {
        val lang = sessionStore.session.value?.learningLanguage ?: "ja"
        val res = supabase.addAnimeToLibrary(anime, lang)
        if (res.isSuccess) {
            syncAllFromServer()
        }
        return res
    }

    suspend fun processEpisodeAndSync(episodeId: String): Result<Unit> {
        val res = supabase.autoFetchAndProcessEpisode(episodeId)
        if (res.isSuccess) {
            syncAllFromServer()
        }
        return res
    }

    suspend fun deleteAccountDataAndSignOut(): Result<Unit> {
        val uid = sessionStore.session.value?.userId ?: return Result.failure(IllegalStateException("Not signed in"))
        val res = supabase.deleteAllUserData(uid)
        signOut()
        return res
    }

    suspend fun signOut() {
        sessionStore.clear()
        dao.clearAllCards()
        dao.clearAllOutbox()
        dao.clearAllEpisodes()
    }

    private fun parseIsoMillis(iso: String): Long? =
        runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
}
