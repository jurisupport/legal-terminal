# legal-terminal Android

Android companion app for the SSH-only mobile workflow.

## Scope

- Keeps the desktop Electron app untouched.
- Starts as a native Android WebView shell loading `app/src/main/assets/android-interface-sample.html`.
- v1 target is SSH-only: remote cases, remote Agent, remote terminal, remote text/Markdown files, and remote court-record PDF viewing.
- Local folders, local Claude, HWP handling, and PDF generation/export are out of scope for v1.

## Open

Open this `android/` directory in Android Studio.

This machine is configured with:

- JDK 17 via Homebrew.
- Android command line tools at `/opt/homebrew/share/android-commandlinetools`.
- SDK platform `android-35`.
- Gradle wrapper `./gradlew`.

## Check

```sh
python3 check_android_scaffold.py
```

## Build

```sh
./gradlew assembleDebug
```

Debug APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Done

- Native WebView bridge.
- SharedPreferences-backed SSH profile storage hooks.
- Agent and terminal UI calls routed through the bridge when running inside Android.
- Local debug APK build.

## First Milestones

1. Prove remote `claude` stream-json over SSH.
2. Prove remote PTY shell.
3. Add SFTP list/read/write for text and Markdown.
