package app.tatani.android.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.School
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.tatani.android.domain.SrsEngine
import app.tatani.android.ui.TataniViewModel
import app.tatani.android.ui.theme.JadeSuccess
import app.tatani.android.ui.theme.SumiBorder
import app.tatani.android.ui.theme.SumiElevated
import app.tatani.android.ui.theme.SumiSurface
import app.tatani.android.ui.theme.VermilionPrimary
import app.tatani.android.ui.theme.WashiMuted
import kotlinx.coroutines.launch

@Composable
fun EpisodeScreen(
    viewModel: TataniViewModel,
    episodeId: String,
    onBack: () -> Unit,
    onStartLearn: (String) -> Unit,
    onGoSprint: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val episodes by viewModel.libraryEpisodes.collectAsState()
    val deckCards by viewModel.deckCards.collectAsState()
    val session by viewModel.session.collectAsState()

    val epMeta = remember(episodes, episodeId) {
        episodes.firstOrNull { it.episodeId == episodeId }
    }

    val episodeWords = remember(deckCards, episodeId) {
        deckCards.filter { c ->
            c.primaryEpisodeId == episodeId ||
                viewModel.repository.decodeContexts(c).any { it.episodeId == episodeId }
        }.sortedByDescending { c ->
            c.frequency * 10 + (6 - SrsEngine.jlptRank(c.level).coerceAtMost(6)).coerceAtLeast(0)
        }
    }

    val userRank = SrsEngine.jlptRank(session?.userLevel)
    val unlearnedWords = remember(episodeWords, userRank) {
        episodeWords.filter { c ->
            val below = userRank in 1..50 && SrsEngine.jlptRank(c.level) < userRank
            SrsEngine.isUnlearnedCandidate(
                hasExistingState = c.hasServerState,
                state = c.state,
                preference = c.preference,
                knownSource = c.knownSource,
                srsDueAtEpochMs = c.srsDueAtEpochMs,
                isBelowUserLevel = below,
            )
        }
    }

    var processing by remember { mutableStateOf(false) }
    var processError by remember { mutableStateOf<String?>(null) }
    var showKnownTab by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
            }
            Text(
                text = epMeta?.let { "${it.animeTitle} · Ep ${it.episodeNumber}" } ?: "Episode",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onGoSprint) {
                Icon(Icons.Outlined.Bolt, contentDescription = null, tint = VermilionPrimary, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("Sprint")
            }
        }

        Spacer(Modifier.height(10.dp))

        if (episodeWords.isEmpty()) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = SumiSurface),
                border = BorderStroke(1.dp, SumiBorder),
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = if (processing) "Fetching & extracting Japanese subtitles…" else "Process this episode",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = "Tatani automatically locates Japanese subtitles and builds contextual flashcards ranked by episode importance.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = WashiMuted,
                    )
                    if (!processError.isNullOrBlank()) {
                        Text(processError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
                    }
                    Button(
                        onClick = {
                            scope.launch {
                                processing = true
                                processError = null
                                viewModel.processEpisode(episodeId)
                                    .onFailure { processError = it.message }
                                processing = false
                            }
                        },
                        enabled = !processing,
                        colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                    ) {
                        if (processing) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                        } else {
                            Text("Auto-Fetch & Process Subtitles", fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        } else {
            val batchSize = unlearnedWords.size.coerceAtMost(SrsEngine.LEARN_BATCH_SIZE)
            if (batchSize > 0) {
                Button(
                    onClick = { onStartLearn(episodeId) },
                    colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(58.dp),
                ) {
                    Icon(Icons.Outlined.School, contentDescription = null, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "Learn next $batchSize in context (${unlearnedWords.size} left)",
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Spacer(Modifier.height(12.dp))
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = { showKnownTab = false },
                    border = BorderStroke(1.dp, if (!showKnownTab) VermilionPrimary else SumiBorder),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("To Learn (${unlearnedWords.size})")
                }
                OutlinedButton(
                    onClick = { showKnownTab = true },
                    border = BorderStroke(1.dp, if (showKnownTab) JadeSuccess else SumiBorder),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Known (${episodeWords.size - unlearnedWords.size})")
                }
            }

            Spacer(Modifier.height(10.dp))

            val displayed = if (!showKnownTab) unlearnedWords else (episodeWords - unlearnedWords.toSet())

            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(displayed, key = { it.word }) { item ->
                    Surface(
                        shape = RoundedCornerShape(14.dp),
                        color = SumiSurface,
                        border = BorderStroke(1.dp, SumiBorder),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(12.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f).padding(end = 8.dp)) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Text(item.word, fontWeight = FontWeight.Bold)
                                    if (!item.reading.isNullOrBlank() && item.reading != item.word) {
                                        Text(item.reading, style = MaterialTheme.typography.labelMedium, color = WashiMuted)
                                    }
                                    if (!item.level.isNullOrBlank()) {
                                        Surface(shape = RoundedCornerShape(6.dp), color = SumiElevated) {
                                            Text(
                                                item.level.uppercase(),
                                                style = MaterialTheme.typography.labelMedium,
                                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                            )
                                        }
                                    }
                                }
                                Text(
                                    text = item.meaning,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = WashiMuted,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }

                            if (!showKnownTab) {
                                TextButton(onClick = { viewModel.markPriorKnown(item) }) {
                                    Icon(
                                        Icons.Outlined.CheckCircleOutline,
                                        contentDescription = "Mark known",
                                        tint = JadeSuccess,
                                        modifier = Modifier.size(18.dp),
                                    )
                                    Spacer(Modifier.width(4.dp))
                                    Text("Known", color = JadeSuccess)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
