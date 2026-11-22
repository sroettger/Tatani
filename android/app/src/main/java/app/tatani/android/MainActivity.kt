package app.tatani.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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
import app.tatani.android.ui.theme.JadeSuccess
import app.tatani.android.ui.theme.SumiBackground
import app.tatani.android.ui.theme.SumiElevated
import app.tatani.android.ui.theme.TataniTheme
import app.tatani.android.ui.theme.WashiForeground
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability

class MainActivity : ComponentActivity() {
    private val viewModel: TataniViewModel by viewModels()
    private var pendingDeepRoute by mutableStateOf<String?>(null)
    private var updateReadyToInstall by mutableStateOf(false)
    private var updatePromptedThisSession = false
    private var appUpdateManager: AppUpdateManager? = null

    private val installStateListener = InstallStateUpdatedListener { state ->
        if (state.installStatus() == InstallStatus.DOWNLOADED) {
            updateReadyToInstall = true
        }
    }

    private val updateFlowLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode != Activity.RESULT_OK) {
            updatePromptedThisSession = true
        }
    }

    private val requestNotificationPerm = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* Optional booster notifications enabled if granted */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) {
            handleIncomingIntent(intent)
        }
        appUpdateManager = runCatching {
            AppUpdateManagerFactory.create(applicationContext).also {
                it.registerListener(installStateListener)
            }
        }.getOrNull()
        checkPlayInAppUpdate(allowPrompt = true)

        setContent {
            TataniTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = SumiBackground,
                ) {
                    Box(modifier = Modifier.fillMaxSize()) {
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
                            LaunchedEffect(session?.userId) {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                                    ContextCompat.checkSelfPermission(
                                        this@MainActivity,
                                        Manifest.permission.POST_NOTIFICATIONS
                                    ) != PackageManager.PERMISSION_GRANTED
                                ) {
                                    requestNotificationPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
                                }
                            }

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
                                            if (epId != null) {
                                                navController.navigate("learn?episodeId=${Uri.encode(epId)}")
                                            } else {
                                                navController.navigate("learn")
                                            }
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
                                            navController.navigate("episode/${Uri.encode(epId)}")
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
                                            navController.navigate("learn?episodeId=${Uri.encode(id)}")
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

                        if (updateReadyToInstall) {
                            Surface(
                                modifier = Modifier
                                    .align(Alignment.BottomCenter)
                                    .navigationBarsPadding()
                                    .padding(horizontal = 20.dp, vertical = 14.dp),
                                shape = RoundedCornerShape(999.dp),
                                color = SumiElevated,
                                border = BorderStroke(1.dp, JadeSuccess.copy(alpha = 0.55f)),
                                shadowElevation = 6.dp,
                            ) {
                                Row(
                                    modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Text(
                                        text = "App update downloaded",
                                        color = WashiForeground,
                                    )
                                    TextButton(
                                        onClick = {
                                            updateReadyToInstall = false
                                            runCatching { appUpdateManager?.completeUpdate() }
                                        }
                                    ) {
                                        Text(
                                            text = "Restart",
                                            color = JadeSuccess,
                                            fontWeight = FontWeight.SemiBold,
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

    override fun onStart() {
        super.onStart()
        viewModel.onAppForegrounded()
    }

    override fun onResume() {
        super.onResume()
        checkPlayInAppUpdate(allowPrompt = false)
    }

    override fun onDestroy() {
        runCatching { appUpdateManager?.unregisterListener(installStateListener) }
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun checkPlayInAppUpdate(allowPrompt: Boolean) {
        val manager = appUpdateManager ?: return
        manager.appUpdateInfo.addOnSuccessListener { info ->
            if (info.installStatus() == InstallStatus.DOWNLOADED) {
                updateReadyToInstall = true
                return@addOnSuccessListener
            }
            if (allowPrompt &&
                !updatePromptedThisSession &&
                info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE &&
                info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)
            ) {
                updatePromptedThisSession = true
                runCatching {
                    manager.startUpdateFlowForResult(
                        info,
                        updateFlowLauncher,
                        AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build(),
                    )
                }
            }
        }
    }

    private fun handleIncomingIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "tatani") return
        when (uri.host) {
            "auth-callback" -> viewModel.onOAuthDeepLink(uri.toString())
            "learn" -> {
                val epId = uri.getQueryParameter("episodeId")?.takeIf { it.isNotBlank() }
                pendingDeepRoute = if (epId != null) {
                    "learn?episodeId=${Uri.encode(epId)}"
                } else {
                    "learn"
                }
            }
            "library" -> pendingDeepRoute = "library"
            "sprint" -> pendingDeepRoute = "sprint"
        }
    }
}
