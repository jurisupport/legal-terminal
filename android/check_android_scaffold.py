from pathlib import Path
import xml.etree.ElementTree as ET


root = Path(__file__).resolve().parent
repo = root.parent

required = [
    "settings.gradle.kts",
    "build.gradle.kts",
    "app/build.gradle.kts",
    "app/src/main/AndroidManifest.xml",
    "app/src/main/java/com/jurisupport/legalterminal/mobile/MainActivity.java",
    "app/src/main/assets/android-interface-sample.html",
]

for name in required:
    assert (root / name).exists(), f"missing {name}"

ET.parse(root / "app/src/main/AndroidManifest.xml")

activity = (root / "app/src/main/java/com/jurisupport/legalterminal/mobile/MainActivity.java").read_text()
asset = (root / "app/src/main/assets/android-interface-sample.html").read_text()
sample = (repo / "docs/android-interface-sample.html").read_text()

for needle in [
    "addJavascriptInterface",
    "@JavascriptInterface",
    "WebChromeClient",
    "SharedPreferences",
    "openUrl",
    "ACTION_VIEW",
    "setToken",
    "hasToken",
    "listCases",
    "getCase",
    "callJuriTool",
    "AndroidKeyStore",
    "getSshProfiles",
    "terminalCommand",
    "agentPrompt",
    "provisionSshKey",
    "testSshLogin",
    "connectSession",
    "ChannelShell",
    "startSshShell",
    "shellInput",
    "listRemoteFiles",
    "syncOneDriveFolder",
    "rcloneCatCommand",
    "hydrateOneDriveCatCommand",
    "readRemoteText",
    "writeRemoteText",
    "resolveSftpPath",
    "enterFullscreen",
    "WindowInsetsController",
]:
    assert needle in activity, f"MainActivity missing {needle}"

for needle in [
    "nativeRequest",
    "initNativeBridge",
    "android-app",
    "viewport-fit=cover",
    "safe-area-inset-bottom",
    "sendAgentPrompt",
    "sendTerminalCommand",
    "loadCases",
    "normalizeCase",
    "saveJsToken",
    "data-open-url",
    "jurisupport.com/profile",
    "autoConnectSsh",
    "openKeyTerminal",
    "pickIdentityFile",
    "pendingSshProfile",
    "sshShellActive",
    "data-pdf-crop",
    "data-record-list",
    "loadRemoteFiles",
    "ensureRemoteFileDoc",
    "saveActiveDoc",
    "data-open-remote-file",
    "data-open-remote-dir",
    "remoteRecordsByCase",
    "loadRemoteRecords",
    "matchRecordCaseDir",
    "parseRemoteRecordEntry",
    "record-columns",
    "record-grip",
    "record-pdf-mode",
    "data-record-panel",
    "data-open-record-pdf",
    "renderRemotePdf",
    "data-sync-records",
    "syncRemoteRecords",
    "cloudPathFromOneDrivePath",
    "data-pdf-flow",
    "data-pdf-prev",
    "data-pdf-jump",
    "pdf-page-controls",
    "pdf-viewer fit-${state.pdfFit}",
    "data-save-doc",
    "remotePairingKey",
    "setCasePairing",
    "data-map-case-drafts",
    "data-map-case-records",
    "data-clear-case-pairing",
    "quickStartPaths",
    "sshQuickStarts",
    "data-remove-ssh-favorite",
    "addRemoteFavorite",
]:
    assert needle in asset, f"asset missing {needle}"

assert asset == sample, "Android asset is not synced with docs sample"

print("android scaffold check: ok")
