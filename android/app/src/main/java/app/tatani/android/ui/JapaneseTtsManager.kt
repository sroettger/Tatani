package app.tatani.android.ui

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

class JapaneseTtsManager(context: Context) : TextToSpeech.OnInitListener {
    private data class PendingUtterance(
        val text: String,
        val langCode: String,
    )

    private val lock = Any()
    private var ready = false
    private var shutdownRequested = false
    private var pendingUtterance: PendingUtterance? = null
    private var tts: TextToSpeech? = null

    init {
        val appCtx = context.applicationContext
        synchronized(lock) {
            tts = TextToSpeech(appCtx, this)
        }
    }

    override fun onInit(status: Int) {
        synchronized(lock) {
            if (shutdownRequested) {
                tts?.shutdown()
                tts = null
                return
            }
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.JAPANESE
                tts?.setSpeechRate(0.96f)
                ready = true
                val queued = pendingUtterance
                pendingUtterance = null
                if (queued != null) {
                    speakLocked(queued.text, queued.langCode)
                }
            }
        }
    }

    fun speak(text: String, langCode: String = "ja") {
        if (text.isBlank()) return
        synchronized(lock) {
            if (shutdownRequested) return
            if (!ready) {
                pendingUtterance = PendingUtterance(text, langCode)
                return
            }
            speakLocked(text, langCode)
        }
    }

    @Suppress("DEPRECATION")
    private fun localeFor(langCode: String): Locale = when (langCode.lowercase()) {
        "ja" -> Locale.JAPANESE
        "es" -> Locale("es", "ES")
        "fr" -> Locale.FRENCH
        "de" -> Locale.GERMAN
        else -> Locale.JAPANESE
    }

    private fun speakLocked(text: String, langCode: String) {
        val engine = tts ?: return
        engine.language = localeFor(langCode)
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "tatani_card_utt")
    }

    fun shutdown() {
        synchronized(lock) {
            shutdownRequested = true
            pendingUtterance = null
            ready = false
            tts?.stop()
            tts?.shutdown()
            tts = null
        }
    }
}
