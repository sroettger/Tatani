package app.tatani.android.ui.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import app.tatani.android.domain.SrsEngine
import app.tatani.android.ui.theme.VermilionPrimary
import app.tatani.android.ui.theme.WashiForeground

@Composable
fun HighlightedSentenceText(
    sentence: String,
    targetWord: String,
    modifier: Modifier = Modifier,
) {
    val segments = SrsEngine.splitSentenceWithHighlight(sentence, targetWord)
    val annotated = buildAnnotatedString {
        for (seg in segments) {
            if (seg.highlighted) {
                withStyle(
                    SpanStyle(
                        color = WashiForeground,
                        fontWeight = FontWeight.Bold,
                        background = VermilionPrimary.copy(alpha = 0.22f),
                        textDecoration = TextDecoration.Underline,
                    )
                ) {
                    append(seg.text)
                }
            } else {
                append(seg.text)
            }
        }
    }

    Text(
        text = annotated,
        style = MaterialTheme.typography.bodyLarge,
        color = WashiForeground,
        modifier = modifier,
    )
}
