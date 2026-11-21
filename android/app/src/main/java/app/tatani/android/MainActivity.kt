package app.tatani.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.tatani.android.ui.TataniViewModel
import app.tatani.android.ui.screens.AuthScreen
import app.tatani.android.ui.screens.EpisodeScreen
import app.tatani.android.ui.screens.LearnScreen
import app.tatani.android.ui.screens.LibraryScreen
import app.tatani.android.ui.screens.SprintScreen
import app.tatani.android.ui.theme.SumiBackground
import app.tatani.android.ui.theme.TataniTheme

class MainActivity : ComponentActivity() {
    private val viewModel: TataniViewModel by viewModels()
    private var pendingDeepRoute by mutableStateOf<String?>(null)

    private val requestNotificationPerm = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Optional booster notifications enabled if granted */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIncomingIntent(intent)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotificationPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            TataniTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = SumiBackground,
                ) {
                    val session by viewModel.session.collectAsState()
                    val authBusy by viewModel.authBusy.collectAsState()
                    val authMessage by viewModel.authMessage.collectAsState()

                    if (session == null) {
                        AuthScreen(
                            viewModel = viewModel,
                            busy = authBusy,
                            message = authMessage,
                        )
                    } else {
                        val navController = rememberNavController()

                        LaunchedEffect(pendingDeepRoute) {
                            val target = pendingDeepRoute ?: return@LaunchedEffect
                            pendingDeepRoute = null
                            navController.navigate(target) {
                                launchSingleTop = true
                            }
                        }

                        // Always boot straight into full-screen distraction-free Sprint mode
                        NavHost(
                            navController = navController,
                            startDestination = "sprint",
                        ) {
                            composable("sprint") {
                                SprintScreen(
                                    viewModel = viewModel,
                                    onOpenLibrary = { navController.navigate("library") },
                                    onOpenLearn = { epId ->
                                        if (epId != null) navController.navigate("learn?episodeId=$epId")
                                        else navController.navigate("learn")
                                    },
                                )
                            }
                            composable(
                                route = "learn?episodeId={episodeId}",
                                arguments = listOf(
                                    navArgument("episodeId") {
                                        type = NavType.StringType
                                        nullable = true
                                        defaultValue = null
                                    }
                                ),
                            ) { backStackEntry ->
                                val epId = backStackEntry.arguments?.getString("episodeId")
                                LearnScreen(
                                    viewModel = viewModel,
                                    episodeId = epId,
                                    onBack = { navController.popBackStack() },
                                    onGoSprint = {
                                        navController.navigate("sprint") {
                                            popUpTo("sprint") { inclusive = true }
                                        }
                                    },
                                    onGoLibrary = { navController.navigate("library") },
                                )
                            }
                            composable("library") {
                                LibraryScreen(
                                    viewModel = viewModel,
                                    onBackToSprint = {
                                        navController.navigate("sprint") {
                                            popUpTo("sprint") { inclusive = true }
                                        }
                                    },
                                    onOpenEpisode = { epId ->
                                        navController.navigate("episode/$epId")
                                    },
                                )
                            }
                            composable("episode/{episodeId}") { backStackEntry ->
                                val epId = backStackEntry.arguments?.getString("episodeId").orEmpty()
                                EpisodeScreen(
                                    viewModel = viewModel,
                                    episodeId = epId,
                                    onBack = { navController.popBackStack() },
                                    onStartLearn = { id ->
                                        navController.navigate("learn?episodeId=$id")
                                    },
                                    onGoSprint = {
                                        navController.navigate("sprint") {
                                            popUpTo("sprint") { inclusive = true }
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "tatani") return
        when (uri.host) {
            "auth-callback" -> viewModel.onOAuthDeepLink(uri)
            "learn" -> pendingDeepRoute = "learn"
            "library" -> pendingDeepRoute = "library"
            "sprint" -> pendingDeepRoute = "sprint"
        }
    }
}
