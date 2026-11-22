package app.tatani.android.ui

import android.app.Application
import android.provider.Settings
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.tatani.android.TataniApp
import app.tatani.android.data.local.LibraryEpisodeEntity
import app.tatani.android.data.local.WordCardEntity
import app.tatani.android.data.remote.AnimeSearchResultDto
import app.tatani.android.data.remote.AuthSession
import app.tatani.android.domain.SrsEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class NextLearnTarget(
    val episodeId: String,
    val animeTitle: String,
    val episodeNumber: Int,
    val unlearnedWords: List<WordCardEntity>,
)

data class BatchProcessState(
    val animeId: String,
    val done: Int,
    val total: Int,
    val currentEpisodeNumber: Int,
    val failedCount: Int = 0,
)

data class AddingAnimeState(
    val anilistId: Int,
    val title: String,
    val coverUrl: String?,
    val episodeCount: Int,
)

@OptIn(ExperimentalCoroutinesApi::class)
class TataniViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as TataniApp
    val repository = app.repository
    val tts = JapaneseTtsManager(application)

    val session: StateFlow<AuthSession?> = app.sessionStore.session
    val boostersEnabled: StateFlow<Boolean> = app.sessionStore.boostersEnabled
    val syncing: StateFlow<Boolean> = repository.syncing
    val syncError: StateFlow<String?> = repository.syncError
    val outboxCount: StateFlow<Int> = repository.outboxCount
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    private val _authBusy = MutableStateFlow(false)
    val authBusy: StateFlow<Boolean> = _authBusy.asStateFlow()

    private val _authMessage = MutableStateFlow<String?>(null)
    val authMessage: StateFlow<String?> = _authMessage.asStateFlow()

    private val _processingEpisodeIds = MutableStateFlow<Set<String>>(emptySet())
    val processingEpisodeIds: StateFlow<Set<String>> = _processingEpisodeIds.asStateFlow()

    private val _episodeProcessErrors = MutableStateFlow<Map<String, String>>(emptyMap())
    val episodeProcessErrors: StateFlow<Map<String, String>> = _episodeProcessErrors.asStateFlow()

    private val _batchProcessState = MutableStateFlow<BatchProcessState?>(null)
    val batchProcessState: StateFlow<BatchProcessState?> = _batchProcessState.asStateFlow()
    private var batchProcessJob: Job? = null

    private val _addingAnime = MutableStateFlow<AddingAnimeState?>(null)
    val addingAnime: StateFlow<AddingAnimeState?> = _addingAnime.asStateFlow()

    private val _addAnimeError = MutableStateFlow<String?>(null)
    val addAnimeError: StateFlow<String?> = _addAnimeError.asStateFlow()

    private val foregroundRefreshTick = MutableStateFlow(0L)
    private val minuteTicker = flow {
        while (true) {
            emit(System.currentTimeMillis())
            delay(60_000L)
        }
    }

    val deckCards: StateFlow<List<WordCardEntity>> = session
        .flatMapLatest { s ->
            if (s == null) flowOf(emptyList())
            else repository.observeDeckCards(s.learningLanguage)
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val dailyStreak: StateFlow<Int> = combine(
        deckCards,
        minuteTicker,
        foregroundRefreshTick,
    ) { list, _, _ ->
        val timestamps = ArrayList<String?>(list.size * 2)
        for (c in list) {
            if (!c.lastReviewedAtIso.isNullOrBlank()) timestamps += c.lastReviewedAtIso
            if (c.knownSource == "learned" && !c.markedKnownAtIso.isNullOrBlank()) {
                timestamps += c.markedKnownAtIso
            }
        }
        SrsEngine.computeDailyStreak(timestamps)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    val dueCards: StateFlow<List<WordCardEntity>> = combine(
        deckCards,
        minuteTicker,
        foregroundRefreshTick,
    ) { list, _, _ ->
        val now = System.currentTimeMillis()
        list.filter {
            SrsEngine.isDueForSprint(
                preference = it.preference,
                knownSource = it.knownSource,
                srsDueAtEpochMs = it.srsDueAtEpochMs,
                nowMs = now,
            )
        }.sortedBy { it.srsDueAtEpochMs ?: 0L }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val graduatedCards: StateFlow<List<WordCardEntity>> = deckCards
        .map { list ->
            list.filter {
                SrsEngine.isGraduatedForSrs(
                    preference = it.preference,
                    knownSource = it.knownSource,
                    srsDueAtEpochMs = it.srsDueAtEpochMs,
                )
            }
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val libraryEpisodes: StateFlow<List<LibraryEpisodeEntity>> = session
        .flatMapLatest { s ->
            if (s == null) flowOf(emptyList())
            else repository.observeLibraryEpisodes(s.learningLanguage)
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val nextLearnTarget: StateFlow<NextLearnTarget?> = combine(
        deckCards,
        session,
    ) { list, sess ->
        val userRank = SrsEngine.jlptRank(sess?.userLevel)
        val candidates = list.filter { c ->
            val below = userRank in 1..50 && SrsEngine.jlptRank(c.level) < userRank
            SrsEngine.isUnlearnedCandidate(
                hasExistingState = c.hasServerState,
                state = c.state,
                preference = c.preference,
                knownSource = c.knownSource,
                srsDueAtEpochMs = c.srsDueAtEpochMs,
                isBelowUserLevel = below,
            ) && !c.primaryEpisodeId.isNullOrBlank()
        }
        if (candidates.isEmpty()) return@combine null
        val firstEp = candidates.minWithOrNull(
            compareBy<WordCardEntity>({ it.animeOrder }, { it.seasonNumber }, { it.episodeNumber })
        ) ?: return@combine null

        val epWords = candidates
            .filter { it.primaryEpisodeId == firstEp.primaryEpisodeId }
            .sortedByDescending { c ->
                c.frequency * 10 + (7 - SrsEngine.jlptRank(c.level).coerceAtMost(7)).coerceAtLeast(0)
            }

        NextLearnTarget(
            episodeId = firstEp.primaryEpisodeId!!,
            animeTitle = firstEp.animeTitle.ifBlank { "Anime" },
            episodeNumber = firstEp.episodeNumber,
            unlearnedWords = epWords,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    fun onAppForegrounded() {
        foregroundRefreshTick.value = System.currentTimeMillis()
        if (session.value != null) {
            repository.triggerBackgroundSync()
        }
    }

    fun signIn(email: String, password: String) {
        viewModelScope.launch {
            _authBusy.value = true
            _authMessage.value = null
            val res = app.supabaseClient.signInWithEmail(email, password)
            _authBusy.value = false
            res.onSuccess {
                repository.triggerBackgroundSync()
            }.onFailure { err ->
                _authMessage.value = err.message ?: "Sign-in failed"
            }
        }
    }

    private fun isRunningInFirebaseTestLab(): Boolean =
        runCatching {
            Settings.System.getString(app.contentResolver, "firebase.test.lab") == "true"
        }.getOrDefault(false)

    fun signUp(email: String, password: String) {
        if (isRunningInFirebaseTestLab()) {
            _authMessage.value = "Automated test device detected — sign-up disabled during Pre-Launch crawl."
            return
        }
        viewModelScope.launch {
            _authBusy.value = true
            _authMessage.value = null
            val res = app.supabaseClient.signUpWithEmail(email, password)
            _authBusy.value = false
            res.onSuccess { immediate ->
                if (immediate) {
                    repository.triggerBackgroundSync()
                } else {
                    _authMessage.value = "Check your email to confirm your account, then sign in."
                }
            }.onFailure { err ->
                _authMessage.value = err.message ?: "Sign-up failed"
            }
        }
    }

    fun googleOAuthUrl(): String = app.supabaseClient.buildGoogleOAuthUrl()

    fun onOAuthDeepLink(urlString: String) {
        viewModelScope.launch {
            _authBusy.value = true
            _authMessage.value = null
            val res = app.supabaseClient.handleOAuthRedirect(urlString)
            _authBusy.value = false
            res.onSuccess {
                repository.triggerBackgroundSync()
            }.onFailure { err ->
                _authMessage.value = err.message ?: "Google sign-in failed"
            }
        }
    }

    fun gradeCard(
        card: WordCardEntity,
        remembered: Boolean,
        onPreviousReady: (SrsEngine.SrsSnapshot) -> Unit = {},
    ) {
        viewModelScope.launch {
            val prev = repository.gradeCardOptimistic(card, remembered)
            onPreviousReady(prev)
        }
    }

    fun markPriorKnown(card: WordCardEntity) {
        viewModelScope.launch {
            repository.markPriorKnownOptimistic(card)
        }
    }

    fun restudyCard(card: WordCardEntity) {
        viewModelScope.launch {
            repository.restudyCardOptimistic(card)
        }
    }

    fun restoreSnapshot(card: WordCardEntity, snapshot: SrsEngine.SrsSnapshot) {
        viewModelScope.launch {
            repository.restoreSnapshotOptimistic(card, snapshot)
        }
    }

    fun refreshSync() {
        foregroundRefreshTick.value = System.currentTimeMillis()
        repository.triggerBackgroundSync()
    }

    fun setBoostersEnabled(enabled: Boolean) {
        app.sessionStore.setBoostersEnabled(enabled)
    }

    suspend fun updateUserLevel(level: String): Result<Unit> =
        repository.updateUserLevelAndSync(level)

    suspend fun updateLearningLanguage(lang: String): Result<Unit> =
        repository.updateLearningLanguageAndSync(lang)

    suspend fun searchAnime(query: String): Result<List<AnimeSearchResultDto>> =
        repository.searchAnime(query)

    suspend fun addAnime(anime: AnimeSearchResultDto): Result<Unit> =
        repository.addAnimeAndSync(anime)

    fun clearAddAnimeError() {
        _addAnimeError.value = null
    }

    /**
     * Adds [anime] inside [viewModelScope] so dismissing the Add Anime dialog never cancels
     * the server call or catalog sync, while surfacing live progress in both the modal and Library.
     */
    fun enqueueAddAnime(anime: AnimeSearchResultDto, onSuccess: () -> Unit = {}) {
        if (_addingAnime.value != null) return
        viewModelScope.launch {
            _addAnimeError.value = null
            _addingAnime.value = AddingAnimeState(
                anilistId = anime.anilistId,
                title = anime.titleEn?.takeIf { it.isNotBlank() } ?: anime.titleRomaji,
                coverUrl = anime.coverUrl,
                episodeCount = anime.episodeCount,
            )
            try {
                repository.addAnimeAndSync(anime)
                    .onSuccess { onSuccess() }
                    .onFailure { err ->
                        _addAnimeError.value = err.message ?: "Couldn't add anime"
                    }
            } finally {
                _addingAnime.value = null
            }
        }
    }

    suspend fun removeAnime(animeId: String): Result<Unit> =
        repository.removeAnimeAndSync(animeId)

    fun processEpisode(episodeId: String, onFinished: (Result<Unit>) -> Unit = {}) {
        if (episodeId in _processingEpisodeIds.value) return
        viewModelScope.launch {
            _processingEpisodeIds.update { it + episodeId }
            _episodeProcessErrors.update { it - episodeId }
            try {
                val res = repository.processEpisodeAndSync(episodeId)
                res.onFailure { err ->
                    _episodeProcessErrors.update {
                        it + (episodeId to (err.message ?: "Episode processing failed"))
                    }
                }
                onFinished(res)
            } finally {
                _processingEpisodeIds.update { it - episodeId }
            }
        }
    }

    /**
     * Sequentially processes all unprocessed episodes for [animeId] in watch order
     * (Season 1 Ep 1 -> Ep 2 -> ...), syncing Room after every episode so Episode 1 is
     * study-ready within seconds while later episodes finish in the background without
     * exceeding AI rate limits.
     */
    fun processAllEpisodes(animeId: String) {
        if (batchProcessJob?.isActive == true) return
        val targets = libraryEpisodes.value
            .filter {
                it.animeId == animeId &&
                    !it.episodeId.startsWith("placeholder:") &&
                    it.processingStatus != "ready"
            }
            .sortedWith(compareBy<LibraryEpisodeEntity>({ it.seasonNumber }, { it.episodeNumber }))
        if (targets.isEmpty()) return

        batchProcessJob = viewModelScope.launch {
            var done = 0
            var failed = 0
            try {
                for ((idx, ep) in targets.withIndex()) {
                    if (!isActive) break
                    _batchProcessState.value = BatchProcessState(
                        animeId = animeId,
                        done = done,
                        total = targets.size,
                        currentEpisodeNumber = ep.episodeNumber,
                        failedCount = failed,
                    )
                    if (ep.episodeId in _processingEpisodeIds.value) {
                        done++
                        continue
                    }
                    _processingEpisodeIds.update { it + ep.episodeId }
                    _episodeProcessErrors.update { it - ep.episodeId }
                    var wasCached = false
                    try {
                        val res = repository.processEpisodeDetailedAndSync(ep.episodeId)
                        res.onSuccess { cached ->
                            wasCached = cached
                        }.onFailure { err ->
                            failed++
                            _episodeProcessErrors.update {
                                it + (ep.episodeId to (err.message ?: "Episode processing failed"))
                            }
                        }
                    } finally {
                        _processingEpisodeIds.update { it - ep.episodeId }
                    }
                    done++
                    _batchProcessState.value = BatchProcessState(
                        animeId = animeId,
                        done = done,
                        total = targets.size,
                        currentEpisodeNumber = ep.episodeNumber,
                        failedCount = failed,
                    )
                    // Pace uncached AI calls smoothly below Free Tier 15 RPM while allowing instant cache sweeps
                    if (!wasCached && idx + 1 < targets.size && isActive) {
                        delay(1_250L)
                    }
                }
            } catch (ce: CancellationException) {
                throw ce
            } finally {
                _batchProcessState.value = null
                batchProcessJob = null
            }
        }
    }

    fun cancelProcessAll() {
        batchProcessJob?.cancel()
        batchProcessJob = null
        _batchProcessState.value = null
    }

    fun processEpisodeManual(
        episodeId: String,
        subtitleText: String,
        onFinished: (Result<Unit>) -> Unit = {},
    ) {
        if (episodeId in _processingEpisodeIds.value) return
        viewModelScope.launch {
            _processingEpisodeIds.update { it + episodeId }
            _episodeProcessErrors.update { it - episodeId }
            try {
                val res = repository.processEpisodeManualAndSync(episodeId, subtitleText)
                res.onFailure { err ->
                    _episodeProcessErrors.update {
                        it + (episodeId to (err.message ?: "Subtitle processing failed"))
                    }
                }
                onFinished(res)
            } finally {
                _processingEpisodeIds.update { it - episodeId }
            }
        }
    }

    fun clearEpisodeProcessError(episodeId: String) {
        _episodeProcessErrors.update { it - episodeId }
    }

    fun signOut() {
        cancelProcessAll()
        viewModelScope.launch {
            repository.signOut()
        }
    }

    suspend fun deleteAccountData(): Result<Unit> =
        repository.deleteAccountDataAndSignOut()

    override fun onCleared() {
        super.onCleared()
        tts.shutdown()
    }
}
