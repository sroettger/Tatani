package app.tatani.android.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val SumiBackground = Color(0xFF0F1116)
val SumiSurface = Color(0xFF171A22)
val SumiElevated = Color(0xFF212632)
val SumiBorder = Color(0xFF2B3140)
val WashiForeground = Color(0xFFF5EFE6)
val WashiMuted = Color(0xFF9BA1B0)
val VermilionPrimary = Color(0xFFE5533D)
val JadeSuccess = Color(0xFF30B078)
val CrimsonAgain = Color(0xFFE04F4F)
val AmberAccent = Color(0xFFE89B3C)

private val TataniDarkColors = darkColorScheme(
    primary = VermilionPrimary,
    onPrimary = Color.White,
    secondary = SumiElevated,
    onSecondary = WashiForeground,
    tertiary = AmberAccent,
    background = SumiBackground,
    onBackground = WashiForeground,
    surface = SumiSurface,
    onSurface = WashiForeground,
    surfaceVariant = SumiElevated,
    onSurfaceVariant = WashiMuted,
    outline = SumiBorder,
    error = CrimsonAgain,
    onError = Color.White,
)

private val TataniTypography = Typography(
    displayLarge = TextStyle(
        fontSize = 52.sp,
        lineHeight = 60.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = (-0.5).sp,
    ),
    headlineMedium = TextStyle(
        fontSize = 26.sp,
        lineHeight = 32.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    titleMedium = TextStyle(
        fontSize = 17.sp,
        lineHeight = 24.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    bodyLarge = TextStyle(
        fontSize = 17.sp,
        lineHeight = 26.sp,
        fontWeight = FontWeight.Normal,
    ),
    bodyMedium = TextStyle(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.Normal,
    ),
    labelMedium = TextStyle(
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.Medium,
    ),
)

@Composable
fun TataniTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = TataniDarkColors,
        typography = TataniTypography,
        content = content,
    )
}
