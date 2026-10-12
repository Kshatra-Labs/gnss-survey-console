plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.kshatralabs.gnssconsole"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.kshatralabs.gnssconsole"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.2")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // USB-C/OTG serial access to the rover receiver plugged into the phone directly
    // (FTDI/CP210x/CH34x chip support - covers the FT231X this project's receivers use).
    implementation("com.github.mik3y:usb-serial-for-android:3.7.0")
    // JSON: org.json (built into the Android platform) rather than a codegen-based
    // library - the server's status payloads are heterogeneous dicts, and org.json's
    // JSONObject handles that with no schema/adapter to keep in sync.

    debugImplementation("androidx.compose.ui:ui-tooling")
}
