package app.tatani.android.ui.screens

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.tatani.android.data.local.LibraryEpisodeEntity
import app.tatani.android.data.remote.AnimeSearchResultDto
import app.tatani.android.domain.SrsEngine
import app.tatani.android.ui.TataniViewModel
import app.tatani.android.ui.theme.AmberAccent
import app.tatani.android.ui.theme.CrimsonAgain
import app.tatani.android.ui.theme.JadeSuccess
import app.tatani.android.ui.theme.SumiBorder
import app.tatani.android.ui.theme.SumiElevated
import app.tatani.android.ui.theme.SumiSurface
import app.tatani.android.ui.theme.VermilionPrimary
import app.tatani.android.ui.theme.WashiForeground
import app.tatani.android.ui.theme.WashiMuted
import coil.compose.AsyncImage
import kotlinx.coroutines.launch

@Composable
fun LibraryScreen(
    viewModel: TataniViewModel,
    onBackToSprint: () -> Unit,
    onOpenEpisode: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val episodes by viewModel.libraryEpisodes.collectAsState()
    val syncing by viewModel.syncing.collectAsState()
    val syncError by viewModel.syncError.collectAsState()
    val dueCards by viewModel.dueCards.collectAsState()
    val dailyStreak by viewModel.dailyStreak.collectAsState()
    val processingIds by viewModel.processingEpisodeIds.collectAsState()
    val batchProcessState by viewModel.batchProcessState.collectAsState()
    val addingAnime by viewModel.addingAnime.collectAsState()
    val addAnimeError by viewModel.addAnimeError.collectAsState()

    val groupedByAnime = remember(episodes) {
        episodes.groupBy { it.animeId }.values.toList()
    }

    var expandedAnimeId by remember(groupedByAnime.firstOrNull()?.firstOrNull()?.animeId) {
        mutableStateOf(groupedByAnime.firstOrNull()?.firstOrNull()?.animeId)
    }
    var addDialogOpen by remember { mutableStateOf(false) }
    var accountDialogOpen by remember { mutableStateOf(false) }
    var animePendingRemove by remember { mutableStateOf<LibraryEpisodeEntity?>(null) }
    var removingAnime by remember { mutableStateOf(false) }
    var removeError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        // Top Header with 1-Tap Switch Back to Sprint + Daily Streak
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = onBackToSprint,
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                    modifier = Modifier.height(38.dp),
                ) {
                    Icon(Icons.Outlined.Bolt, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(5.dp))
                    Text("Sprint (${dueCards.size})")
                }
                if (dailyStreak > 0) {
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = SumiElevated,
                        border = BorderStroke(1.dp, SumiBorder),
                    ) {
                        Text(
                            text = "🔥 ${dailyStreak}d",
                            style = MaterialTheme.typography.labelMedium,
                            color = AmberAccent,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { viewModel.refreshSync() }) {
                    if (syncing) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    } else {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Sync")
                    }
                }
                IconButton(onClick = {
                    viewModel.clearAddAnimeError()
                    addDialogOpen = true
                }) {
                    Icon(Icons.Outlined.Add, contentDescription = "Add anime")
                }
                IconButton(onClick = { accountDialogOpen = true }) {
                    Icon(
                        Icons.Outlined.Settings,
                        contentDescription = "Account & Study Settings",
                        tint = WashiMuted
                    )
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        Text("Anime Library", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Process an entire anime in one tap or pick an episode to unlock Watch-Ready comprehension.",
            style = MaterialTheme.typography.bodyMedium,
            color = WashiMuted,
        )
        Spacer(Modifier.height(14.dp))

        val visibleError = addAnimeError ?: removeError ?: syncError
        if (!visibleError.isNullOrBlank()) {
            Text(
                text = visibleError,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(bottom = 10.dp),
            )
        }

        val pendingAdd = addingAnime
        if (pendingAdd != null) {
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 10.dp),
                shape = RoundedCornerShape(18.dp),
                colors = CardDefaults.cardColors(containerColor = SumiSurface),
                border = BorderStroke(1.dp, VermilionPrimary.copy(alpha = 0.55f)),
            ) {
                Column(
                    modifier = Modifier.padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (!pendingAdd.coverUrl.isNullOrBlank()) {
                            AsyncImage(
                                model = pendingAdd.coverUrl,
                                contentDescription = pendingAdd.title,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .size(width = 44.dp, height = 60.dp)
                                    .clip(RoundedCornerShape(8.dp)),
                            )
                            Spacer(Modifier.width(12.dp))
                        }
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Adding \"${pendingAdd.title}\"…",
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = if (pendingAdd.episodeCount > 0) {
                                    "Setting up ${pendingAdd.episodeCount} episodes in your library…"
                                } else {
                                    "Setting up episodes in your library…"
                                },
                                style = MaterialTheme.typography.labelMedium,
                                color = WashiMuted,
                            )
                        }
                        Spacer(Modifier.width(8.dp))
                        CircularProgressIndicator(
                            strokeWidth = 2.5.dp,
                            color = VermilionPrimary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    LinearProgressIndicator(
                        color = VermilionPrimary,
                        trackColor = SumiElevated,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(4.dp)
                            .clip(RoundedCornerShape(4.dp)),
                    )
                }
            }
        }

        if (groupedByAnime.isEmpty() && pendingAdd == null) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(18.dp),
                colors = CardDefaults.cardColors(containerColor = SumiSurface),
                border = BorderStroke(1.dp, SumiBorder),
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = if (syncing) "Loading your library…" else "No anime in your library yet",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Button(
                        onClick = {
                            viewModel.clearAddAnimeError()
                            addDialogOpen = true
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                        shape = RoundedCornerShape(12.dp),
                    ) {
                        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Add Anime")
                    }
                }
            }
        } else if (groupedByAnime.isNotEmpty()) {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(groupedByAnime, key = { it.first().animeId }) { animeEps ->
                    val head = animeEps.first()
                    val realEps = animeEps.filterNot { it.episodeId.startsWith("placeholder:") }
                    val readyCount = realEps.count { it.processingStatus == "ready" }
                    val unprocessedEps = realEps.filter { it.processingStatus != "ready" }
                    val activeBatch = batchProcessState?.takeIf { it.animeId == head.animeId }
                    val anotherBatchRunning = batchProcessState != null && activeBatch == null
                    val isExpanded = expandedAnimeId == head.animeId
                    val seasonsMap = remember(realEps) { realEps.groupBy { it.seasonNumber } }
                    val showSeasonHeaders = seasonsMap.size > 1 || (seasonsMap.keys.firstOrNull() ?: 1) > 1

                    Card(
                        shape = RoundedCornerShape(18.dp),
                        colors = CardDefaults.cardColors(containerColor = SumiSurface),
                        border = BorderStroke(1.dp, SumiBorder),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        expandedAnimeId = if (isExpanded) null else head.animeId
                                    },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (!head.coverUrl.isNullOrBlank()) {
                                    AsyncImage(
                                        model = head.coverUrl,
                                        contentDescription = head.animeTitle,
                                        contentScale = ContentScale.Crop,
                                        modifier = Modifier
                                            .size(width = 52.dp, height = 72.dp)
                                            .clip(RoundedCornerShape(10.dp)),
                                    )
                                    Spacer(Modifier.width(12.dp))
                                }
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = head.animeTitle,
                                        style = MaterialTheme.typography.titleMedium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    if (!head.animeTitleJp.isNullOrBlank()) {
                                        Text(
                                            text = head.animeTitleJp,
                                            style = MaterialTheme.typography.labelMedium,
                                            color = WashiMuted,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        text = if (realEps.isEmpty()) {
                                            "Episodes syncing · Tap to refresh"
                                        } else {
                                            "$readyCount / ${realEps.size} episodes ready"
                                        },
                                        style = MaterialTheme.typography.labelMedium,
                                        color = WashiMuted,
                                    )
                                }
                                IconButton(
                                    onClick = {
                                        removeError = null
                                        animePendingRemove = head
                                    },
                                    modifier = Modifier.size(36.dp),
                                ) {
                                    Icon(
                                        imageVector = Icons.Outlined.DeleteOutline,
                                        contentDescription = "Remove anime",
                                        tint = WashiMuted,
                                        modifier = Modifier.size(19.dp),
                                    )
                                }
                            }

                            if (activeBatch != null) {
                                Spacer(Modifier.height(10.dp))
                                Surface(
                                    shape = RoundedCornerShape(12.dp),
                                    color = SumiElevated,
                                    border = BorderStroke(1.dp, VermilionPrimary.copy(alpha = 0.45f)),
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Column(
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                                        verticalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Row(
                                            modifier = Modifier.fillMaxWidth(),
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Text(
                                                text = "Processing Ep ${activeBatch.currentEpisodeNumber} · ${activeBatch.done}/${activeBatch.total}",
                                                style = MaterialTheme.typography.labelMedium,
                                                color = WashiForeground,
                                                fontWeight = FontWeight.SemiBold,
                                            )
                                            TextButton(
                                                onClick = { viewModel.cancelProcessAll() },
                                                modifier = Modifier.height(30.dp),
                                            ) {
                                                Icon(
                                                    Icons.Outlined.Close,
                                                    contentDescription = "Stop",
                                                    modifier = Modifier.size(14.dp),
                                                    tint = CrimsonAgain,
                                                )
                                                Spacer(Modifier.width(4.dp))
                                                Text("Stop", style = MaterialTheme.typography.labelMedium, color = CrimsonAgain)
                                            }
                                        }
                                        LinearProgressIndicator(
                                            progress = {
                                                (activeBatch.done.toFloat() / activeBatch.total.coerceAtLeast(1)).coerceIn(0f, 1f)
                                            },
                                            color = VermilionPrimary,
                                            trackColor = SumiSurface,
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                    }
                                }
                            } else if (isExpanded && unprocessedEps.isNotEmpty()) {
                                Spacer(Modifier.height(10.dp))
                                OutlinedButton(
                                    onClick = { viewModel.processAllEpisodes(head.animeId) },
                                    enabled = !anotherBatchRunning,
                                    shape = RoundedCornerShape(12.dp),
                                    border = BorderStroke(1.dp, VermilionPrimary.copy(alpha = 0.65f)),
                                    modifier = Modifier.fillMaxWidth().height(42.dp),
                                ) {
                                    Icon(
                                        Icons.Outlined.PlayArrow,
                                        contentDescription = null,
                                        tint = VermilionPrimary,
                                        modifier = Modifier.size(17.dp),
                                    )
                                    Spacer(Modifier.width(6.dp))
                                    Text(
                                        text = "Process all (${unprocessedEps.size} episodes)",
                                        fontWeight = FontWeight.SemiBold,
                                        color = WashiForeground,
                                    )
                                }
                            }

                            if (isExpanded) {
                                Spacer(Modifier.height(12.dp))
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    if (realEps.isEmpty()) {
                                        for (ep in animeEps) {
                                            EpisodeRowItem(
                                                ep = ep,
                                                isProcessing = false,
                                                onClick = { viewModel.refreshSync() },
                                            )
                                        }
                                    } else {
                                        for ((seasonNum, seasonEps) in seasonsMap) {
                                            if (showSeasonHeaders) {
                                                Text(
                                                    text = "Season $seasonNum",
                                                    style = MaterialTheme.typography.labelMedium,
                                                    fontWeight = FontWeight.SemiBold,
                                                    color = WashiMuted,
                                                    modifier = Modifier.padding(top = 4.dp, bottom = 2.dp),
                                                )
                                            }
                                            for (ep in seasonEps) {
                                                EpisodeRowItem(
                                                    ep = ep,
                                                    isProcessing = ep.episodeId in processingIds,
                                                    onClick = { onOpenEpisode(ep.episodeId) },
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (addDialogOpen) {
        AddAnimeModal(
            viewModel = viewModel,
            onDismiss = { addDialogOpen = false },
        )
    }

    if (accountDialogOpen) {
        AccountSettingsModal(
            viewModel = viewModel,
            onDismiss = { accountDialogOpen = false },
        )
    }

    val targetRemove = animePendingRemove
    if (targetRemove != null) {
        AlertDialog(
            onDismissRequest = { if (!removingAnime) animePendingRemove = null },
            containerColor = SumiSurface,
            title = { Text("Remove from library?") },
            text = {
                Text(
                    "Remove \"${targetRemove.animeTitle}\" from your library? Your graduated SRS progress is preserved.",
                    color = WashiMuted,
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        scope.launch {
                            removingAnime = true
                            removeError = null
                            viewModel.removeAnime(targetRemove.animeId)
                                .onSuccess { animePendingRemove = null }
                                .onFailure { err ->
                                    removeError = err.message ?: "Couldn't remove anime"
                                    animePendingRemove = null
                                }
                            removingAnime = false
                        }
                    },
                    enabled = !removingAnime,
                    colors = ButtonDefaults.buttonColors(containerColor = CrimsonAgain),
                ) {
                    Text(if (removingAnime) "Removing…" else "Remove")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { animePendingRemove = null },
                    enabled = !removingAnime,
                ) {
                    Text("Cancel")
                }
            },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AccountSettingsModal(
    viewModel: TataniViewModel,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val session by viewModel.session.collectAsState()
    val boostersEnabled by viewModel.boostersEnabled.collectAsState()
    val scope = rememberCoroutineScope()

    var savingPrefs by remember { mutableStateOf(false) }
    var settingsError by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }

    val currentLang = session?.learningLanguage ?: "ja"
    val currentLevel = session?.userLevel ?: "none"

    val languages = remember {
        listOf(
            "ja" to "Japanese",
            "es" to "Spanish",
            "fr" to "French",
            "de" to "German",
        )
    }

    val levelOptions = remember(currentLang) {
        if (currentLang == "ja") {
            listOf("none", "N5", "N4", "N3", "N2", "N1")
        } else {
            listOf("none", "A1", "A2", "B1", "B2", "C1", "C2")
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = SumiSurface,
        title = { Text("Account & Study Settings") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = session?.email ?: "Signed in",
                    style = MaterialTheme.typography.bodyMedium,
                    color = WashiMuted,
                )

                if (!settingsError.isNullOrBlank()) {
                    Text(
                        text = settingsError!!,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                HorizontalDivider(color = SumiBorder)

                // Learning Language Selector
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = "Learning Language",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        for ((code, label) in languages) {
                            val selected = currentLang == code
                            FilterChip(
                                selected = selected,
                                onClick = {
                                    if (!selected && !savingPrefs) {
                                        scope.launch {
                                            savingPrefs = true
                                            settingsError = null
                                            viewModel.updateLearningLanguage(code)
                                                .onFailure { err ->
                                                    settingsError = err.message ?: "Failed to switch language"
                                                }
                                            savingPrefs = false
                                        }
                                    }
                                },
                                enabled = !savingPrefs && !deleting,
                                label = { Text(label) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = VermilionPrimary.copy(alpha = 0.22f),
                                    selectedLabelColor = WashiForeground,
                                ),
                            )
                        }
                    }
                }

                // Proficiency Level Selector
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = if (currentLang == "ja") "JLPT Level" else "CEFR Level",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = "Words below your level are auto-marked known.",
                        style = MaterialTheme.typography.labelMedium,
                        color = WashiMuted,
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        for (lvl in levelOptions) {
                            val selected = currentLevel.equals(lvl, ignoreCase = true)
                            FilterChip(
                                selected = selected,
                                onClick = {
                                    if (!selected && !savingPrefs) {
                                        scope.launch {
                                            savingPrefs = true
                                            settingsError = null
                                            viewModel.updateUserLevel(lvl)
                                                .onFailure { err ->
                                                    settingsError = err.message ?: "Failed to update level"
                                                }
                                            savingPrefs = false
                                        }
                                    }
                                },
                                enabled = !savingPrefs && !deleting,
                                label = { Text(if (lvl == "none") "None" else lvl.uppercase()) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = VermilionPrimary.copy(alpha = 0.22f),
                                    selectedLabelColor = WashiForeground,
                                ),
                            )
                        }
                    }
                }

                HorizontalDivider(color = SumiBorder)

                // Booster Notification Toggle
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f).padding(end = 8.dp)) {
                        Text(
                            text = "Due Booster Notifications",
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = "Hourly self-check cards during daytime (9:00–20:59)",
                            style = MaterialTheme.typography.labelMedium,
                            color = WashiMuted,
                        )
                    }
                    Switch(
                        checked = boostersEnabled,
                        onCheckedChange = { viewModel.setBoostersEnabled(it) },
                    )
                }

                HorizontalDivider(color = SumiBorder)

                OutlinedButton(
                    onClick = {
                        CustomTabsIntent.Builder().build()
                            .launchUrl(context, Uri.parse("https://sroettger.github.io/Tatani/privacy"))
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Privacy Policy & Data Info")
                }

                OutlinedButton(
                    onClick = {
                        onDismiss()
                        viewModel.signOut()
                    },
                    enabled = !deleting,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Sign out")
                }

                if (!confirmDelete) {
                    TextButton(
                        onClick = {
                            settingsError = null
                            confirmDelete = true
                        },
                        enabled = !deleting,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Delete my study & account data", color = MaterialTheme.colorScheme.error)
                    }
                } else {
                    Button(
                        onClick = {
                            scope.launch {
                                deleting = true
                                settingsError = null
                                val res = viewModel.deleteAccountData()
                                deleting = false
                                res.onSuccess {
                                    onDismiss()
                                }.onFailure { err ->
                                    settingsError = err.message
                                        ?: "Account deletion failed. Check your connection and try again."
                                }
                            }
                        },
                        enabled = !deleting,
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (deleting) "Deleting…" else "Confirm permanent data deletion")
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss, enabled = !deleting) { Text("Close") }
        },
    )
}

@Composable
private fun EpisodeRowItem(
    ep: LibraryEpisodeEntity,
    isProcessing: Boolean,
    onClick: () -> Unit,
) {
    val isPlaceholder = ep.episodeId.startsWith("placeholder:")
    val isFailed = ep.processingStatus == "error" || ep.processingStatus == "failed"
    val effectiveProcessing = isProcessing || ep.processingStatus == "processing"
    val epTitle = ep.episodeTitleEn?.takeIf { it.isNotBlank() }
        ?: ep.episodeTitleJp?.takeIf { it.isNotBlank() }

    val coverage = SrsEngine.computeComprehensionPercent(ep.knownWords, ep.totalWords)
    val isWatchReady = ep.processingStatus == "ready" && ep.totalWords > 0 && coverage >= SrsEngine.WATCH_READY_COVERAGE_PCT

    val (badgeText, badgeBg, badgeFg) = when {
        effectiveProcessing -> Triple("Processing…", AmberAccent.copy(alpha = 0.18f), AmberAccent)
        isWatchReady -> Triple("🎬 Watch-Ready", JadeSuccess.copy(alpha = 0.22f), JadeSuccess)
        ep.processingStatus == "ready" -> Triple("Ready", JadeSuccess.copy(alpha = 0.14f), JadeSuccess)
        isFailed -> Triple("Retry", CrimsonAgain.copy(alpha = 0.18f), CrimsonAgain)
        else -> Triple("Process", SumiSurface, WashiMuted)
    }

    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        color = SumiElevated,
        border = BorderStroke(1.dp, SumiBorder),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f).padding(end = 8.dp)) {
                    Text(
                        text = when {
                            isPlaceholder -> "Syncing episode catalog…"
                            epTitle != null -> "Episode ${ep.episodeNumber} · $epTitle"
                            else -> "Episode ${ep.episodeNumber}"
                        },
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val subtitle = when {
                        isPlaceholder -> "Tap to refresh episodes from server"
                        effectiveProcessing -> "Extracting vocabulary in background…"
                        ep.processingStatus == "ready" ->
                            if (ep.unlearnedWords == 0) "100% mastered · Ready to watch"
                            else "${ep.unlearnedWords} to learn · $coverage% comprehension"
                        isFailed -> "Extraction failed · Tap to retry or import subtitles"
                        else -> "Tap to fetch or import subtitles"
                    }
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.labelMedium,
                        color = WashiMuted,
                    )
                }

                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = badgeBg,
                ) {
                    Text(
                        text = badgeText,
                        style = MaterialTheme.typography.labelMedium,
                        color = badgeFg,
                        modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                }
            }

            if (ep.processingStatus == "ready" && ep.totalWords > 0) {
                Spacer(Modifier.height(6.dp))
                LinearProgressIndicator(
                    progress = { (coverage / 100f).coerceIn(0f, 1f) },
                    color = if (isWatchReady) JadeSuccess else VermilionPrimary,
                    trackColor = SumiSurface,
                    modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(4.dp)),
                )
            }
        }
    }
}

@Composable
private fun AddAnimeModal(
    viewModel: TataniViewModel,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val addingAnime by viewModel.addingAnime.collectAsState()
    val addAnimeError by viewModel.addAnimeError.collectAsState()
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var searchErrorText by remember { mutableStateOf<String?>(null) }
    var results by remember { mutableStateOf<List<AnimeSearchResultDto>>(emptyList()) }

    val activeError = addAnimeError ?: searchErrorText

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = SumiSurface,
        title = { Text("Add Anime") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = { Text("Search AniList…") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        onClick = {
                            if (query.isBlank()) return@Button
                            scope.launch {
                                searching = true
                                searchErrorText = null
                                viewModel.clearAddAnimeError()
                                viewModel.searchAnime(query)
                                    .onSuccess { results = it }
                                    .onFailure { searchErrorText = it.message }
                                searching = false
                            }
                        },
                        enabled = !searching && query.isNotBlank(),
                        colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                    ) {
                        if (searching) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                color = WashiForeground,
                                modifier = Modifier.size(16.dp),
                            )
                        } else {
                            Text("Go")
                        }
                    }
                }

                val inFlight = addingAnime
                if (inFlight != null) {
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = SumiElevated,
                        border = BorderStroke(1.dp, VermilionPrimary.copy(alpha = 0.5f)),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = if (inFlight.episodeCount > 0) {
                                    "Adding \"${inFlight.title}\" (${inFlight.episodeCount} eps)… Safe to close — continues in background."
                                } else {
                                    "Adding \"${inFlight.title}\"… Safe to close — continues in background."
                                },
                                style = MaterialTheme.typography.labelMedium,
                                color = WashiForeground,
                            )
                            LinearProgressIndicator(
                                color = VermilionPrimary,
                                trackColor = SumiSurface,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(3.dp)
                                    .clip(RoundedCornerShape(3.dp)),
                            )
                        }
                    }
                }

                if (!activeError.isNullOrBlank()) {
                    Text(activeError, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
                }

                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.height(280.dp),
                ) {
                    items(results, key = { it.anilistId }) { item ->
                        val isAddingThis = inFlight?.anilistId == item.anilistId
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = SumiElevated,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Row(
                                modifier = Modifier.padding(10.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(modifier = Modifier.weight(1f).padding(end = 8.dp)) {
                                    Text(
                                        text = item.titleEn ?: item.titleRomaji,
                                        fontWeight = FontWeight.SemiBold,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    val epLabel = if (item.episodeCount > 0) "${item.episodeCount} eps" else "? eps"
                                    val yearLabel = item.year?.toString().orEmpty()
                                    Text(
                                        text = if (yearLabel.isNotBlank()) "$epLabel · $yearLabel" else epLabel,
                                        style = MaterialTheme.typography.labelMedium,
                                        color = WashiMuted,
                                    )
                                }
                                OutlinedButton(
                                    onClick = {
                                        searchErrorText = null
                                        viewModel.enqueueAddAnime(item, onSuccess = onDismiss)
                                    },
                                    enabled = inFlight == null,
                                ) {
                                    if (isAddingThis) {
                                        CircularProgressIndicator(
                                            strokeWidth = 2.dp,
                                            color = VermilionPrimary,
                                            modifier = Modifier.size(14.dp),
                                        )
                                        Spacer(Modifier.width(6.dp))
                                        Text("Adding…")
                                    } else {
                                        Text("Add")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        },
    )
}
