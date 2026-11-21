package app.tatani.android.data.remote

import android.net.Uri
import app.tatani.android.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class SupabaseClient(
    private val sessionStore: SessionStore,
) {
    private val baseUrl = BuildConfig.SUPABASE_URL.trimEnd('/')
    private val anonKey = BuildConfig.SUPABASE_ANON_KEY
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val refreshMutex = Mutex()

    val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    fun buildGoogleOAuthUrl(): Uri {
        return "$baseUrl/auth/v1/authorize".toHttpUrl().newBuilder()
            .addQueryParameter("provider", "google")
            .addQueryParameter("redirect_to", "tatani://auth-callback")
            .build()
            .toString()
            .let(Uri::parse)
    }

    suspend fun handleOAuthRedirect(uri: Uri): Boolean = withContext(Dispatchers.IO) {
        val fragment = uri.fragment ?: return@withContext false
        val params = fragment.split("&").mapNotNull { part ->
            val idx = part.indexOf("=")
            if (idx <= 0) null else Uri.decode(part.substring(0, idx)) to Uri.decode(part.substring(idx + 1))
        }.toMap()

        val access = params["access_token"] ?: return@withContext false
        val refresh = params["refresh_token"] ?: ""
        val expiresIn = params["expires_in"]?.toLongOrNull() ?: 3600L

        val userReq = Request.Builder()
            .url("$baseUrl/auth/v1/user")
            .header("apikey", anonKey)
            .header("Authorization", "Bearer $access")
            .get()
            .build()

        http.newCall(userReq).execute().use { resp ->
            if (!resp.isSuccessful) return@withContext false
            val body = resp.body?.string().orEmpty()
            val user = json.decodeFromString<AuthUserDto>(body)
            sessionStore.saveSession(
                AuthSession(
                    userId = user.id,
                    email = user.email,
                    accessToken = access,
                    refreshToken = refresh,
                    expiresAtEpochSec = System.currentTimeMillis() / 1000L + expiresIn,
                )
            )
            return@withContext true
        }
    }

    suspend fun signInWithEmail(email: String, password: String): Result<AuthSession> =
        withContext(Dispatchers.IO) {
            runCatching {
                val payload = buildJsonObject {
                    put("email", email.trim())
                    put("password", password)
                }.toString()

                val req = Request.Builder()
                    .url("$baseUrl/auth/v1/token?grant_type=password")
                    .header("apikey", anonKey)
                    .post(payload.toRequestBody(jsonMedia))
                    .build()

                http.newCall(req).execute().use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    val parsed = runCatching { json.decodeFromString<AuthTokenResponseDto>(raw) }.getOrNull()
                    if (!resp.isSuccessful || parsed?.accessToken == null || parsed.user == null) {
                        val msg = parsed?.errorDescription ?: parsed?.msg ?: "Sign-in failed (${resp.code})"
                        error(msg)
                    }
                    val session = AuthSession(
                        userId = parsed.user.id,
                        email = parsed.user.email ?: email.trim(),
                        accessToken = parsed.accessToken,
                        refreshToken = parsed.refreshToken.orEmpty(),
                        expiresAtEpochSec = System.currentTimeMillis() / 1000L + parsed.expiresIn,
                    )
                    sessionStore.saveSession(session)
                    session
                }
            }
        }

    suspend fun signUpWithEmail(email: String, password: String): Result<Boolean> =
        withContext(Dispatchers.IO) {
            runCatching {
                val payload = buildJsonObject {
                    put("email", email.trim())
                    put("password", password)
                }.toString()

                val req = Request.Builder()
                    .url("$baseUrl/auth/v1/signup")
                    .header("apikey", anonKey)
                    .post(payload.toRequestBody(jsonMedia))
                    .build()

                http.newCall(req).execute().use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    val parsed = runCatching { json.decodeFromString<AuthTokenResponseDto>(raw) }.getOrNull()
                    if (!resp.isSuccessful) {
                        error(parsed?.errorDescription ?: parsed?.msg ?: "Sign-up failed (${resp.code})")
                    }
                    if (parsed?.accessToken != null && parsed.user != null) {
                        sessionStore.saveSession(
                            AuthSession(
                                userId = parsed.user.id,
                                email = parsed.user.email ?: email.trim(),
                                accessToken = parsed.accessToken,
                                refreshToken = parsed.refreshToken.orEmpty(),
                                expiresAtEpochSec = System.currentTimeMillis() / 1000L + parsed.expiresIn,
                            )
                        )
                        true // signed in immediately
                    } else {
                        false // confirmation email sent
                    }
                }
            }
        }

    private suspend fun validToken(): String? {
        val current = sessionStore.session.value ?: return null
        val nowSec = System.currentTimeMillis() / 1000L
        if (current.expiresAtEpochSec - nowSec > 90L || current.refreshToken.isBlank()) {
            return current.accessToken
        }
        return refreshMutex.withLock {
            val freshCheck = sessionStore.session.value ?: return@withLock null
            if (freshCheck.expiresAtEpochSec - (System.currentTimeMillis() / 1000L) > 90L) {
                return@withLock freshCheck.accessToken
            }
            withContext(Dispatchers.IO) {
                val payload = buildJsonObject {
                    put("refresh_token", freshCheck.refreshToken)
                }.toString()
                val req = Request.Builder()
                    .url("$baseUrl/auth/v1/token?grant_type=refresh_token")
                    .header("apikey", anonKey)
                    .post(payload.toRequestBody(jsonMedia))
                    .build()
                runCatching {
                    http.newCall(req).execute().use { resp ->
                        if (!resp.isSuccessful) return@use freshCheck.accessToken
                        val raw = resp.body?.string().orEmpty()
                        val parsed = json.decodeFromString<AuthTokenResponseDto>(raw)
                        if (parsed.accessToken != null) {
                            val updated = freshCheck.copy(
                                accessToken = parsed.accessToken,
                                refreshToken = parsed.refreshToken ?: freshCheck.refreshToken,
                                expiresAtEpochSec = System.currentTimeMillis() / 1000L + parsed.expiresIn,
                            )
                            sessionStore.saveSession(updated)
                            updated.accessToken
                        } else {
                            freshCheck.accessToken
                        }
                    }
                }.getOrDefault(freshCheck.accessToken)
            }
        }
    }

    suspend fun fetchProfileAndProgress(userId: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val token = validToken() ?: return@withContext ("ja" to "none")
        val profReq = Request.Builder()
            .url("$baseUrl/rest/v1/profiles?user_id=eq.$userId&select=user_id,learning_language,ui_language")
            .header("apikey", anonKey)
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        val lang = runCatching {
            http.newCall(profReq).execute().use { resp ->
                if (!resp.isSuccessful) "ja"
                else json.decodeFromString<List<ProfileDto>>(resp.body?.string().orEmpty())
                    .firstOrNull()?.learningLanguage ?: "ja"
            }
        }.getOrDefault("ja")

        val progReq = Request.Builder()
            .url("$baseUrl/rest/v1/user_language_progress?user_id=eq.$userId&learning_language=eq.$lang&select=learning_language,level,placement_done")
            .header("apikey", anonKey)
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        val lvl = runCatching {
            http.newCall(progReq).execute().use { resp ->
                if (!resp.isSuccessful) "none"
                else json.decodeFromString<List<LanguageProgressDto>>(resp.body?.string().orEmpty())
                    .firstOrNull()?.level ?: "none"
            }
        }.getOrDefault("none")

        sessionStore.updateLanguagePrefs(lang, lvl)
        lang to lvl
    }

    suspend fun fetchWordStates(userId: String, lang: String): List<UserWordStateDto> =
        withContext(Dispatchers.IO) {
            val token = validToken() ?: return@withContext emptyList()
            val req = Request.Builder()
                .url(
                    "$baseUrl/rest/v1/user_word_state" +
                        "?user_id=eq.$userId&learning_language=eq.$lang" +
                        "&select=word,reading,level,learning_language,state,preference,known_source,correct_streak,srs_level,srs_due_at,last_reviewed_at,marked_known_at"
                )
                .header("apikey", anonKey)
                .header("Authorization", "Bearer $token")
                .get()
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) emptyList()
                else json.decodeFromString(resp.body?.string().orEmpty())
            }
        }

    suspend fun upsertWordStates(rows: List<UserWordStateDto>): Boolean =
        withContext(Dispatchers.IO) {
            if (rows.isEmpty()) return@withContext true
            val token = validToken() ?: return@withContext false
            val body = json.encodeToString(rows)
            val req = Request.Builder()
                .url("$baseUrl/rest/v1/user_word_state?on_conflict=user_id,word,learning_language")
                .header("apikey", anonKey)
                .header("Authorization", "Bearer $token")
                .header("Prefer", "resolution=merge-duplicates,return=minimal")
                .post(body.toRequestBody(jsonMedia))
                .build()
            http.newCall(req).execute().use { resp -> resp.isSuccessful }
        }

    suspend fun fetchUserAnime(userId: String, lang: String): List<UserAnimeRowDto> =
        withContext(Dispatchers.IO) {
            val token = validToken() ?: return@withContext emptyList()
            val url = "$baseUrl/rest/v1/user_anime".toHttpUrl().newBuilder()
                .addQueryParameter("user_id", "eq.$userId")
                .addQueryParameter("learning_language", "eq.$lang")
                .addQueryParameter("select", "position,anime:anime_id(id,title_romaji,title_en,title_jp,cover_url)")
                .addQueryParameter("order", "position.asc")
                .build()
            val req = Request.Builder()
                .url(url)
                .header("apikey", anonKey)
                .header("Authorization", "Bearer $token")
                .get()
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) emptyList()
                else json.decodeFromString(resp.body?.string().orEmpty())
            }
        }

    suspend fun fetchEpisodesForAnimeIds(animeIds: List<String>): List<EpisodeRowDto> =
        withContext(Dispatchers.IO) {
            if (animeIds.isEmpty()) return@withContext emptyList()
            val token = validToken() ?: return@withContext emptyList()
            val inList = animeIds.joinToString(",")
            val url = "$baseUrl/rest/v1/episodes".toHttpUrl().newBuilder()
                .addQueryParameter("seasons.anime_id", "in.($inList)")
                .addQueryParameter("select", "id,episode_number,processing_status,seasons!inner(anime_id,season_number)")
                .build()
            val req = Request.Builder()
                .url(url)
                .header("apikey", anonKey)
                .header("Authorization", "Bearer $token")
                .get()
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) emptyList()
                else json.decodeFromString(resp.body?.string().orEmpty())
            }
        }

    suspend fun fetchEpisodeVocabCaches(episodeIds: List<String>, lang: String): List<EpisodeVocabCacheDto> =
        withContext(Dispatchers.IO) {
            if (episodeIds.isEmpty()) return@withContext emptyList()
            val token = validToken() ?: return@withContext emptyList()
            val out = mutableListOf<EpisodeVocabCacheDto>()
            for (batch in episodeIds.chunked(25)) {
                val inList = batch.joinToString(",")
                val url = "$baseUrl/rest/v1/episode_vocab_cache".toHttpUrl().newBuilder()
                    .addQueryParameter("episode_id", "in.($inList)")
                    .addQueryParameter("language", "eq.$lang")
                    .addQueryParameter("select", "episode_id,vocab")
                    .build()
                val req = Request.Builder()
                    .url(url)
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer $token")
                    .get()
                    .build()
                http.newCall(req).execute().use { resp ->
                    if (resp.isSuccessful) {
                        out += json.decodeFromString<List<EpisodeVocabCacheDto>>(resp.body?.string().orEmpty())
                    }
                }
            }
            out
        }

    suspend fun fetchChunkWords(userId: String, lang: String): List<StudyChunkWordDto> =
        withContext(Dispatchers.IO) {
            val token = validToken() ?: return@withContext emptyList()
            val chunkUrl = "$baseUrl/rest/v1/study_chunks".toHttpUrl().newBuilder()
                .addQueryParameter("user_id", "eq.$userId")
                .addQueryParameter("learning_language", "eq.$lang")
                .addQueryParameter("select", "id")
                .addQueryParameter("limit", "100")
                .build()
            val chunkIds = http.newCall(
                Request.Builder()
                    .url(chunkUrl)
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer $token")
                    .get()
                    .build()
            ).execute().use { resp ->
                if (!resp.isSuccessful) emptyList()
                else json.decodeFromString<List<StudyChunkIdDto>>(resp.body?.string().orEmpty()).map { it.id }
            }
            if (chunkIds.isEmpty()) return@withContext emptyList()

            val wordsUrl = "$baseUrl/rest/v1/study_chunk_words".toHttpUrl().newBuilder()
                .addQueryParameter("chunk_id", "in.(${chunkIds.joinToString(",")})")
                .addQueryParameter("select", "word,reading,meaning,part_of_speech,level,example_sentence_jp,example_sentence_en")
                .build()
            http.newCall(
                Request.Builder()
                    .url(wordsUrl)
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer $token")
                    .get()
                    .build()
            ).execute().use { resp ->
                if (!resp.isSuccessful) emptyList()
                else json.decodeFromString(resp.body?.string().orEmpty())
            }
        }

    suspend fun searchAnime(query: String): Result<List<AnimeSearchResultDto>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val token = validToken() ?: error("Not signed in")
                val payload = buildJsonObject { put("query", query.trim()) }.toString()
                val req = Request.Builder()
                    .url("$baseUrl/functions/v1/search-anime")
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer $token")
                    .post(payload.toRequestBody(jsonMedia))
                    .build()
                http.newCall(req).execute().use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    val parsed = json.decodeFromString<SearchAnimeResponseDto>(raw)
                    if (!resp.isSuccessful) error(parsed.error ?: "Search failed (${resp.code})")
                    parsed.results
                }
            }
        }

    suspend fun addAnimeToLibrary(anime: AnimeSearchResultDto, lang: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val token = validToken() ?: error("Not signed in")
                val bodyObj = buildJsonObject {
                    put("learning_language", lang)
                    put(
                        "anime",
                        json.parseToJsonElement(json.encodeToString(anime))
                    )
                }.toString()
                val req = Request.Builder()
                    .url("$baseUrl/functions/v1/add-anime-to-library")
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer $token")
                    .post(bodyObj.toRequestBody(jsonMedia))
                    .build()
                http.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) error("Couldn't add anime (${resp.code})")
                }
            }
        }

    suspend fun autoFetchAndProcessEpisode(episodeId: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val token = validToken() ?: error("Not signed in")
                val fetchPayload = buildJsonObject { put("episode_id", episodeId) }.toString()
                val fetchReq = Request.Builder()
                    .url("$baseUrl/functions/v1/fetch-subtitles")
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer $token")
                    .post(fetchPayload.toRequestBody(jsonMedia))
                    .build()

                val subtitleContent = http.newCall(fetchReq).execute().use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    val parsed = runCatching { json.decodeFromString<FetchSubtitlesResponseDto>(raw) }.getOrNull()
                    if (!resp.isSuccessful || parsed?.found != true || parsed.content.isNullOrBlank()) {
                        error(parsed?.error ?: "No subtitles found automatically for this episode.")
                    }
                    parsed.content
                }

                val procPayload = buildJsonObject {
                    put("episode_id", episodeId)
                    put("subtitle_text", subtitleContent)
                }.toString()
                val procReq = Request.Builder()
                    .url("$baseUrl/functions/v1/process-episode")
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer $token")
                    .post(procPayload.toRequestBody(jsonMedia))
                    .build()
                http.newCall(procReq).execute().use { resp ->
                    if (!resp.isSuccessful) error("Episode processing failed (${resp.code})")
                }
            }
        }

    suspend fun deleteAllUserData(userId: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val token = validToken() ?: error("Not signed in")
                val tables = listOf(
                    "quiz_results",
                    "study_sessions",
                    "study_chunks",
                    "user_word_state",
                    "user_anime",
                    "flashcard_push_devices",
                    "user_language_progress",
                )
                for (table in tables) {
                    val req = Request.Builder()
                        .url("$baseUrl/rest/v1/$table?user_id=eq.$userId")
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .delete()
                        .build()
                    http.newCall(req).execute().close()
                }
            }
        }
}
