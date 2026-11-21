package app.tatani.android.data.remote

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class AuthSession(
    val userId: String,
    val email: String?,
    val accessToken: String,
    val refreshToken: String,
    val expiresAtEpochSec: Long,
    val learningLanguage: String = "ja",
    val userLevel: String = "none",
)

class SessionStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(
        "tatani_auth_session",
        Context.MODE_PRIVATE
    )

    private val _session = MutableStateFlow(loadFromPrefs())
    val session: StateFlow<AuthSession?> = _session.asStateFlow()

    private fun loadFromPrefs(): AuthSession? {
        val uid = prefs.getString("user_id", null) ?: return null
        val access = prefs.getString("access_token", null) ?: return null
        val refresh = prefs.getString("refresh_token", null) ?: return null
        return AuthSession(
            userId = uid,
            email = prefs.getString("email", null),
            accessToken = access,
            refreshToken = refresh,
            expiresAtEpochSec = prefs.getLong("expires_at", 0L),
            learningLanguage = prefs.getString("learning_language", "ja") ?: "ja",
            userLevel = prefs.getString("user_level", "none") ?: "none",
        )
    }

    fun saveSession(next: AuthSession) {
        prefs.edit()
            .putString("user_id", next.userId)
            .putString("email", next.email)
            .putString("access_token", next.accessToken)
            .putString("refresh_token", next.refreshToken)
            .putLong("expires_at", next.expiresAtEpochSec)
            .putString("learning_language", next.learningLanguage)
            .putString("user_level", next.userLevel)
            .apply()
        _session.value = next
    }

    fun updateLanguagePrefs(learningLanguage: String, userLevel: String) {
        val current = _session.value ?: return
        saveSession(current.copy(learningLanguage = learningLanguage, userLevel = userLevel))
    }

    fun clear() {
        prefs.edit().clear().apply()
        _session.value = null
    }
}
