package app.tatani.android

import app.tatani.android.data.remote.AuthSession
import app.tatani.android.data.remote.SessionStore
import app.tatani.android.data.remote.SupabaseClient
import app.tatani.android.data.remote.UserWordStateDto
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger

class SupabaseClientTest {
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val json = Json { ignoreUnknownKeys = true }

    private fun fakeSession(
        userId: String = "user-1",
        accessToken: String = "tok-valid",
        refreshToken: String = "ref-valid",
        expiresOffsetSec: Long = 3600L,
        lang: String = "ja",
        level: String = "N4",
    ): AuthSession = AuthSession(
        userId = userId,
        email = "learner@tatani.app",
        accessToken = accessToken,
        refreshToken = refreshToken,
        expiresAtEpochSec = System.currentTimeMillis() / 1000L + expiresOffsetSec,
        learningLanguage = lang,
        userLevel = level,
    )

    private fun jsonResponse(req: Request, code: Int, body: String): Response =
        Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("HTTP $code")
            .body(body.toResponseBody(jsonMedia))
            .build()

    private fun Request.readBodyUtf8(): String {
        val buf = Buffer()
        body?.writeTo(buf)
        return buf.readUtf8()
    }

    @Test
    fun upsertWordStatesSerializesUniformKeysWithExplicitNulls_C1() = runTest {
        var capturedBody: String? = null
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                capturedBody = req.readBodyUtf8()
                jsonResponse(req, 201, "")
            }
            .build()

        val store = SessionStore.inMemory(fakeSession())
        val client = SupabaseClient(
            sessionStore = store,
            baseUrl = "https://mock.supabase.co",
            anonKey = "anon-key",
            httpClient = http,
        )

        val rows = listOf(
            UserWordStateDto(
                userId = "user-1",
                word = "魔法",
                reading = "まほう",
                level = "N4",
                learningLanguage = "ja",
                state = "known",
                preference = "study",
                knownSource = "learned",
                correctStreak = 2,
                srsLevel = 1,
                srsDueAt = "2026-11-25T10:00:00Z",
                lastReviewedAt = "2026-11-22T10:00:00Z",
                markedKnownAt = "2026-11-20T10:00:00Z",
            ),
            UserWordStateDto(
                userId = "user-1",
                word = "私",
                reading = null,
                level = null,
                learningLanguage = "ja",
                state = "known",
                preference = "study",
                knownSource = "prior",
                correctStreak = 0,
                srsLevel = 0,
                srsDueAt = null,
                lastReviewedAt = null,
                markedKnownAt = null,
            ),
        )

        val ok = client.upsertWordStates(rows)
        assertTrue(ok)
        val raw = capturedBody
        assertNotNull(raw)
        assertTrue("Expected explicit null for srs_due_at in batch payload: $raw", raw!!.contains("\"srs_due_at\":null"))

        val parsed = json.parseToJsonElement(raw).jsonArray
        assertEquals(2, parsed.size)
        val firstObj = parsed[0].jsonObject
        val secondObj = parsed[1].jsonObject
        assertEquals(
            "Every row in PostgREST bulk upsert must have identical JSON keys to avoid PGRST102",
            firstObj.keys,
            secondObj.keys
        )
        assertEquals(JsonNull, secondObj["srs_due_at"])
        assertEquals(JsonNull, secondObj["reading"])
        assertEquals(JsonNull, secondObj["level"])
    }

    @Test
    fun http500OnFetchWordStatesThrowsIOExceptionInsteadOfEmptyList_C2() = runTest {
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                jsonResponse(chain.request(), 500, """{"message":"upstream db timeout"}""")
            }
            .build()

        val store = SessionStore.inMemory(fakeSession())
        val client = SupabaseClient(
            sessionStore = store,
            baseUrl = "https://mock.supabase.co",
            anonKey = "anon-key",
            httpClient = http,
        )

        try {
            client.fetchWordStates("user-1", "ja")
            fail("Expected IOException on HTTP 500 from fetchWordStates")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().contains("500"))
        }
    }

    @Test
    fun fetchWordStatesPaginatesAcross2350Rows_C3() = runTest {
        val totalRows = 2350
        val calls = AtomicInteger(0)

        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                calls.incrementAndGet()
                assertEquals("word.asc", req.url.queryParameter("order"))
                val limit = req.url.queryParameter("limit")!!.toInt()
                val offset = req.url.queryParameter("offset")!!.toInt()
                assertEquals(1000, limit)

                val end = (offset + limit).coerceAtMost(totalRows)
                val slice = if (offset >= totalRows) {
                    emptyList()
                } else {
                    (offset until end).map { idx ->
                        """{"word":"w_$idx","learning_language":"ja","state":"known","preference":"study","correct_streak":1,"srs_level":0}"""
                    }
                }
                jsonResponse(req, 200, slice.joinToString(",", prefix = "[", postfix = "]"))
            }
            .build()

        val store = SessionStore.inMemory(fakeSession())
        val client = SupabaseClient(
            sessionStore = store,
            baseUrl = "https://mock.supabase.co",
            anonKey = "anon-key",
            httpClient = http,
        )

        val states = client.fetchWordStates("user-1", "ja")
        assertEquals(totalRows, states.size)
        assertEquals(3, calls.get())
        assertEquals("w_0", states.first().word)
        assertEquals("w_2349", states.last().word)
    }

    @Test
    fun http401ForcesTokenRefreshRetriesCleanlyAndRevocationClearsSession_H7() = runTest {
        val wordCalls = AtomicInteger(0)
        val refreshCalls = AtomicInteger(0)

        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                when {
                    req.url.encodedPath.endsWith("/rest/v1/user_word_state") -> {
                        val n = wordCalls.incrementAndGet()
                        val auth = req.header("Authorization")
                        if (n == 1) {
                            assertEquals("Bearer stale-token", auth)
                            jsonResponse(req, 401, """{"message":"JWT expired"}""")
                        } else {
                            assertEquals("Bearer fresh-token", auth)
                            jsonResponse(
                                req,
                                200,
                                """[{"word":"Reise","learning_language":"de","state":"known","preference":"study"}]"""
                            )
                        }
                    }
                    req.url.encodedPath.endsWith("/auth/v1/token") &&
                        req.url.queryParameter("grant_type") == "refresh_token" -> {
                        refreshCalls.incrementAndGet()
                        jsonResponse(
                            req,
                            200,
                            """{"access_token":"fresh-token","refresh_token":"fresh-ref","expires_in":3600}"""
                        )
                    }
                    else -> jsonResponse(req, 404, "{}")
                }
            }
            .build()

        val store = SessionStore.inMemory(
            fakeSession(
                accessToken = "stale-token",
                refreshToken = "valid-ref",
                expiresOffsetSec = 3600L, // Local clock thinks token is still valid, server returns 401
                lang = "de",
                level = "B2",
            )
        )
        val client = SupabaseClient(
            sessionStore = store,
            baseUrl = "https://mock.supabase.co",
            anonKey = "anon-key",
            httpClient = http,
        )

        val rows = client.fetchWordStates("user-1", "de")
        assertEquals(1, rows.size)
        assertEquals("Reise", rows.single().word)
        assertEquals(2, wordCalls.get())
        assertEquals(1, refreshCalls.get())
        // Language & level preferences must be preserved across token refresh
        assertEquals("de", store.session.value?.learningLanguage)
        assertEquals("B2", store.session.value?.userLevel)
        assertEquals("fresh-token", store.session.value?.accessToken)

        // Now verify revoked refresh token (400) clears SessionStore instead of keeping dead session
        val revokedHttp = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                if (req.url.encodedPath.endsWith("/auth/v1/token")) {
                    jsonResponse(req, 400, """{"error":"invalid_grant","error_description":"Refresh Token Not Found"}""")
                } else {
                    jsonResponse(req, 401, """{"message":"JWT expired"}""")
                }
            }
            .build()
        val revokedClient = SupabaseClient(
            sessionStore = store,
            baseUrl = "https://mock.supabase.co",
            anonKey = "anon-key",
            httpClient = revokedHttp,
        )
        try {
            revokedClient.fetchWordStates("user-1", "de")
            fail("Expected IOException when refresh token is revoked")
        } catch (_: IOException) {
            // expected
        }
        assertNull("SessionStore must be cleared when refresh token is rejected with 400/401", store.session.value)
    }

    @Test
    fun oauthPkceExchangesCodeWithS256VerifierAndHandlesCallbackError_H7() = runTest {
        var capturedPkceBody: String? = null
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request()
                if (req.url.encodedPath.endsWith("/auth/v1/token") &&
                    req.url.queryParameter("grant_type") == "pkce"
                ) {
                    capturedPkceBody = req.readBodyUtf8()
                    jsonResponse(
                        req,
                        200,
                        """{"access_token":"pkce-acc","refresh_token":"pkce-ref","expires_in":3600,"user":{"id":"u-pkce","email":"pkce@tatani.app"}}"""
                    )
                } else {
                    jsonResponse(req, 404, "{}")
                }
            }
            .build()

        val store = SessionStore.inMemory()
        val client = SupabaseClient(
            sessionStore = store,
            baseUrl = "https://mock.supabase.co",
            anonKey = "anon-key",
            httpClient = http,
        )

        val authUrl = client.buildGoogleOAuthUrl().toHttpUrl()
        assertEquals("S256", authUrl.queryParameter("code_challenge_method"))
        val challenge = authUrl.queryParameter("code_challenge")
        assertNotNull(challenge)

        val redirectRes = client.handleOAuthRedirect("tatani://auth-callback?code=auth_code_99")
        assertTrue(redirectRes.isSuccess)
        assertEquals("u-pkce", store.session.value?.userId)
        assertEquals("pkce-acc", store.session.value?.accessToken)

        val sentObj = json.parseToJsonElement(capturedPkceBody!!).jsonObject
        assertEquals("auth_code_99", sentObj["auth_code"]?.jsonPrimitive?.content)
        val sentVerifier = sentObj["code_verifier"]?.jsonPrimitive?.content!!
        val expectedChallenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(sentVerifier.toByteArray(StandardCharsets.US_ASCII))
        )
        assertEquals(challenge, expectedChallenge)

        // Verify OAuth error_description returns clean failure Result
        client.buildGoogleOAuthUrl()
        val errRes = client.handleOAuthRedirect(
            "tatani://auth-callback?error=access_denied&error_description=User+cancelled+login"
        )
        assertTrue(errRes.isFailure)
        assertTrue(errRes.exceptionOrNull()?.message.orEmpty().contains("User cancelled login"))
    }
}
