plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

val envVersionCode = System.getenv("ANDROID_VERSION_CODE")?.toIntOrNull() ?: 100
val envVersionName = System.getenv("ANDROID_VERSION_NAME")?.trim()?.takeIf { it.isNotEmpty() } ?: "2.0.0"

val envSupabaseUrl = System.getenv("SUPABASE_URL")?.trim()?.takeIf { it.isNotEmpty() }
    ?: System.getenv("VITE_SUPABASE_URL")?.trim()?.takeIf { it.isNotEmpty() }
    ?: "https://placeholder.supabase.co"
val envSupabaseAnonKey = System.getenv("SUPABASE_ANON_KEY")?.trim()?.takeIf { it.isNotEmpty() }
    ?: System.getenv("VITE_SUPABASE_PUBLISHABLE_KEY")?.trim()?.takeIf { it.isNotEmpty() }
    ?: "public-anon-placeholder-key"

val keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")?.trim()
val keystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val keyAliasName = System.getenv("ANDROID_KEY_ALIAS")
val keyPasswordValue = System.getenv("ANDROID_KEY_PASSWORD")
val hasReleaseSigning = !keystorePath.isNullOrEmpty() && file(keystorePath).exists()

android {
    namespace = "app.tatani.android"
    compileSdk = 36
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.tsuro.tatani"
        minSdk = 24
        targetSdk = 36
        versionCode = envVersionCode
        versionName = envVersionName

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            debugSymbolLevel = "SYMBOL_TABLE"
        }

        buildConfigField(
            "String",
            "SUPABASE_URL",
            "\"${envSupabaseUrl.replace("\"", "\\\"")}\""
        )
        buildConfigField(
            "String",
            "SUPABASE_ANON_KEY",
            "\"${envSupabaseAnonKey.replace("\"", "\\\"")}\""
        )
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = keyAliasName
                keyPassword = keyPasswordValue
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.2")

    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.navigation:navigation-compose:2.8.4")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Room local-first SQLite deck + outbox persistence
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // WorkManager background sync + graduated SRS notifications
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // Supabase Auth, PostgREST & Edge Functions over OkHttp + kotlinx.serialization
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Anime cover art loading
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Browser Custom Tabs for Google OAuth & Privacy Policy
    implementation("androidx.browser:browser:1.8.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
