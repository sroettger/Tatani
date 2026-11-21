package app.tatani.android.ui

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale

class JapaneseTtsManager(context: Context) : TextToSpeech.OnInitListener {
    private var tts: TextToSpeech? = TextToSpeech(context.applicationContext, this)
    private var ready = false

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            tts?.language = Locale.JAPANESE
            tts?.setSpeechRate(0.96f)
            ready = true
        }
    }

    fun speak(text: String, langCode: String = "ja") {
        if (!ready || text.isBlank()) return
        val locale = when (langCode) {
            "ja" -> Locale.JAPANESE
            "de" -> Locale.GERMAN
            "fr" -> Locale.FRENCH
            "es" -> Locale.forLanguageTag("es-ES")
            else -> Locale.JAPANESE
        }
        tts?.language = locale
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "tatani_card_utt")
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        ready = false
    }
}
