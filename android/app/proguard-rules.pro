-keepattributes *Annotation*,InnerClasses,Signature,RuntimeVisibleAnnotations
-dontnote kotlinx.serialization.AnnotationsKt

# Keep kotlinx.serialization generated serializers
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class app.tatani.android.**$$serializer { *; }
-keepclassmembers class app.tatani.android.** {
    *** Companion;
}
-keepclasseswithmembers class app.tatani.android.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep Room entities & database implementation
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class * { *; }

# Keep WorkManager CoroutineWorker & BroadcastReceiver entry points
-keep class app.tatani.android.notifications.DueBoosterWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keep class app.tatani.android.notifications.OutboxSyncWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keep class app.tatani.android.notifications.BoosterActionReceiver { *; }
-keep class app.tatani.android.notifications.BoosterOverlayActivity { *; }

# OkHttp / Okio platform warnings
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
