plugins {
    id("com.android.application")
}

android {
    namespace = "com.jurisupport.legalterminal.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.jurisupport.legalterminal.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.github.mwiede:jsch:2.28.3")
}
