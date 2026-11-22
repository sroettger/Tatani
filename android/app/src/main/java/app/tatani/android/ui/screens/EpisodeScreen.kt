package app.tatani.android.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.School
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalContext
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun EpisodeScreen(
    viewModel: TataniViewModel,
    episodeId: String,
    onBack: () -> Unit,
    onStartLearn: (String) -> Unit,
    onGoSprint: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val episodes by viewModel.libraryEpisodes.collectAsState()
    val deckCards by viewModel.deckCards.collectAsState()
    val session by viewModel.session.collectAsState()
    val processingIds by viewModel.processingEpisodeIds.collectAsState()
    val episodeErrors by viewModel.episodeProcessErrors.collectAsState()

    val processing = episodeId in processingIds
    var localImportError by remember { mutableStateOf<String?>(null) }
    var pasteDialogOpen by remember { mutableStateOf(false) }
    var pastedSubtitles by remember { mutableStateOf("") }
    var showKnownTab by remember { mutableStateOf(false) }

    val importFileLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            localImportError = null
            val contentResult = withContext(Dispatchers.IO) {
                runCatching {
                    context.contentResolver.openInputStream(uri)
                        ?.bufferedReader(Charsets.UTF_8)
                        ?.use { it.readText() }
                        ?.trimStart('\uFEFF')
                        ?.trim()
                        .orEmpty()
                }
            }
            contentResult.onSuccess { text ->
                if (text.isBlank()) {
                    localImportError = "Selected subtitle file was empty."
                } else {
                    viewModel.processEpisodeManual(episodeId, text)
                }
            }.onFailure { err ->
                localImportError = err.message ?: "Couldn't read subtitle file."
            }
        }
    }

    val epMeta = remember(episodes, episodeId) {
        episodes.firstOrNull { it.episodeId == episodeId }
    }

    val episodeWords = remember(deckCards, episodeId) {
        deckCards.filter { c ->
            c.primaryEpisodeId == episodeId ||
                viewModel.repository.decodeContexts(c).any { it.episodeId == episodeId }
        }.sortedByDescending { c ->
            c.frequency * 10 + (7 - SrsEngine.jlptRank(c.level).coerceAtMost(7)).coerceAtLeast(0)
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

    val languageName = when (session?.learningLanguage) {
        "es" -> "Spanish"
        "fr" -> "French"
        "de" -> "German"
        else -> "Japanese"
    }
    val processError = localImportError ?: episodeErrors[episodeId]

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
            val epTitleSuffix = epMeta?.let {
                val t = it.episodeTitleEn?.takeIf { s -> s.isNotBlank() }
                    ?: it.episodeTitleJp?.takeIf { s -> s.isNotBlank() }
                if (t != null) " · $t" else ""
            }.orEmpty()
            Text(
                text = epMeta?.let { "${it.animeTitle} · Ep ${it.episodeNumber}$epTitleSuffix" } ?: "Episode",
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
                        text = if (processing) "Extracting $languageName vocabulary…" else "Process this episode",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = "Auto-fetch $languageName subtitles or import your own .srt / .ass file to build contextual flashcards ranked by episode importance.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = WashiMuted,
                    )
                    if (!processError.isNullOrBlank()) {
                        Text(
                            text = processError,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                    Button(
                        onClick = {
                            localImportError = null
                            viewModel.processEpisode(episodeId)
                        },
                        enabled = !processing,
                        colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                    ) {
                        if (processing) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("Processing in background…")
                        } else {
                            Text("Auto-Fetch & Process Subtitles", fontWeight = FontWeight.SemiBold)
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(
                            onClick = {
                                localImportError = null
                                importFileLauncher.launch("*/*")
                            },
                            enabled = !processing,
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(1.dp, SumiBorder),
                            modifier = Modifier.weight(1f).height(46.dp),
                        ) {
                            Icon(Icons.Outlined.UploadFile, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(5.dp))
                            Text("Import .srt/.ass", style = MaterialTheme.typography.labelMedium)
                        }
                        OutlinedButton(
                            onClick = {
                                localImportError = null
                                pasteDialogOpen = true
                            },
                            enabled = !processing,
                            shape = RoundedCornerShape(12.dp),
                            border = BorderStroke(1.dp, SumiBorder),
                            modifier = Modifier.weight(1f).height(46.dp),
                        ) {
                            Icon(Icons.Outlined.ContentPaste, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(5.dp))
                            Text("Paste Subtitles", style = MaterialTheme.typography.labelMedium)
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

            val unlearnedSet = remember(unlearnedWords) { unlearnedWords.mapTo(HashSet()) { it.word } }
            val displayed = if (!showKnownTab) unlearnedWords else episodeWords.filter { it.word !in unlearnedSet }

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
                            } else {
                                TextButton(onClick = { viewModel.restudyCard(item) }) {
                                    Icon(
                                        Icons.AutoMirrored.Outlined.Undo,
                                        contentDescription = "Re-study word",
                                        tint = VermilionPrimary,
                                        modifier = Modifier.size(18.dp),
                                    )
                                    Spacer(Modifier.width(4.dp))
                                    Text("Re-study", color = VermilionPrimary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (pasteDialogOpen) {
        AlertDialog(
            onDismissRequest = { pasteDialogOpen = false },
            containerColor = SumiSurface,
            title = { Text("Paste Subtitle Text") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "Paste .srt, .ass, .vtt, or plain $languageName dialogue lines below.",
                        style = MaterialTheme.typography.labelMedium,
                        color = WashiMuted,
                    )
                    OutlinedTextField(
                        value = pastedSubtitles,
                        onValueChange = { pastedSubtitles = it },
                        placeholder = { Text("Paste subtitles here…") },
                        minLines = 6,
                        maxLines = 12,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val text = pastedSubtitles.trim()
                        if (text.isNotEmpty()) {
                            pasteDialogOpen = false
                            pastedSubtitles = ""
                            viewModel.processEpisodeManual(episodeId, text)
                        }
                    },
                    enabled = pastedSubtitles.isNotBlank() && !processing,
                    colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                ) {
                    Text("Extract Vocabulary")
                }
            },
            dismissButton = {
                TextButton(onClick = { pasteDialogOpen = false }) {
                    Text("Cancel")
                }
            },
        )
    }
}
