package app.tatani.android.data.remote

import android.content.Context
import android.content.SharedPreferences
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

interface SessionBacking {
    fun getString(key: String, defaultValue: String?): String?
    fun getLong(key: String, defaultValue: Long): Long
    fun getInt(key: String, defaultValue: Int): Int
    fun getBoolean(key: String, defaultValue: Boolean): Boolean
    fun edit(block: SessionEditor.() -> Unit)
}

interface SessionEditor {
    fun putString(key: String, value: String?)
    fun putLong(key: String, value: Long)
    fun putInt(key: String, value: Int)
    fun putBoolean(key: String, value: Boolean)
    fun remove(key: String)
}

private class SharedPrefsSessionBacking(
    private val prefs: SharedPreferences,
) : SessionBacking {
    override fun getString(key: String, defaultValue: String?): String? = prefs.getString(key, defaultValue)
    override fun getLong(key: String, defaultValue: Long): Long = prefs.getLong(key, defaultValue)
    override fun getInt(key: String, defaultValue: Int): Int = prefs.getInt(key, defaultValue)
    override fun getBoolean(key: String, defaultValue: Boolean): Boolean = prefs.getBoolean(key, defaultValue)
    override fun edit(block: SessionEditor.() -> Unit) {
        val editor = prefs.edit()
        object : SessionEditor {
            override fun putString(key: String, value: String?) { editor.putString(key, value) }
            override fun putLong(key: String, value: Long) { editor.putLong(key, value) }
            override fun putInt(key: String, value: Int) { editor.putInt(key, value) }
            override fun putBoolean(key: String, value: Boolean) { editor.putBoolean(key, value) }
            override fun remove(key: String) { editor.remove(key) }
        }.block()
        editor.apply()
    }
}

private class InMemorySessionBacking : SessionBacking {
    private val map = HashMap<String, Any>()

    @Synchronized
    override fun getString(key: String, defaultValue: String?): String? =
        (map[key] as? String) ?: defaultValue

    @Synchronized
    override fun getLong(key: String, defaultValue: Long): Long =
        (map[key] as? Long) ?: defaultValue

    @Synchronized
    override fun getInt(key: String, defaultValue: Int): Int =
        (map[key] as? Int) ?: defaultValue

    @Synchronized
    override fun getBoolean(key: String, defaultValue: Boolean): Boolean =
        (map[key] as? Boolean) ?: defaultValue

    @Synchronized
    override fun edit(block: SessionEditor.() -> Unit) {
        object : SessionEditor {
            override fun putString(key: String, value: String?) {
                if (value == null) map.remove(key) else map[key] = value
            }
            override fun putLong(key: String, value: Long) { map[key] = value }
            override fun putInt(key: String, value: Int) { map[key] = value }
            override fun putBoolean(key: String, value: Boolean) { map[key] = value }
            override fun remove(key: String) { map.remove(key) }
        }.block()
    }
}

class SessionStore private constructor(
    private val backing: SessionBacking,
) {
    constructor(context: Context) : this(
        SharedPrefsSessionBacking(
            context.applicationContext.getSharedPreferences(
                "tatani_auth_session",
                Context.MODE_PRIVATE
            )
        )
    )

    private val _session = MutableStateFlow(loadFromBacking())
    val session: StateFlow<AuthSession?> = _session.asStateFlow()

    private val _boostersEnabled = MutableStateFlow(backing.getBoolean("boosters_enabled", true))
    val boostersEnabled: StateFlow<Boolean> = _boostersEnabled.asStateFlow()

    private val _boosterIntervalMinutes = MutableStateFlow(
        backing.getInt("booster_interval_minutes", 60).coerceIn(15, 240)
    )
    val boosterIntervalMinutes: StateFlow<Int> = _boosterIntervalMinutes.asStateFlow()

    private fun loadFromBacking(): AuthSession? {
        val uid = backing.getString("user_id", null) ?: return null
        val access = backing.getString("access_token", null) ?: return null
        val refresh = backing.getString("refresh_token", null) ?: return null
        return AuthSession(
            userId = uid,
            email = backing.getString("email", null),
            accessToken = access,
            refreshToken = refresh,
            expiresAtEpochSec = backing.getLong("expires_at", 0L),
            learningLanguage = backing.getString("learning_language", "ja") ?: "ja",
            userLevel = backing.getString("user_level", "none") ?: "none",
        )
    }

    @Synchronized
    fun saveSession(next: AuthSession) {
        backing.edit {
            putString("user_id", next.userId)
            putString("email", next.email)
            putString("access_token", next.accessToken)
            putString("refresh_token", next.refreshToken)
            putLong("expires_at", next.expiresAtEpochSec)
            putString("learning_language", next.learningLanguage)
            putString("user_level", next.userLevel)
        }
        _session.value = next
    }

    @Synchronized
    fun updateLanguagePrefs(learningLanguage: String, userLevel: String) {
        val current = _session.value ?: return
        saveSession(current.copy(learningLanguage = learningLanguage, userLevel = userLevel))
    }

    @Synchronized
    fun setBoostersEnabled(enabled: Boolean) {
        backing.edit { putBoolean("boosters_enabled", enabled) }
        _boostersEnabled.value = enabled
    }

    @Synchronized
    fun setBoosterIntervalMinutes(minutes: Int) {
        val clamped = minutes.coerceIn(15, 240)
        backing.edit { putInt("booster_interval_minutes", clamped) }
        _boosterIntervalMinutes.value = clamped
    }

    @Synchronized
    fun savePkceVerifier(verifier: String) {
        backing.edit { putString("pkce_code_verifier", verifier) }
    }

    @Synchronized
    fun consumePkceVerifier(): String? {
        val v = backing.getString("pkce_code_verifier", null)
        backing.edit { remove("pkce_code_verifier") }
        return v
    }

    @Synchronized
    fun clear() {
        backing.edit {
            remove("user_id")
            remove("email")
            remove("access_token")
            remove("refresh_token")
            remove("expires_at")
            remove("learning_language")
            remove("user_level")
            remove("pkce_code_verifier")
        }
        _session.value = null
    }

    companion object {
        fun inMemory(initialSession: AuthSession? = null): SessionStore {
            val store = SessionStore(InMemorySessionBacking())
            if (initialSession != null) {
                store.saveSession(initialSession)
            }
            return store
        }
    }
}
