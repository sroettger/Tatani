package app.tatani.android.ui

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.tatani.android.TataniApp
import app.tatani.android.data.local.LibraryEpisodeEntity
import app.tatani.android.data.local.WordCardEntity
import app.tatani.android.data.remote.AnimeSearchResultDto
import app.tatani.android.data.remote.AuthSession
import app.tatani.android.domain.SrsEngine
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class NextLearnTarget(
    val episodeId: String,
    val animeTitle: String,
    val episodeNumber: Int,
    val unlearnedWords: List<WordCardEntity>,
)

@OptIn(ExperimentalCoroutinesApi::class)
class TataniViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as TataniApp
    val repository = app.repository
    val tts = JapaneseTtsManager(application)

    val session: StateFlow<AuthSession?> = app.sessionStore.session
    val syncing: StateFlow<Boolean> = repository.syncing
    val outboxCount: StateFlow<Int> = repository.outboxCount
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    private val _authBusy = MutableStateFlow(false)
    val authBusy: StateFlow<Boolean> = _authBusy.asStateFlow()

    private val _authMessage = MutableStateFlow<String?>(null)
    val authMessage: StateFlow<String?> = _authMessage.asStateFlow()

    val deckCards: StateFlow<List<WordCardEntity>> = session
        .flatMapLatest { s ->
            if (s == null) flowOf(emptyList())
            else repository.observeDeckCards(s.learningLanguage)
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val dueCards: StateFlow<List<WordCardEntity>> = deckCards
        .map { list ->
            val now = System.currentTimeMillis()
            list.filter {
                SrsEngine.isDueForSprint(
                    preference = it.preference,
                    knownSource = it.knownSource,
                    srsDueAtEpochMs = it.srsDueAtEpochMs,
                    nowMs = now,
                )
            }.sortedBy { it.srsDueAtEpochMs ?: 0L }
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

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

    val nextLearnTarget: StateFlow<NextLearnTarget?> = deckCards
        .map { list ->
            val userRank = SrsEngine.jlptRank(session.value?.userLevel)
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
            if (candidates.isEmpty()) return@map null
            val firstEp = candidates.minWithOrNull(
                compareBy<WordCardEntity>({ it.animeOrder }, { it.seasonNumber }, { it.episodeNumber })
            ) ?: return@map null

            val epWords = candidates
                .filter { it.primaryEpisodeId == firstEp.primaryEpisodeId }
                .sortedByDescending { c ->
                    c.frequency * 10 + (6 - SrsEngine.jlptRank(c.level).coerceAtMost(6)).coerceAtLeast(0)
                }

            NextLearnTarget(
                episodeId = firstEp.primaryEpisodeId!!,
                animeTitle = firstEp.animeTitle.ifBlank { "Anime" },
                episodeNumber = firstEp.episodeNumber,
                unlearnedWords = epWords,
            )
        }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    init {
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

    fun signUp(email: String, password: String) {
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

    fun googleOAuthUri(): Uri = app.supabaseClient.buildGoogleOAuthUrl()

    fun onOAuthDeepLink(uri: Uri) {
        viewModelScope.launch {
            _authBusy.value = true
            val ok = app.supabaseClient.handleOAuthRedirect(uri)
            _authBusy.value = false
            if (ok) {
                repository.triggerBackgroundSync()
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

    fun restoreSnapshot(card: WordCardEntity, snapshot: SrsEngine.SrsSnapshot) {
        viewModelScope.launch {
            repository.restoreSnapshotOptimistic(card, snapshot)
        }
    }

    fun refreshSync() {
        repository.triggerBackgroundSync()
    }

    suspend fun searchAnime(query: String): Result<List<AnimeSearchResultDto>> =
        repository.searchAnime(query)

    suspend fun addAnime(anime: AnimeSearchResultDto): Result<Unit> =
        repository.addAnimeAndSync(anime)

    suspend fun processEpisode(episodeId: String): Result<Unit> =
        repository.processEpisodeAndSync(episodeId)

    fun signOut() {
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
