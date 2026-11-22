package app.tatani.android

import app.tatani.android.data.TataniRepository
import app.tatani.android.data.local.LibraryEpisodeEntity
import app.tatani.android.data.local.OutboxMutationEntity
import app.tatani.android.data.local.TataniDao
import app.tatani.android.data.local.WordCardEntity
import app.tatani.android.data.remote.AuthSession
import app.tatani.android.data.remote.SessionStore
import app.tatani.android.data.remote.SupabaseClient
import app.tatani.android.domain.SrsEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private class FakeTataniDao : TataniDao {
    private val cardsState = MutableStateFlow<Map<Pair<String, String>, WordCardEntity>>(emptyMap())
    private val outboxState = MutableStateFlow<Map<Triple<String, String, String>, OutboxMutationEntity>>(emptyMap())
    private val episodesState = MutableStateFlow<Map<Pair<String, String>, LibraryEpisodeEntity>>(emptyMap())
    private val lock = Any()

    override fun observeDeckCards(lang: String): Flow<List<WordCardEntity>> =
        cardsState.map { map ->
            map.values.filter { it.learningLanguage == lang && it.meaning.isNotEmpty() }
        }

    override suspend fun getDeckCardsSnapshot(lang: String): List<WordCardEntity> =
        synchronized(lock) {
            cardsState.value.values.filter { it.learningLanguage == lang && it.meaning.isNotEmpty() }
        }

    override suspend fun getWordsForLang(lang: String): List<String> =
        synchronized(lock) {
            cardsState.value.values.filter { it.learningLanguage == lang }.map { it.word }
        }

    override suspend fun getWordCard(word: String, lang: String): WordCardEntity? =
        synchronized(lock) {
            cardsState.value[word to lang]
        }

    override suspend fun upsertWordCards(cards: List<WordCardEntity>) {
        synchronized(lock) {
            val next = cardsState.value.toMutableMap()
            for (c in cards) {
                next[c.word to c.learningLanguage] = c
            }
            cardsState.value = next
        }
    }

    override suspend fun upsertWordCard(card: WordCardEntity) {
        upsertWordCards(listOf(card))
    }

    override suspend fun deleteWordsForLang(lang: String, words: List<String>) {
        synchronized(lock) {
            val set = words.toHashSet()
            cardsState.value = cardsState.value.filterKeys { (w, l) -> !(l == lang && w in set) }
        }
    }

    override suspend fun getOutboxMutations(userId: String): List<OutboxMutationEntity> =
        synchronized(lock) {
            outboxState.value.values
                .filter { it.userId == userId }
                .sortedBy { it.queuedAtEpochMs }
        }

    override fun observeOutboxCount(userId: String): Flow<Int> =
        outboxState.map { map -> map.values.count { it.userId == userId } }

    override suspend fun upsertOutboxMutation(mutation: OutboxMutationEntity) {
        synchronized(lock) {
            val next = outboxState.value.toMutableMap()
            next[Triple(mutation.userId, mutation.word, mutation.learningLanguage)] = mutation
            outboxState.value = next
        }
    }

    override suspend fun claimUnassignedOutboxMutations(userId: String) {
        synchronized(lock) {
            val next = LinkedHashMap<Triple<String, String, String>, OutboxMutationEntity>()
            for ((k, v) in outboxState.value) {
                if (v.userId.isEmpty()) {
                    val newKey = Triple(userId, v.word, v.learningLanguage)
                    if (newKey !in outboxState.value) {
                        next[newKey] = v.copy(userId = userId)
                    }
                } else {
                    next[k] = v
                }
            }
            outboxState.value = next
        }
    }

    override suspend fun clearUnassignedOutbox() {
        synchronized(lock) {
            outboxState.value = outboxState.value.filterValues { it.userId.isNotEmpty() }
        }
    }

    override suspend fun clearOutboxForUser(userId: String) {
        synchronized(lock) {
            outboxState.value = outboxState.value.filterValues { it.userId != userId }
        }
    }

    override suspend fun deleteOutboxIfUnchanged(userId: String, word: String, lang: String, queuedAt: Long) {
        synchronized(lock) {
            val key = Triple(userId, word, lang)
            val existing = outboxState.value[key]
            if (existing != null && existing.queuedAtEpochMs == queuedAt) {
                outboxState.value = outboxState.value - key
            }
        }
    }

    override fun observeLibraryEpisodes(lang: String): Flow<List<LibraryEpisodeEntity>> =
        episodesState.map { map ->
            map.values
                .filter { it.learningLanguage == lang }
                .sortedWith(compareBy({ it.animePosition }, { it.seasonNumber }, { it.episodeNumber }))
        }

    override suspend fun upsertLibraryEpisodes(episodes: List<LibraryEpisodeEntity>) {
        synchronized(lock) {
            val next = episodesState.value.toMutableMap()
            for (ep in episodes) {
                next[ep.episodeId to ep.learningLanguage] = ep
            }
            episodesState.value = next
        }
    }

    override suspend fun clearLibraryEpisodesForLang(lang: String) {
        synchronized(lock) {
            episodesState.value = episodesState.value.filterKeys { (_, l) -> l != lang }
        }
    }

    override suspend fun clearAllCards() {
        synchronized(lock) { cardsState.value = emptyMap() }
    }

    override suspend fun clearAllOutbox() {
        synchronized(lock) { outboxState.value = emptyMap() }
    }

    override suspend fun clearAllEpisodes() {
        synchronized(lock) { episodesState.value = emptyMap() }
    }
}

class TataniRepositoryTest {
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun jsonResponse(req: Request, code: Int, body: String): Response =
        Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("HTTP $code")
            .body(body.toResponseBody(jsonMedia))
            .build()

    private fun activeSession(
        userId: String = "user-a",
        lang: String = "ja",
        level: String = "N4",
    ): AuthSession = AuthSession(
        userId = userId,
        email = "$userId@tatani.app",
        accessToken = "tok-$userId",
        refreshToken = "ref-$userId",
        expiresAtEpochSec = System.currentTimeMillis() / 1000L + 3600L,
        learningLanguage = lang,
        userLevel = level,
    )

    @Test
    fun failedFetchWordStatesPreservesExistingLocalRoomCards_C2() = runTest {
        val dao = FakeTataniDao()
        dao.upsertWordCard(
            WordCardEntity(
                word = "魔法",
                learningLanguage = "ja",
                reading = "まほう",
                meaning = "magic",
                level = "N4",
                hasServerState = true,
                state = "known",
                knownSource = "learned",
                srsLevel = 2,
                srsDueAtEpochMs = 1_800_000_000_000L,
            )
        )

        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                when {
                    req.url.encodedPath.endsWith("/rest/v1/profiles") ->
                        jsonResponse(req, 200, """[{"user_id":"user-a","learning_language":"ja"}]""")
                    req.url.encodedPath.endsWith("/rest/v1/user_language_progress") ->
                        jsonResponse(req, 200, """[{"learning_language":"ja","level":"N4","placement_done":true}]""")
                    req.url.encodedPath.endsWith("/rest/v1/user_word_state") ->
                        jsonResponse(req, 500, """{"message":"database overloaded"}""")
                    else -> jsonResponse(req, 200, "[]")
                }
            }
            .build()

        val store = SessionStore.inMemory(activeSession())
        val client = SupabaseClient(store, "https://mock.supabase.co", "anon", http)
        val repo = TataniRepository(dao, store, client)

        repo.syncAllFromServer()

        val retained = dao.getDeckCardsSnapshot("ja")
        assertEquals("Local Room cards must never be wiped on HTTP failure", 1, retained.size)
        assertEquals("魔法", retained.single().word)
        assertEquals(2, retained.single().srsLevel)
        assertNotNull(repo.syncError.value)
    }

    @Test
    fun signOutMidSyncPreventsStaleWriteAndScopesOutboxByUserId_C4() = runBlocking {
        val dao = FakeTataniDao()
        val enteredFetchStates = CountDownLatch(1)
        val allowFetchStatesFinish = CountDownLatch(1)

        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                when {
                    req.url.encodedPath.endsWith("/rest/v1/user_word_state") && req.method == "POST" ->
                        jsonResponse(req, 503, """{"message":"offline"}""")
                    req.url.encodedPath.endsWith("/rest/v1/profiles") ->
                        jsonResponse(req, 200, """[{"user_id":"user-a","learning_language":"ja"}]""")
                    req.url.encodedPath.endsWith("/rest/v1/user_language_progress") ->
                        jsonResponse(req, 200, """[{"learning_language":"ja","level":"none","placement_done":true}]""")
                    req.url.encodedPath.endsWith("/rest/v1/user_word_state") && req.method == "GET" -> {
                        enteredFetchStates.countDown()
                        allowFetchStatesFinish.await(5, TimeUnit.SECONDS)
                        jsonResponse(req, 200, "[]")
                    }
                    req.url.encodedPath.endsWith("/rest/v1/study_chunks") ->
                        jsonResponse(req, 200, """[{"id":"chunk-1"}]""")
                    req.url.encodedPath.endsWith("/rest/v1/study_chunk_words") ->
                        jsonResponse(
                            req,
                            200,
                            """[{"word":"秘密","reading":"ひみつ","meaning":"secret","level":"N4"}]"""
                        )
                    req.url.encodedPath.endsWith("/rest/v1/user_anime") ->
                        jsonResponse(req, 200, "[]")
                    else -> jsonResponse(req, 200, "[]")
                }
            }
            .build()

        val store = SessionStore.inMemory(activeSession(userId = "user-a"))
        val client = SupabaseClient(store, "https://mock.supabase.co", "anon", http)
        val repoScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val repo = TataniRepository(dao, store, client, bgScope = repoScope)

        // Queue an offline grade as User A
        repo.gradeCardOptimistic(
            card = WordCardEntity(
                word = "探知",
                learningLanguage = "ja",
                reading = "たんち",
                meaning = "detection",
                level = "N2",
            ),
            remembered = true,
            autoFlush = false,
        )
        assertEquals(1, dao.getOutboxMutations("user-a").size)
        assertEquals(0, dao.getOutboxMutations("user-b").size)

        // Start User A sync in background and pause mid-flight inside fetchWordStates
        val syncJob = async(Dispatchers.IO) {
            repo.syncAllFromServer()
        }
        assertTrue(enteredFetchStates.await(5, TimeUnit.SECONDS))

        // User A signs out while sync is still in flight; unblock network while signOut waits for syncMutex
        val signOutJob = async(Dispatchers.IO) {
            repo.signOut()
        }
        // Give signOut a moment to increment authEpoch & clear SessionStore, then release HTTP response
        while (store.session.value != null) {
            Thread.yield()
        }
        allowFetchStatesFinish.countDown()

        syncJob.await()
        signOutJob.await()

        assertNull(store.session.value)
        assertTrue(
            "User A's in-flight sync must never populate Room after signOut()",
            dao.getDeckCardsSnapshot("ja").isEmpty()
        )
        assertTrue(dao.observeLibraryEpisodes("ja").first().isEmpty())

        // User A's unsynced outbox remains scoped strictly to user-a, invisible to user-b
        store.saveSession(activeSession(userId = "user-b"))
        assertEquals(0, dao.getOutboxMutations("user-b").size)
        assertEquals(0, repo.outboxCount.first())
        assertEquals(1, dao.getOutboxMutations("user-a").size)
    }

    @Test
    fun changingUserLevelDynamicallyUpdatesUnlearnedEligibilityWithoutResync_H1() = runTest {
        val dao = FakeTataniDao()
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                when {
                    req.url.encodedPath.endsWith("/rest/v1/profiles") ->
                        jsonResponse(req, 200, """[{"user_id":"user-a","learning_language":"ja"}]""")
                    req.url.encodedPath.endsWith("/rest/v1/user_language_progress") ->
                        jsonResponse(req, 200, """[{"learning_language":"ja","level":"N3","placement_done":true}]""")
                    req.url.encodedPath.endsWith("/rest/v1/user_word_state") ->
                        jsonResponse(req, 200, "[]")
                    req.url.encodedPath.endsWith("/rest/v1/study_chunks") ->
                        jsonResponse(req, 200, "[]")
                    req.url.encodedPath.endsWith("/rest/v1/user_anime") ->
                        jsonResponse(
                            req,
                            200,
                            """[{"position":0,"anime":{"id":"anime-1","title_romaji":"Sousou no Frieren","title_en":"Frieren"}}]"""
                        )
                    req.url.encodedPath.endsWith("/rest/v1/episodes") ->
                        jsonResponse(
                            req,
                            200,
                            """[{"id":"ep-1","episode_number":1,"title_en":"The Journey's End","processing_status":"ready","seasons":{"anime_id":"anime-1","season_number":1}}]"""
                        )
                    req.url.encodedPath.endsWith("/rest/v1/episode_vocab_cache") ->
                        jsonResponse(
                            req,
                            200,
                            """[{"episode_id":"ep-1","vocab":[
                                {"word":"食べる","reading":"たべる","meaning":"to eat","level":"N5","frequency":4},
                                {"word":"魔法","reading":"まほう","meaning":"magic","level":"N4","frequency":6},
                                {"word":"探知","reading":"たんち","meaning":"detection","level":"N2","frequency":3}
                            ]}]"""
                        )
                    else -> jsonResponse(req, 200, "[]")
                }
            }
            .build()

        val store = SessionStore.inMemory(activeSession(userId = "user-a", lang = "ja", level = "N3"))
        val client = SupabaseClient(store, "https://mock.supabase.co", "anon", http)
        val repo = TataniRepository(dao, store, client)

        repo.syncAllFromServer()

        val cards = dao.getDeckCardsSnapshot("ja").associateBy { it.word }
        assertEquals(3, cards.size)

        // Crucial H1 check: unstudied below-level words must NOT bake state="known"/knownSource="prior" into SQLite!
        val n5Card = cards.getValue("食べる")
        assertFalse(n5Card.hasServerState)
        assertEquals("unknown", n5Card.state)
        assertNull(n5Card.knownSource)

        fun eligibleWordsForLevel(userLevel: String): Set<String> {
            val userRank = SrsEngine.jlptRank(userLevel)
            return cards.values.filter { c ->
                val below = userRank in 1..50 && SrsEngine.jlptRank(c.level) < userRank
                SrsEngine.isUnlearnedCandidate(
                    hasExistingState = c.hasServerState,
                    state = c.state,
                    preference = c.preference,
                    knownSource = c.knownSource,
                    srsDueAtEpochMs = c.srsDueAtEpochMs,
                    isBelowUserLevel = below,
                )
            }.map { it.word }.toSet()
        }

        // At N3: N5 and N4 are skipped, only N2 is eligible
        assertEquals(setOf("探知"), eligibleWordsForLevel("N3"))

        // User changes level to N4 WITHOUT any server re-sync -> N4 ("魔法") becomes eligible immediately!
        store.updateLanguagePrefs("ja", "N4")
        assertEquals(setOf("魔法", "探知"), eligibleWordsForLevel(store.session.value!!.userLevel))

        // User changes level to "none" WITHOUT any server re-sync -> all 3 words are eligible!
        store.updateLanguagePrefs("ja", "none")
        assertEquals(setOf("食べる", "魔法", "探知"), eligibleWordsForLevel(store.session.value!!.userLevel))
    }

    @Test
    fun undoOfUnlearnedCardRestoresHasServerStateFalseAndDeletesServerRow() = runTest {
        val dao = FakeTataniDao()
        var deleteCalled = false

        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                if (req.url.encodedPath.endsWith("/rest/v1/user_word_state") && req.method == "DELETE") {
                    deleteCalled = true
                    jsonResponse(req, 204, "")
                } else {
                    jsonResponse(req, 201, "")
                }
            }
            .build()

        val store = SessionStore.inMemory(activeSession())
        val client = SupabaseClient(store, "https://mock.supabase.co", "anon", http)
        val repo = TataniRepository(dao, store, client)

        val initial = WordCardEntity(
            word = "冒険",
            learningLanguage = "ja",
            reading = "ぼうけん",
            meaning = "adventure",
            level = "N3",
            hasServerState = false,
            state = "unknown",
        )
        dao.upsertWordCard(initial)

        val prevSnap = repo.gradeCardOptimistic(initial, remembered = true, autoFlush = false)
        assertFalse(prevSnap.hasServerState)
        assertTrue(dao.getWordCard("冒険", "ja")!!.hasServerState)

        val gradedCard = dao.getWordCard("冒険", "ja")!!
        repo.restoreSnapshotOptimistic(gradedCard, prevSnap)
        assertFalse(
            "Undoing a first-time grade must restore hasServerState = false locally",
            dao.getWordCard("冒険", "ja")!!.hasServerState
        )

        assertTrue(repo.flushOutbox())
        assertTrue("Flushing undo of unlearned card must DELETE from user_word_state", deleteCalled)
        assertTrue(dao.getOutboxMutations("user-a").isEmpty())
    }

    @Test
    fun syncPrunesRemovedAnimeUnlearnedOrphansWhileKeepingGraduatedSrsCards() = runTest {
        val dao = FakeTataniDao()
        val graduatedDue = 1_800_000_000_000L
        val graduatedIso = java.time.Instant.ofEpochMilli(graduatedDue).toString()

        // Seed Room with two words from a removed anime: one unlearned orphan, one graduated SRS card
        dao.upsertWordCards(
            listOf(
                WordCardEntity(
                    word = "不要語",
                    learningLanguage = "ja",
                    meaning = "removed unlearned word",
                    hasServerState = false,
                    state = "unknown",
                ),
                WordCardEntity(
                    word = "卒業語",
                    learningLanguage = "ja",
                    meaning = "graduated SRS word",
                    hasServerState = true,
                    state = "known",
                    knownSource = "learned",
                    srsLevel = 3,
                    srsDueAtEpochMs = graduatedDue,
                ),
            )
        )

        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                when {
                    req.url.encodedPath.endsWith("/rest/v1/profiles") ->
                        jsonResponse(req, 200, """[{"user_id":"user-a","learning_language":"ja"}]""")
                    req.url.encodedPath.endsWith("/rest/v1/user_language_progress") ->
                        jsonResponse(req, 200, """[{"learning_language":"ja","level":"none","placement_done":true}]""")
                    req.url.encodedPath.endsWith("/rest/v1/user_word_state") ->
                        jsonResponse(
                            req,
                            200,
                            """[{"word":"卒業語","learning_language":"ja","state":"known","preference":"study","known_source":"learned","correct_streak":4,"srs_level":3,"srs_due_at":"$graduatedIso"}]"""
                        )
                    else -> jsonResponse(req, 200, "[]")
                }
            }
            .build()

        val store = SessionStore.inMemory(activeSession())
        val client = SupabaseClient(store, "https://mock.supabase.co", "anon", http)
        val repo = TataniRepository(dao, store, client)

        repo.syncAllFromServer()

        val remaining = dao.getDeckCardsSnapshot("ja").map { it.word }.toSet()
        assertFalse("Removed anime unlearned orphan must be pruned", "不要語" in remaining)
        assertTrue("Graduated SRS card must be preserved", "卒業語" in remaining)
    }

    @Test
    fun deleteAccountOnlySignsOutWhenServerDeletionSucceeds() = runTest {
        val dao = FakeTataniDao()
        var allowDelete = false
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                if (req.url.encodedPath.endsWith("/functions/v1/delete-account")) {
                    if (allowDelete) jsonResponse(req, 200, """{"ok":true}""")
                    else jsonResponse(req, 500, """{"error":"temporary failure"}""")
                } else {
                    jsonResponse(req, 200, "[]")
                }
            }
            .build()

        val store = SessionStore.inMemory(activeSession())
        val client = SupabaseClient(store, "https://mock.supabase.co", "anon", http)
        val repo = TataniRepository(dao, store, client)

        val failedRes = repo.deleteAccountDataAndSignOut()
        assertTrue(failedRes.isFailure)
        assertNotNull("Session must NOT be cleared if server deletion failed", store.session.value)

        allowDelete = true
        val okRes = repo.deleteAccountDataAndSignOut()
        assertTrue(okRes.isSuccess)
        assertNull("Session must be cleared once server deletion succeeds", store.session.value)
    }
}
