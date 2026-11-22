package app.tatani.android.data.remote

import app.tatani.android.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.InetAddress
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.net.UnknownHostException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

class SupabaseClient(
    private val sessionStore: SessionStore,
    baseUrl: String = BuildConfig.SUPABASE_URL,
    private val anonKey: String = BuildConfig.SUPABASE_ANON_KEY,
    httpClient: OkHttpClient? = null,
) {
    private val baseUrl = baseUrl.trimEnd('/')
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val refreshMutex = Mutex()
    private val secureRandom = SecureRandom()

    val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val postgrestWriteJson = Json(json) {
        explicitNulls = true
        encodeDefaults = true
    }

    private val fallbackDns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            try {
                return Dns.SYSTEM.lookup(hostname)
            } catch (sysErr: UnknownHostException) {
                val resolved = runCatching { resolveViaCloudflareDoh(hostname) }.getOrNull().orEmpty()
                if (resolved.isNotEmpty()) return resolved
                throw sysErr
            }
        }

        private fun resolveViaCloudflareDoh(hostname: String): List<InetAddress> {
            val encodedHost = URLEncoder.encode(hostname, StandardCharsets.UTF_8.name())
            val conn = (URL("https://1.1.1.1/dns-query?name=$encodedHost&type=A")
                .openConnection() as HttpsURLConnection).apply {
                connectTimeout = 5000
                readTimeout = 5000
                setRequestProperty("Accept", "application/dns-json")
            }
            return try {
                if (conn.responseCode !in 200..299) return emptyList()
                val raw = conn.inputStream.bufferedReader().use { it.readText() }
                val root = json.parseToJsonElement(raw).jsonObject
                val answers = root["Answer"]?.jsonArray ?: return emptyList()
                answers.mapNotNull { item ->
                    val obj = item.jsonObject
                    val type = obj["type"]?.jsonPrimitive?.content?.toIntOrNull()
                    val ip = obj["data"]?.jsonPrimitive?.content
                    if (type == 1 && !ip.isNullOrBlank()) InetAddress.getByName(ip) else null
                }
            } finally {
                conn.disconnect()
            }
        }
    }

    private val http: OkHttpClient = httpClient ?: OkHttpClient.Builder()
        .dns(fallbackDns)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    fun buildGoogleOAuthUrl(): String {
        val verifierBytes = ByteArray(32)
        secureRandom.nextBytes(verifierBytes)
        val verifier = Base64.getUrlEncoder().withoutPadding().encodeToString(verifierBytes)
        sessionStore.savePkceVerifier(verifier)

        val digest = MessageDigest.getInstance("SHA-256")
            .digest(verifier.toByteArray(StandardCharsets.US_ASCII))
        val challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(digest)

        return "$baseUrl/auth/v1/authorize".toHttpUrl().newBuilder()
            .addQueryParameter("provider", "google")
            .addQueryParameter("redirect_to", "tatani://auth-callback")
            .addQueryParameter("code_challenge", challenge)
            .addQueryParameter("code_challenge_method", "S256")
            .build()
            .toString()
    }

    suspend fun handleOAuthRedirect(urlString: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val normalized = urlString.trim()
                .replaceFirst(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://"), "https://")
            val parsedUrl = normalized.toHttpUrlOrNull()
                ?: error("Invalid OAuth callback URL")

            val fragmentParams = parseFormParams(parsedUrl.encodedFragment)
            val errDesc = parsedUrl.queryParameter("error_description")
                ?: fragmentParams["error_description"]
            val errCode = parsedUrl.queryParameter("error")
                ?: fragmentParams["error"]
            if (!errDesc.isNullOrBlank() || !errCode.isNullOrBlank()) {
                sessionStore.consumePkceVerifier()
                error(errDesc ?: errCode ?: "OAuth sign-in failed")
            }

            val code = parsedUrl.queryParameter("code")
            if (!code.isNullOrBlank()) {
                val verifier = sessionStore.consumePkceVerifier()
                    ?: error("Missing OAuth PKCE verifier. Please try signing in again.")
                val payload = buildJsonObject {
                    put("auth_code", code)
                    put("code_verifier", verifier)
                }.toString()
                val req = Request.Builder()
                    .url("$baseUrl/auth/v1/token?grant_type=pkce")
                    .header("apikey", anonKey)
                    .post(payload.toRequestBody(jsonMedia))
                    .build()
                http.newCall(req).execute().use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    val parsed = runCatching { json.decodeFromString<AuthTokenResponseDto>(raw) }.getOrNull()
                    if (!resp.isSuccessful || parsed?.accessToken == null || parsed.user == null) {
                        error(
                            parsed?.errorDescription
                                ?: parsed?.msg
                                ?: parsed?.error
                                ?: "OAuth token exchange failed (${resp.code})"
                        )
                    }
                    sessionStore.saveSession(
                        AuthSession(
                            userId = parsed.user.id,
                            email = parsed.user.email,
                            accessToken = parsed.accessToken,
                            refreshToken = parsed.refreshToken.orEmpty(),
                            expiresAtEpochSec = System.currentTimeMillis() / 1000L + parsed.expiresIn,
                        )
                    )
                }
                return@runCatching
            }

            sessionStore.consumePkceVerifier()
            val access = fragmentParams["access_token"]
                ?: error("OAuth callback did not contain an authorization code or access token.")
            val refresh = fragmentParams["refresh_token"].orEmpty()
            val expiresIn = fragmentParams["expires_in"]?.toLongOrNull() ?: 3600L

            val userReq = Request.Builder()
                .url("$baseUrl/auth/v1/user")
                .header("apikey", anonKey)
                .header("Authorization", "Bearer $access")
                .get()
                .build()

            http.newCall(userReq).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    error("Failed to verify OAuth session (${resp.code})")
                }
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
            }
        }
    }

    private fun parseFormParams(encoded: String?): Map<String, String> {
        if (encoded.isNullOrBlank()) return emptyMap()
        return encoded.split("&").mapNotNull { part ->
            val idx = part.indexOf("=")
            if (idx <= 0) null
            else {
                val k = URLDecoder.decode(part.substring(0, idx), StandardCharsets.UTF_8.name())
                val v = URLDecoder.decode(part.substring(idx + 1), StandardCharsets.UTF_8.name())
                k to v
            }
        }.toMap()
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
                        val msg = parsed?.errorDescription
                            ?: parsed?.msg
                            ?: parsed?.error
                            ?: "Sign-in failed (${resp.code})"
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
                val cleanedEmail = email.trim()
                val domain = cleanedEmail.substringAfterLast('@', "").lowercase()
                if (!domain.contains('.') ||
                    domain in setOf("example.com", "example.org", "example.net", "test.com", "localhost", "invalid") ||
                    domain.endsWith(".invalid") ||
                    domain.endsWith(".test") ||
                    domain.endsWith(".example")
                ) {
                    error("Please enter a valid personal email address.")
                }

                val payload = buildJsonObject {
                    put("email", cleanedEmail)
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
                        error(
                            parsed?.errorDescription
                                ?: parsed?.msg
                                ?: parsed?.error
                                ?: "Sign-up failed (${resp.code})"
                        )
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

    private suspend fun validToken(force: Boolean = false): String? {
        val current = sessionStore.session.value ?: return null
        val nowSec = System.currentTimeMillis() / 1000L
        if (!force && current.expiresAtEpochSec - nowSec > 90L) {
            return current.accessToken
        }
        if (current.refreshToken.isBlank()) {
            return if (force || current.expiresAtEpochSec <= nowSec) null else current.accessToken
        }
        return refreshMutex.withLock {
            val freshCheck = sessionStore.session.value ?: return@withLock null
            val freshNow = System.currentTimeMillis() / 1000L
            if (!force && freshCheck.expiresAtEpochSec - freshNow > 90L) {
                return@withLock freshCheck.accessToken
            }
            if (force && freshCheck.accessToken != current.accessToken &&
                freshCheck.expiresAtEpochSec - freshNow > 90L
            ) {
                return@withLock freshCheck.accessToken
            }
            if (freshCheck.refreshToken.isBlank()) {
                return@withLock null
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
                try {
                    http.newCall(req).execute().use { resp ->
                        if (resp.code == 400 || resp.code == 401) {
                            sessionStore.clear()
                            return@use null
                        }
                        if (!resp.isSuccessful) {
                            return@use if (!force && freshCheck.expiresAtEpochSec > System.currentTimeMillis() / 1000L) {
                                freshCheck.accessToken
                            } else {
                                null
                            }
                        }
                        val raw = resp.body?.string().orEmpty()
                        val parsed = json.decodeFromString<AuthTokenResponseDto>(raw)
                        val newAccess = parsed.accessToken ?: return@use null
                        val latest = sessionStore.session.value
                        if (latest == null || latest.userId != freshCheck.userId) {
                            return@use null
                        }
                        val updated = latest.copy(
                            accessToken = newAccess,
                            refreshToken = parsed.refreshToken?.takeIf { it.isNotBlank() } ?: latest.refreshToken,
                            expiresAtEpochSec = System.currentTimeMillis() / 1000L + parsed.expiresIn,
                            learningLanguage = latest.learningLanguage,
                            userLevel = latest.userLevel,
                        )
                        sessionStore.saveSession(updated)
                        updated.accessToken
                    }
                } catch (_: IOException) {
                    if (!force && freshCheck.expiresAtEpochSec > System.currentTimeMillis() / 1000L) {
                        freshCheck.accessToken
                    } else {
                        null
                    }
                }
            }
        }
    }

    private suspend fun executeAuthenticated(buildRequest: (token: String) -> Request): Response {
        val token = validToken(force = false) ?: throw IOException("Not signed in")
        val first = http.newCall(buildRequest(token)).execute()
        if (first.code != 401) return first
        first.close()
        val refreshed = validToken(force = true) ?: throw IOException("Session expired (401)")
        return http.newCall(buildRequest(refreshed)).execute()
    }

    suspend fun fetchProfileAndProgress(userId: String): Pair<String, String> = withContext(Dispatchers.IO) {
        val profUrl = "$baseUrl/rest/v1/profiles".toHttpUrl().newBuilder()
            .addQueryParameter("user_id", "eq.$userId")
            .addQueryParameter("select", "user_id,learning_language,ui_language")
            .build()

        val lang = executeAuthenticated { token ->
            Request.Builder()
                .url(profUrl)
                .header("apikey", anonKey)
                .header("Authorization", "Bearer $token")
                .get()
                .build()
        }.use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IOException("Profile fetch failed (${resp.code}): ${raw.take(180)}")
            }
            json.decodeFromString<List<ProfileDto>>(raw)
                .firstOrNull()?.learningLanguage ?: "ja"
        }

        val lvl = fetchLanguageLevel(userId, lang)
        if (sessionStore.session.value?.userId == userId) {
            sessionStore.updateLanguagePrefs(lang, lvl)
        }
        lang to lvl
    }

    private suspend fun fetchLanguageLevel(userId: String, lang: String): String {
        val progUrl = "$baseUrl/rest/v1/user_language_progress".toHttpUrl().newBuilder()
            .addQueryParameter("user_id", "eq.$userId")
            .addQueryParameter("learning_language", "eq.$lang")
            .addQueryParameter("select", "learning_language,level,placement_done")
            .build()

        return executeAuthenticated { token ->
            Request.Builder()
                .url(progUrl)
                .header("apikey", anonKey)
                .header("Authorization", "Bearer $token")
                .get()
                .build()
        }.use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IOException("Language progress fetch failed (${resp.code}): ${raw.take(180)}")
            }
            json.decodeFromString<List<LanguageProgressDto>>(raw)
                .firstOrNull()?.level ?: "none"
        }
    }

    suspend fun fetchWordStates(userId: String, lang: String): List<UserWordStateDto> =
        withContext(Dispatchers.IO) {
            val all = mutableListOf<UserWordStateDto>()
            var offset = 0
            while (true) {
                val url = "$baseUrl/rest/v1/user_word_state".toHttpUrl().newBuilder()
                    .addQueryParameter("user_id", "eq.$userId")
                    .addQueryParameter("learning_language", "eq.$lang")
                    .addQueryParameter(
                        "select",
                        "word,reading,level,learning_language,state,preference,known_source,correct_streak,srs_level,srs_due_at,last_reviewed_at,marked_known_at"
                    )
                    .addQueryParameter("order", "word.asc")
                    .addQueryParameter("limit", PAGE_SIZE.toString())
                    .addQueryParameter("offset", offset.toString())
                    .build()

                val page = executeAuthenticated { token ->
                    Request.Builder()
                        .url(url)
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .get()
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        throw IOException("Word states fetch failed (${resp.code}): ${raw.take(180)}")
                    }
                    json.decodeFromString<List<UserWordStateDto>>(raw)
                }

                all += page
                if (page.size < PAGE_SIZE) break
                offset += PAGE_SIZE
            }
            all
        }

    suspend fun upsertWordStates(rows: List<UserWordStateDto>): Boolean =
        withContext(Dispatchers.IO) {
            if (rows.isEmpty()) return@withContext true
            runCatching {
                val body = postgrestWriteJson.encodeToString(rows)
                executeAuthenticated { token ->
                    Request.Builder()
                        .url("$baseUrl/rest/v1/user_word_state?on_conflict=user_id,word,learning_language")
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .header("Prefer", "resolution=merge-duplicates,return=minimal")
                        .post(body.toRequestBody(jsonMedia))
                        .build()
                }.use { resp -> resp.isSuccessful }
            }.getOrDefault(false)
        }

    suspend fun deleteWordStates(userId: String, lang: String, words: List<String>): Boolean =
        withContext(Dispatchers.IO) {
            if (words.isEmpty()) return@withContext true
            runCatching {
                for (batch in words.chunked(50)) {
                    val quoted = batch.joinToString(",") { w ->
                        "\"${w.replace("\\", "\\\\").replace("\"", "\\\"")}\""
                    }
                    val url = "$baseUrl/rest/v1/user_word_state".toHttpUrl().newBuilder()
                        .addQueryParameter("user_id", "eq.$userId")
                        .addQueryParameter("learning_language", "eq.$lang")
                        .addQueryParameter("word", "in.($quoted)")
                        .build()
                    val ok = executeAuthenticated { token ->
                        Request.Builder()
                            .url(url)
                            .header("apikey", anonKey)
                            .header("Authorization", "Bearer $token")
                            .delete()
                            .build()
                    }.use { resp -> resp.isSuccessful }
                    if (!ok) return@runCatching false
                }
                true
            }.getOrDefault(false)
        }

    suspend fun fetchUserAnime(userId: String, lang: String): List<UserAnimeRowDto> =
        withContext(Dispatchers.IO) {
            val url = "$baseUrl/rest/v1/user_anime".toHttpUrl().newBuilder()
                .addQueryParameter("user_id", "eq.$userId")
                .addQueryParameter("learning_language", "eq.$lang")
                .addQueryParameter("select", "position,anime:anime_id(id,title_romaji,title_en,title_jp,cover_url)")
                .addQueryParameter("order", "position.asc")
                .build()
            executeAuthenticated { token ->
                Request.Builder()
                    .url(url)
                    .header("apikey", anonKey)
                    .header("Authorization", "Bearer $token")
                    .get()
                    .build()
            }.use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    throw IOException("Library fetch failed (${resp.code}): ${raw.take(180)}")
                }
                json.decodeFromString(raw)
            }
        }

    suspend fun fetchEpisodesForAnimeIds(animeIds: List<String>): List<EpisodeRowDto> =
        withContext(Dispatchers.IO) {
            if (animeIds.isEmpty()) return@withContext emptyList()
            val all = mutableListOf<EpisodeRowDto>()
            for (animeBatch in animeIds.chunked(50)) {
                val inList = animeBatch.joinToString(",")
                var offset = 0
                while (true) {
                    val url = "$baseUrl/rest/v1/episodes".toHttpUrl().newBuilder()
                        .addQueryParameter("seasons.anime_id", "in.($inList)")
                        .addQueryParameter(
                            "select",
                            "id,episode_number,title_en,title_jp,processing_status,seasons!inner(anime_id,season_number)"
                        )
                        .addQueryParameter("order", "id.asc")
                        .addQueryParameter("limit", PAGE_SIZE.toString())
                        .addQueryParameter("offset", offset.toString())
                        .build()
                    val page = executeAuthenticated { token ->
                        Request.Builder()
                            .url(url)
                            .header("apikey", anonKey)
                            .header("Authorization", "Bearer $token")
                            .get()
                            .build()
                    }.use { resp ->
                        val raw = resp.body?.string().orEmpty()
                        if (!resp.isSuccessful) {
                            throw IOException("Episodes fetch failed (${resp.code}): ${raw.take(180)}")
                        }
                        json.decodeFromString<List<EpisodeRowDto>>(raw)
                    }
                    all += page
                    if (page.size < PAGE_SIZE) break
                    offset += PAGE_SIZE
                }
            }
            all
        }

    suspend fun fetchEpisodeVocabCaches(episodeIds: List<String>, lang: String): List<EpisodeVocabCacheDto> =
        withContext(Dispatchers.IO) {
            if (episodeIds.isEmpty()) return@withContext emptyList()

            val targetIds: List<String> = if (episodeIds.size > 25) {
                val cachedIds = LinkedHashSet<String>()
                for (batch in episodeIds.chunked(180)) {
                    val inList = batch.joinToString(",")
                    val url = "$baseUrl/rest/v1/episode_vocab_cache".toHttpUrl().newBuilder()
                        .addQueryParameter("episode_id", "in.($inList)")
                        .addQueryParameter("language", "eq.$lang")
                        .addQueryParameter("select", "episode_id")
                        .build()
                    executeAuthenticated { token ->
                        Request.Builder()
                            .url(url)
                            .header("apikey", anonKey)
                            .header("Authorization", "Bearer $token")
                            .get()
                            .build()
                    }.use { resp ->
                        val raw = resp.body?.string().orEmpty()
                        if (!resp.isSuccessful) {
                            throw IOException("Episode vocab cache probe failed (${resp.code}): ${raw.take(180)}")
                        }
                        for (row in json.decodeFromString<List<EpisodeCacheExistsDto>>(raw)) {
                            cachedIds += row.episodeId
                        }
                    }
                }
                if (cachedIds.isEmpty()) return@withContext emptyList()
                cachedIds.toList()
            } else {
                episodeIds
            }

            val out = mutableListOf<EpisodeVocabCacheDto>()
            for (batch in targetIds.chunked(25)) {
                val inList = batch.joinToString(",")
                val url = "$baseUrl/rest/v1/episode_vocab_cache".toHttpUrl().newBuilder()
                    .addQueryParameter("episode_id", "in.($inList)")
                    .addQueryParameter("language", "eq.$lang")
                    .addQueryParameter("select", "episode_id,vocab")
                    .build()
                executeAuthenticated { token ->
                    Request.Builder()
                        .url(url)
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .get()
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        throw IOException("Episode vocab cache fetch failed (${resp.code}): ${raw.take(180)}")
                    }
                    out += json.decodeFromString<List<EpisodeVocabCacheDto>>(raw)
                }
            }
            out
        }

    suspend fun fetchChunkWords(userId: String, lang: String): List<StudyChunkWordDto> =
        withContext(Dispatchers.IO) {
            val chunkIds = mutableListOf<String>()
            var chunkOffset = 0
            while (true) {
                val chunkUrl = "$baseUrl/rest/v1/study_chunks".toHttpUrl().newBuilder()
                    .addQueryParameter("user_id", "eq.$userId")
                    .addQueryParameter("learning_language", "eq.$lang")
                    .addQueryParameter("select", "id")
                    .addQueryParameter("order", "id.asc")
                    .addQueryParameter("limit", PAGE_SIZE.toString())
                    .addQueryParameter("offset", chunkOffset.toString())
                    .build()
                val page = executeAuthenticated { token ->
                    Request.Builder()
                        .url(chunkUrl)
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .get()
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        throw IOException("Study chunks fetch failed (${resp.code}): ${raw.take(180)}")
                    }
                    json.decodeFromString<List<StudyChunkIdDto>>(raw).map { it.id }
                }
                chunkIds += page
                if (page.size < PAGE_SIZE) break
                chunkOffset += PAGE_SIZE
            }
            if (chunkIds.isEmpty()) return@withContext emptyList()

            val words = mutableListOf<StudyChunkWordDto>()
            for (batch in chunkIds.chunked(25)) {
                val inList = batch.joinToString(",")
                var wordOffset = 0
                while (true) {
                    val wordsUrl = "$baseUrl/rest/v1/study_chunk_words".toHttpUrl().newBuilder()
                        .addQueryParameter("chunk_id", "in.($inList)")
                        .addQueryParameter(
                            "select",
                            "word,reading,meaning,part_of_speech,level,example_sentence_jp,example_sentence_en"
                        )
                        .addQueryParameter("order", "id.asc")
                        .addQueryParameter("limit", PAGE_SIZE.toString())
                        .addQueryParameter("offset", wordOffset.toString())
                        .build()
                    val page = executeAuthenticated { token ->
                        Request.Builder()
                            .url(wordsUrl)
                            .header("apikey", anonKey)
                            .header("Authorization", "Bearer $token")
                            .get()
                            .build()
                    }.use { resp ->
                        val raw = resp.body?.string().orEmpty()
                        if (!resp.isSuccessful) {
                            throw IOException("Study chunk words fetch failed (${resp.code}): ${raw.take(180)}")
                        }
                        json.decodeFromString<List<StudyChunkWordDto>>(raw)
                    }
                    words += page
                    if (page.size < PAGE_SIZE) break
                    wordOffset += PAGE_SIZE
                }
            }
            words
        }

    suspend fun updateUserLevel(userId: String, lang: String, level: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val payload = buildJsonObject {
                    put("user_id", userId)
                    put("learning_language", lang)
                    put("level", level)
                    put("placement_done", true)
                }.toString()
                val url = "$baseUrl/rest/v1/user_language_progress".toHttpUrl().newBuilder()
                    .addQueryParameter("on_conflict", "user_id,learning_language")
                    .build()
                executeAuthenticated { token ->
                    Request.Builder()
                        .url(url)
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .header("Prefer", "resolution=merge-duplicates,return=minimal")
                        .post(payload.toRequestBody(jsonMedia))
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        error("Couldn't save level (${resp.code}): ${raw.take(140)}")
                    }
                }
            }
        }

    suspend fun updateLearningLanguage(userId: String, lang: String): Result<String> =
        withContext(Dispatchers.IO) {
            runCatching {
                val payload = buildJsonObject {
                    put("learning_language", lang)
                }.toString()
                val url = "$baseUrl/rest/v1/profiles".toHttpUrl().newBuilder()
                    .addQueryParameter("user_id", "eq.$userId")
                    .build()
                executeAuthenticated { token ->
                    Request.Builder()
                        .url(url)
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .header("Prefer", "return=minimal")
                        .patch(payload.toRequestBody(jsonMedia))
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        error("Couldn't update language (${resp.code}): ${raw.take(140)}")
                    }
                }
                fetchLanguageLevel(userId, lang)
            }
        }

    suspend fun removeUserAnime(userId: String, animeId: String, lang: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = "$baseUrl/rest/v1/user_anime".toHttpUrl().newBuilder()
                    .addQueryParameter("user_id", "eq.$userId")
                    .addQueryParameter("anime_id", "eq.$animeId")
                    .addQueryParameter("learning_language", "eq.$lang")
                    .build()
                executeAuthenticated { token ->
                    Request.Builder()
                        .url(url)
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .delete()
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        error("Couldn't remove anime (${resp.code}): ${raw.take(140)}")
                    }
                }
            }
        }

    suspend fun searchAnime(query: String): Result<List<AnimeSearchResultDto>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val payload = buildJsonObject { put("query", query.trim()) }.toString()
                executeAuthenticated { token ->
                    Request.Builder()
                        .url("$baseUrl/functions/v1/search-anime")
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .post(payload.toRequestBody(jsonMedia))
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    val parsed = runCatching { json.decodeFromString<SearchAnimeResponseDto>(raw) }.getOrNull()
                    if (!resp.isSuccessful) error(parsed?.error ?: "Search failed (${resp.code})")
                    parsed?.results.orEmpty()
                }
            }
        }

    suspend fun addAnimeToLibrary(anime: AnimeSearchResultDto, lang: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val bodyObj = buildJsonObject {
                    put("learning_language", lang)
                    put(
                        "anime",
                        json.parseToJsonElement(json.encodeToString(anime))
                    )
                }.toString()
                executeAuthenticated { token ->
                    Request.Builder()
                        .url("$baseUrl/functions/v1/add-anime-to-library")
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .post(bodyObj.toRequestBody(jsonMedia))
                        .build()
                }.use { resp ->
                    if (!resp.isSuccessful) error("Couldn't add anime (${resp.code})")
                }
            }
        }

    suspend fun processEpisodeWithSubtitleText(episodeId: String, subtitleText: String): Result<Unit> =
        processEpisodeWithSubtitleTextDetailed(episodeId, subtitleText).map { }

    suspend fun processEpisodeWithSubtitleTextDetailed(
        episodeId: String,
        subtitleText: String,
    ): Result<Boolean> =
        withContext(Dispatchers.IO) {
            runCatching {
                val trimmed = subtitleText.trimStart('\uFEFF').trim()
                if (trimmed.isBlank()) error("Subtitle text is empty.")
                val procPayload = buildJsonObject {
                    put("episode_id", episodeId)
                    put("subtitle_text", trimmed)
                }.toString()
                executeAuthenticated { token ->
                    Request.Builder()
                        .url("$baseUrl/functions/v1/process-episode")
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .post(procPayload.toRequestBody(jsonMedia))
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    val parsed = runCatching {
                        json.decodeFromString<ProcessEpisodeResponseDto>(raw)
                    }.getOrNull()
                    if (!resp.isSuccessful) {
                        error(parsed?.error ?: "Episode processing failed (${resp.code})")
                    }
                    parsed?.cached == true
                }
            }
        }

    private suspend fun isEpisodeCachedForLanguage(episodeId: String, lang: String): Boolean =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = "$baseUrl/rest/v1/episode_vocab_cache".toHttpUrl().newBuilder()
                    .addQueryParameter("episode_id", "eq.$episodeId")
                    .addQueryParameter("language", "eq.$lang")
                    .addQueryParameter("select", "episode_id")
                    .addQueryParameter("limit", "1")
                    .build()
                executeAuthenticated { token ->
                    Request.Builder()
                        .url(url)
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .get()
                        .build()
                }.use { resp ->
                    if (!resp.isSuccessful) return@use false
                    val raw = resp.body?.string().orEmpty()
                    json.decodeFromString<List<EpisodeCacheExistsDto>>(raw).isNotEmpty()
                }
            }.getOrDefault(false)
        }

    suspend fun autoFetchAndProcessEpisode(episodeId: String): Result<Unit> =
        autoFetchAndProcessEpisodeDetailed(episodeId).map { }

    /**
     * Auto-fetches subtitles and processes vocabulary for [episodeId].
     * Returns `Result.success(true)` when served immediately from `episode_vocab_cache`
     * (zero external subtitle scraping or AI batch usage), or `Result.success(false)` when
     * newly extracted via AI.
     */
    suspend fun autoFetchAndProcessEpisodeDetailed(episodeId: String): Result<Boolean> =
        withContext(Dispatchers.IO) {
            runCatching {
                val lang = sessionStore.session.value?.learningLanguage ?: "ja"
                if (isEpisodeCachedForLanguage(episodeId, lang)) {
                    return@runCatching true
                }

                val fetchPayload = buildJsonObject { put("episode_id", episodeId) }.toString()
                val subtitleContent = executeAuthenticated { token ->
                    Request.Builder()
                        .url("$baseUrl/functions/v1/fetch-subtitles")
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .post(fetchPayload.toRequestBody(jsonMedia))
                        .build()
                }.use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    val parsed = runCatching { json.decodeFromString<FetchSubtitlesResponseDto>(raw) }.getOrNull()
                    if (!resp.isSuccessful || parsed?.found != true || parsed.content.isNullOrBlank()) {
                        error(parsed?.error ?: "No subtitles found automatically for this episode.")
                    }
                    parsed.content
                }

                processEpisodeWithSubtitleTextDetailed(episodeId, subtitleContent).getOrThrow()
            }
        }

    suspend fun deleteAllUserData(userId: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val fnCode = executeAuthenticated { token ->
                    Request.Builder()
                        .url("$baseUrl/functions/v1/delete-account")
                        .header("apikey", anonKey)
                        .header("Authorization", "Bearer $token")
                        .post("{}".toRequestBody(jsonMedia))
                        .build()
                }.use { resp ->
                    if (resp.isSuccessful) return@runCatching
                    val raw = resp.body?.string().orEmpty()
                    if (resp.code != 404) {
                        error("Account deletion failed (${resp.code}): ${raw.take(180)}")
                    }
                    resp.code
                }

                if (fnCode == 404) {
                    val tables = listOf(
                        "quiz_results",
                        "study_sessions",
                        "study_chunks",
                        "user_word_state",
                        "user_anime",
                        "flashcard_push_devices",
                        "user_language_progress",
                        "profiles",
                    )
                    for (table in tables) {
                        val url = "$baseUrl/rest/v1/$table".toHttpUrl().newBuilder()
                            .addQueryParameter("user_id", "eq.$userId")
                            .build()
                        executeAuthenticated { token ->
                            Request.Builder()
                                .url(url)
                                .header("apikey", anonKey)
                                .header("Authorization", "Bearer $token")
                                .delete()
                                .build()
                        }.use { resp ->
                            if (!resp.isSuccessful) {
                                val raw = resp.body?.string().orEmpty()
                                error("Failed to delete $table (${resp.code}): ${raw.take(140)}")
                            }
                        }
                    }
                }
            }
        }

    companion object {
        const val PAGE_SIZE = 1000
    }
}
