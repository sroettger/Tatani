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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong

class TataniRepository(
    private val dao: TataniDao,
    val sessionStore: SessionStore,
    val supabase: SupabaseClient,
    private val bgScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val onOutboxFlushFailed: (() -> Unit)? = null,
) {
    private val flushMutex = Mutex()
    private val syncMutex = Mutex()
    private val authEpoch = AtomicLong(0L)

    private val _syncing = MutableStateFlow(false)
    val syncing: StateFlow<Boolean> = _syncing.asStateFlow()

    private val _syncError = MutableStateFlow<String?>(null)
    val syncError: StateFlow<String?> = _syncError.asStateFlow()

    @OptIn(ExperimentalCoroutinesApi::class)
    val outboxCount: Flow<Int> = sessionStore.session.flatMapLatest { s ->
        if (s == null) flowOf(0) else dao.observeOutboxCount(s.userId)
    }

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
     * Optimistic <2ms local SQLite grade + optional non-blocking background outbox flush.
     */
    suspend fun gradeCardOptimistic(
        card: WordCardEntity,
        remembered: Boolean,
        nowMs: Long = System.currentTimeMillis(),
        autoFlush: Boolean = true,
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
        persistSnapshotOptimistic(card, next, nowMs, autoFlush = autoFlush)
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
            reading = card.word.let { card.reading },
            level = card.level,
            nowMs = nowMs,
        )
        persistSnapshotOptimistic(card, next, nowMs, autoFlush = true)
        return previous
    }

    suspend fun restudyCardOptimistic(
        card: WordCardEntity,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val resetSnap = SrsEngine.SrsSnapshot(
            word = card.word,
            reading = card.reading,
            level = card.level,
            state = "unknown",
            preference = "study",
            knownSource = null,
            correctStreak = 0,
            srsLevel = 0,
            srsDueAtEpochMs = null,
            lastReviewedAtIso = null,
            markedKnownAtIso = null,
            hasServerState = true,
        )
        persistSnapshotOptimistic(card, resetSnap, nowMs, autoFlush = true)
    }

    suspend fun restoreSnapshotOptimistic(
        card: WordCardEntity,
        snapshot: SrsEngine.SrsSnapshot,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        if (!snapshot.hasServerState) {
            val restoredCard = card.copy(
                reading = snapshot.reading,
                level = snapshot.level,
                hasServerState = false,
                state = "unknown",
                preference = "study",
                knownSource = null,
                correctStreak = 0,
                srsLevel = 0,
                srsDueAtEpochMs = null,
                lastReviewedAtIso = null,
                markedKnownAtIso = null,
            )
            dao.upsertWordCard(restoredCard)
            val uid = sessionStore.session.value?.userId
            if (!uid.isNullOrBlank()) {
                dao.upsertOutboxMutation(
                    OutboxMutationEntity(
                        userId = uid,
                        word = card.word,
                        learningLanguage = card.learningLanguage,
                        reading = snapshot.reading,
                        level = snapshot.level,
                        state = OUTBOX_DELETE_STATE,
                        preference = "study",
                        knownSource = null,
                        correctStreak = 0,
                        srsLevel = 0,
                        srsDueAtEpochMs = null,
                        lastReviewedAtIso = null,
                        markedKnownAtIso = null,
                        queuedAtEpochMs = nowMs,
                    )
                )
                bgScope.launch { flushOutbox() }
            }
            return
        }
        persistSnapshotOptimistic(card, snapshot, nowMs, autoFlush = true)
    }

    private suspend fun persistSnapshotOptimistic(
        card: WordCardEntity,
        snap: SrsEngine.SrsSnapshot,
        nowMs: Long,
        autoFlush: Boolean,
    ) {
        val updatedCard = card.copy(
            reading = snap.reading,
            level = snap.level,
            hasServerState = snap.hasServerState,
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
        val uid = sessionStore.session.value?.userId
        if (!uid.isNullOrBlank()) {
            dao.upsertOutboxMutation(
                OutboxMutationEntity(
                    userId = uid,
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
            if (autoFlush) {
                bgScope.launch { flushOutbox() }
            }
        }
    }

    suspend fun flushOutbox(): Boolean = flushMutex.withLock {
        val startEpoch = authEpoch.get()
        val session = sessionStore.session.value ?: return@withLock false
        dao.claimUnassignedOutboxMutations(session.userId)
        val pending = dao.getOutboxMutations(session.userId)
        if (pending.isEmpty()) return@withLock true

        val (toDelete, toUpsert) = pending.partition { it.state == OUTBOX_DELETE_STATE }
        var allOk = true

        if (toUpsert.isNotEmpty()) {
            val dtos = toUpsert.map { m ->
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
            if (ok && authEpoch.get() == startEpoch) {
                for (sent in toUpsert) {
                    dao.deleteOutboxIfUnchanged(
                        sent.userId,
                        sent.word,
                        sent.learningLanguage,
                        sent.queuedAtEpochMs
                    )
                }
            } else if (!ok) {
                allOk = false
            }
        }

        if (toDelete.isNotEmpty()) {
            for ((lang, langDeletes) in toDelete.groupBy { it.learningLanguage }) {
                val ok = runCatching {
                    supabase.deleteWordStates(session.userId, lang, langDeletes.map { it.word })
                }.getOrDefault(false)
                if (ok && authEpoch.get() == startEpoch) {
                    for (sent in langDeletes) {
                        dao.deleteOutboxIfUnchanged(
                            sent.userId,
                            sent.word,
                            sent.learningLanguage,
                            sent.queuedAtEpochMs
                        )
                    }
                } else if (!ok) {
                    allOk = false
                }
            }
        }

        if (!allOk) {
            onOutboxFlushFailed?.invoke()
        }
        allOk
    }

    fun triggerBackgroundSync() {
        bgScope.launch { syncAllFromServer() }
    }

    suspend fun syncAllFromServer() {
        syncMutex.withLock {
            val startEpoch = authEpoch.get()
            val currentSession = sessionStore.session.value ?: return@withLock
            fun isSessionStillValid(): Boolean =
                authEpoch.get() == startEpoch &&
                    sessionStore.session.value?.userId == currentSession.userId

            _syncing.value = true
            try {
                _syncError.value = null
                flushOutbox()
                if (!isSessionStillValid()) return@withLock

                val (lang, userLevel) = supabase.fetchProfileAndProgress(currentSession.userId)
                if (!isSessionStillValid()) return@withLock

                val userRank = SrsEngine.jlptRank(userLevel)
                fun isBelowUserLevel(lvl: String?): Boolean =
                    userRank in 1..50 && SrsEngine.jlptRank(lvl) < userRank

                val serverStates = supabase.fetchWordStates(currentSession.userId, lang)
                if (!isSessionStillValid()) return@withLock

                val stateMap = serverStates.associateBy { it.word }.toMutableMap()
                val pendingForLang = dao.getOutboxMutations(currentSession.userId)
                    .filter { it.learningLanguage == lang }

                // Overlay any remaining local outbox entries so local edits never flicker
                for (pending in pendingForLang) {
                    if (pending.state == OUTBOX_DELETE_STATE) {
                        stateMap.remove(pending.word)
                    } else {
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
                if (!isSessionStillValid()) return@withLock

                // 2. Hydrate from user_anime -> episodes -> episode_vocab_cache
                val userAnime = supabase.fetchUserAnime(currentSession.userId, lang)
                if (!isSessionStillValid()) return@withLock

                val animeMetaById = userAnime.mapIndexedNotNull { idx, row ->
                    val anime = row.anime ?: return@mapIndexedNotNull null
                    anime.id to Triple(idx, anime.titleEn ?: anime.titleRomaji, anime)
                }.toMap()

                val episodes = supabase.fetchEpisodesForAnimeIds(animeMetaById.keys.toList())
                if (!isSessionStillValid()) return@withLock

                val allEpisodeIds = episodes.map { it.id }
                val cachesByEpisode = supabase.fetchEpisodeVocabCaches(allEpisodeIds, lang)
                    .associateBy { it.episodeId }
                if (!isSessionStillValid()) return@withLock

                val sortedEpisodes = episodes.sortedWith(
                    compareBy<app.tatani.android.data.remote.EpisodeRowDto>(
                        { animeMetaById[it.seasons.animeId]?.first ?: 999 },
                        { it.seasons.seasonNumber },
                        { it.episodeNumber },
                    )
                )

                val libraryEntities = mutableListOf<LibraryEpisodeEntity>()
                val coveredAnimeIds = HashSet<String>()

                for (ep in sortedEpisodes) {
                    val meta = animeMetaById[ep.seasons.animeId] ?: continue
                    coveredAnimeIds += ep.seasons.animeId
                    val animePos = meta.first
                    val animeTitle = meta.second
                    val catalog = meta.third
                    val vocabList = cachesByEpisode[ep.id]?.vocab.orEmpty()
                    val effectiveStatus = when {
                        vocabList.isNotEmpty() -> "ready"
                        ep.processingStatus == "processing" || ep.processingStatus == "failed" -> ep.processingStatus
                        else -> "not_processed"
                    }

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
                        processingStatus = effectiveStatus,
                        totalWords = knownCount + unlearnedCount,
                        knownWords = knownCount,
                        unlearnedWords = unlearnedCount,
                        episodeTitleEn = ep.titleEn,
                        episodeTitleJp = ep.titleJp,
                    )
                }

                // Keep anime visible in Library even if server-side episodes have not populated yet
                for ((animeId, meta) in animeMetaById) {
                    if (animeId in coveredAnimeIds) continue
                    val catalog = meta.third
                    libraryEntities += LibraryEpisodeEntity(
                        episodeId = "placeholder:$animeId",
                        learningLanguage = lang,
                        animeId = catalog.id,
                        animeTitle = meta.second,
                        animeTitleJp = catalog.titleJp,
                        coverUrl = catalog.coverUrl,
                        animePosition = meta.first,
                        seasonNumber = 1,
                        episodeNumber = 1,
                        processingStatus = "not_processed",
                        totalWords = 0,
                        knownWords = 0,
                        unlearnedWords = 0,
                    )
                }

                val entities = cardBuilder.values.map { item ->
                    val st = stateMap[item.word]
                    val dueMs = st?.srsDueAt?.let { parseIsoMillis(it) }
                    WordCardEntity(
                        word = item.word,
                        learningLanguage = lang,
                        reading = item.reading ?: st?.reading,
                        meaning = item.meaning,
                        partOfSpeech = item.partOfSpeech,
                        level = item.level ?: st?.level,
                        frequency = item.frequency,
                        hasServerState = st != null,
                        state = st?.state ?: "unknown",
                        preference = st?.preference ?: "study",
                        knownSource = st?.knownSource,
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
                }.toMutableList()

                // Preserve any locally cached graduated SRS cards whose anime was removed from library
                val builtWords = entities.mapTo(HashSet()) { it.word }
                val existingGraduated = dao.getDeckCardsSnapshot(lang).filter { existing ->
                    existing.word !in builtWords &&
                        (stateMap[existing.word]?.srsDueAt != null || pendingForLang.any { it.word == existing.word })
                }
                for (existing in existingGraduated) {
                    val st = stateMap[existing.word]
                    val dueMs = st?.srsDueAt?.let { parseIsoMillis(it) }
                    entities += existing.copy(
                        hasServerState = st != null,
                        state = st?.state ?: "unknown",
                        preference = st?.preference ?: "study",
                        knownSource = st?.knownSource,
                        correctStreak = st?.correctStreak ?: 0,
                        srsLevel = st?.srsLevel ?: 0,
                        srsDueAtEpochMs = dueMs,
                        lastReviewedAtIso = st?.lastReviewedAt,
                        markedKnownAtIso = st?.markedKnownAt,
                    )
                }

                val keepWords = HashSet<String>(entities.size + pendingForLang.size)
                entities.forEach { keepWords += it.word }
                pendingForLang.forEach { keepWords += it.word }

                if (!isSessionStillValid()) return@withLock
                dao.replaceLibraryAndPruneOrphans(
                    lang = lang,
                    episodes = libraryEntities,
                    activeWords = entities,
                    keepWords = keepWords,
                )
            } catch (ce: CancellationException) {
                throw ce
            } catch (e: Throwable) {
                // Offline-safe: retain cached Room entities and expose diagnostic error
                if (isSessionStillValid()) {
                    runCatching { android.util.Log.w("TataniSync", "syncAllFromServer failed", e) }
                    _syncError.value = e.message ?: e::class.simpleName
                }
            } finally {
                _syncing.value = false
            }
        }
    }

    suspend fun updateUserLevelAndSync(level: String): Result<Unit> {
        val current = sessionStore.session.value
            ?: return Result.failure(IllegalStateException("Not signed in"))
        val prevLevel = current.userLevel
        sessionStore.updateLanguagePrefs(current.learningLanguage, level)
        val res = supabase.updateUserLevel(current.userId, current.learningLanguage, level)
        if (res.isSuccess) {
            triggerBackgroundSync()
        } else {
            sessionStore.updateLanguagePrefs(current.learningLanguage, prevLevel)
        }
        return res
    }

    suspend fun updateLearningLanguageAndSync(lang: String): Result<Unit> {
        val current = sessionStore.session.value
            ?: return Result.failure(IllegalStateException("Not signed in"))
        val res = supabase.updateLearningLanguage(current.userId, lang)
        return res.map { newLevel ->
            sessionStore.updateLanguagePrefs(lang, newLevel)
            syncAllFromServer()
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

    suspend fun removeAnimeAndSync(animeId: String): Result<Unit> {
        val current = sessionStore.session.value
            ?: return Result.failure(IllegalStateException("Not signed in"))
        val res = supabase.removeUserAnime(current.userId, animeId, current.learningLanguage)
        if (res.isSuccess) {
            syncAllFromServer()
        }
        return res
    }

    suspend fun processEpisodeAndSync(episodeId: String): Result<Unit> =
        processEpisodeDetailedAndSync(episodeId).map { }

    suspend fun processEpisodeDetailedAndSync(episodeId: String): Result<Boolean> {
        val res = supabase.autoFetchAndProcessEpisodeDetailed(episodeId)
        if (res.isSuccess) {
            syncAllFromServer()
        }
        return res
    }

    suspend fun processEpisodeManualAndSync(episodeId: String, subtitleText: String): Result<Unit> {
        val res = supabase.processEpisodeWithSubtitleText(episodeId, subtitleText)
        if (res.isSuccess) {
            syncAllFromServer()
        }
        return res
    }

    suspend fun deleteAccountDataAndSignOut(): Result<Unit> {
        val uid = sessionStore.session.value?.userId
            ?: return Result.failure(IllegalStateException("Not signed in"))
        val res = supabase.deleteAllUserData(uid)
        if (res.isSuccess) {
            dao.clearOutboxForUser(uid)
            signOut()
        }
        return res
    }

    suspend fun signOut() {
        authEpoch.incrementAndGet()
        sessionStore.clear()
        syncMutex.withLock {
            flushMutex.withLock {
                dao.clearAllCards()
                dao.clearAllEpisodes()
                dao.clearUnassignedOutbox()
                _syncError.value = null
            }
        }
    }

    private fun parseIsoMillis(iso: String): Long? =
        runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()

    companion object {
        const val OUTBOX_DELETE_STATE = "__delete__"
    }
}
