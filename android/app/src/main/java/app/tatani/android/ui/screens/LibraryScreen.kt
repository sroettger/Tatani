package app.tatani.android.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Refresh
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.tatani.android.data.local.LibraryEpisodeEntity
import app.tatani.android.data.remote.AnimeSearchResultDto
import app.tatani.android.ui.TataniViewModel
import app.tatani.android.ui.theme.JadeSuccess
import app.tatani.android.ui.theme.SumiBorder
import app.tatani.android.ui.theme.SumiElevated
import app.tatani.android.ui.theme.SumiSurface
import app.tatani.android.ui.theme.VermilionPrimary
import app.tatani.android.ui.theme.WashiMuted
import coil.compose.AsyncImage
import kotlinx.coroutines.launch

@Composable
fun LibraryScreen(
    viewModel: TataniViewModel,
    onBackToSprint: () -> Unit,
    onOpenEpisode: (String) -> Unit,
) {
    val episodes by viewModel.libraryEpisodes.collectAsState()
    val syncing by viewModel.syncing.collectAsState()
    val syncError by viewModel.syncError.collectAsState()
    val dueCards by viewModel.dueCards.collectAsState()

    val groupedByAnime = remember(episodes) {
        episodes.groupBy { it.animeId }.values.toList()
    }

    var expandedAnimeId by remember(groupedByAnime.firstOrNull()?.firstOrNull()?.animeId) {
        mutableStateOf(groupedByAnime.firstOrNull()?.firstOrNull()?.animeId)
    }
    var addDialogOpen by remember { mutableStateOf(false) }
    var accountDialogOpen by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        // Top Header with 1-Tap Switch Back to Sprint
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
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

            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { viewModel.refreshSync() }) {
                    if (syncing) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    } else {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Sync")
                    }
                }
                IconButton(onClick = { addDialogOpen = true }) {
                    Icon(Icons.Outlined.Add, contentDescription = "Add anime")
                }
                IconButton(onClick = { accountDialogOpen = true }) {
                    Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = "Account & Privacy", tint = WashiMuted)
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        Text("Anime Library", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Select an episode to fetch subtitles, triage vocabulary, or learn new words in context.",
            style = MaterialTheme.typography.bodyMedium,
            color = WashiMuted,
        )
        Spacer(Modifier.height(14.dp))

        if (!syncError.isNullOrBlank()) {
            Text(
                text = syncError!!,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(bottom = 10.dp),
            )
        }

        if (groupedByAnime.isEmpty()) {
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
                        onClick = { addDialogOpen = true },
                        colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                        shape = RoundedCornerShape(12.dp),
                    ) {
                        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Add Anime")
                    }
                }
            }
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(groupedByAnime, key = { it.first().animeId }) { animeEps ->
                    val head = animeEps.first()
                    val readyCount = animeEps.count { it.processingStatus == "ready" }
                    val isExpanded = expandedAnimeId == head.animeId

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
                                        text = "$readyCount / ${animeEps.size} episodes ready",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = WashiMuted,
                                    )
                                }
                            }

                            if (isExpanded) {
                                Spacer(Modifier.height(12.dp))
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    for (ep in animeEps) {
                                        EpisodeRowItem(
                                            ep = ep,
                                            onClick = {
                                                if (ep.episodeId.startsWith("placeholder:")) {
                                                    viewModel.refreshSync()
                                                } else {
                                                    onOpenEpisode(ep.episodeId)
                                                }
                                            },
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

    if (addDialogOpen) {
        AddAnimeModal(
            viewModel = viewModel,
            onDismiss = { addDialogOpen = false },
        )
    }

    if (accountDialogOpen) {
        AccountPrivacyModal(
            viewModel = viewModel,
            onDismiss = { accountDialogOpen = false },
        )
    }
}

@Composable
private fun AccountPrivacyModal(
    viewModel: TataniViewModel,
    onDismiss: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val session by viewModel.session.collectAsState()
    val scope = rememberCoroutineScope()
    var confirmDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = SumiSurface,
        title = { Text("Account & Privacy") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = session?.email ?: "Signed in",
                    style = MaterialTheme.typography.bodyMedium,
                    color = WashiMuted,
                )
                OutlinedButton(
                    onClick = {
                        androidx.browser.customtabs.CustomTabsIntent.Builder().build()
                            .launchUrl(context, android.net.Uri.parse("https://sroettger.github.io/Tatani/privacy"))
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
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Sign out")
                }
                if (!confirmDelete) {
                    TextButton(
                        onClick = { confirmDelete = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("Delete my study & account data", color = MaterialTheme.colorScheme.error)
                    }
                } else {
                    Button(
                        onClick = {
                            scope.launch {
                                deleting = true
                                viewModel.deleteAccountData()
                                deleting = false
                                onDismiss()
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
            TextButton(onClick = onDismiss) { Text("Close") }
        },
    )
}

@Composable
private fun EpisodeRowItem(
    ep: LibraryEpisodeEntity,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        color = SumiElevated,
        border = BorderStroke(1.dp, SumiBorder),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text(
                    text = "Episode ${ep.episodeNumber}",
                    fontWeight = FontWeight.SemiBold,
                )
                if (ep.processingStatus == "ready") {
                    val coverage = if (ep.totalWords > 0) {
                        ((ep.knownWords * 100) / ep.totalWords)
                    } else 0
                    Text(
                        text = "${ep.unlearnedWords} to learn · $coverage% known",
                        style = MaterialTheme.typography.labelMedium,
                        color = WashiMuted,
                    )
                } else {
                    Text(
                        text = "Tap to fetch subtitles & extract vocab",
                        style = MaterialTheme.typography.labelMedium,
                        color = WashiMuted,
                    )
                }
            }

            Surface(
                shape = RoundedCornerShape(8.dp),
                color = if (ep.processingStatus == "ready") JadeSuccess.copy(alpha = 0.18f) else SumiSurface,
            ) {
                Text(
                    text = if (ep.processingStatus == "ready") "Ready" else "Process",
                    style = MaterialTheme.typography.labelMedium,
                    color = if (ep.processingStatus == "ready") JadeSuccess else WashiMuted,
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
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
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var addingId by remember { mutableStateOf<Int?>(null) }
    var errorText by remember { mutableStateOf<String?>(null) }
    var results by remember { mutableStateOf<List<AnimeSearchResultDto>>(emptyList()) }

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
                                errorText = null
                                viewModel.searchAnime(query)
                                    .onSuccess { results = it }
                                    .onFailure { errorText = it.message }
                                searching = false
                            }
                        },
                        enabled = !searching && query.isNotBlank(),
                        colors = ButtonDefaults.buttonColors(containerColor = VermilionPrimary),
                    ) {
                        Text(if (searching) "…" else "Go")
                    }
                }

                if (!errorText.isNullOrBlank()) {
                    Text(errorText!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
                }

                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.height(280.dp),
                ) {
                    items(results, key = { it.anilistId }) { item ->
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
                                    Text(
                                        text = "${item.episodeCount} eps · ${item.year ?: ""}",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = WashiMuted,
                                    )
                                }
                                OutlinedButton(
                                    onClick = {
                                        scope.launch {
                                            addingId = item.anilistId
                                            viewModel.addAnime(item)
                                                .onSuccess { onDismiss() }
                                                .onFailure { errorText = it.message }
                                            addingId = null
                                        }
                                    },
                                    enabled = addingId == null,
                                ) {
                                    Text(if (addingId == item.anilistId) "…" else "Add")
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
