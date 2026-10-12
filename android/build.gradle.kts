plugins {
    id("com.android.application") version "8.5.0" apply false
    // Kotlin 1.9.24 + Compose compiler 1.5.14 (app/build.gradle.kts) is a
    // documented, matched pair. Kotlin 2.0+ moved the Compose compiler to a
    // separate plugin (org.jetbrains.kotlin.plugin.compose) - mixing that
    // with the older kotlinCompilerExtensionVersion mechanism used below is
    // unreliable, so staying on 1.9.x here is deliberate, not stale. If
    // Android Studio's Gradle sync reports a different required pairing,
    // follow its suggestion - this table changes with new compose releases.
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
