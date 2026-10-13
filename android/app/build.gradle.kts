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
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    // The Site map tab is the web page itself (web/site.html and its scripts),
    // bundled so it is the same page, same math, as the hosted one.
    sourceSets["main"].assets.srcDir("../../web")
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
    implementation("androidx.webkit:webkit:1.11.0") // WebViewAssetLoader: serves the bundled page over https
    // USB-C/OTG serial access to the rover receiver plugged into the phone directly
    // (FTDI/CP210x/CH34x chip support - covers the FT231X this project's receivers use).
    implementation("com.github.mik3y:usb-serial-for-android:3.7.0")
    // JSON: org.json, built into Android. Unit tests run on the plain JVM,
    // where Android's copy is a stub, so they get the real library.

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
