package com.jurisupport.legalterminal.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.KeyPair;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UIKeyboardInteractive;
import com.jcraft.jsch.UserInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Properties;
import java.util.Vector;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "legal_terminal_mobile";
    private static final String KEY_SSH_PROFILES = "ssh_profiles";
    private static final String KEY_LAST_SSH_PROFILE_ID = "last_ssh_profile_id";
    private static final String KEY_HOST_FINGERPRINTS = "ssh_host_fingerprints";
    private static final String KEY_JS_TOKEN = "jurisupport_token";
    private static final String JS_TOKEN_KEY_ALIAS = "legal_terminal_mobile_jurisupport_token";
    private static final String MCP_URL = "https://api.jurisupport.com/mcp";
    private static final int REQUEST_IDENTITY_FILE = 1001;

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setTextZoom(100);

        webView.addJavascriptInterface(new NativeBridge(this), "LegalTerminalAndroid");

        setContentView(webView);
        enterFullscreen();
        webView.loadUrl("file:///android_asset/android-interface-sample.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterFullscreen();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enterFullscreen();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_IDENTITY_FILE) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        try {
            String path = copyIdentityFile(data.getData());
            emitIdentityFilePicked(new JSONObject().put("ok", true).put("path", path));
        } catch (Exception exception) {
            try {
                emitIdentityFilePicked(new JSONObject().put("ok", false).put("error", exception.getMessage()));
            } catch (Exception ignored) {
                emitIdentityFilePicked(new JSONObject());
            }
        }
    }

    private void pickIdentityFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(intent, REQUEST_IDENTITY_FILE);
    }

    private String copyIdentityFile(Uri uri) throws Exception {
        File dir = new File(getFilesDir(), "ssh-keys");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("개인키 저장 폴더를 만들 수 없습니다.");
        File target = new File(dir, safeName(displayName(uri)));
        try (InputStream in = getContentResolver().openInputStream(uri);
             FileOutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new Exception("개인키 파일을 읽을 수 없습니다.");
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        }
        target.setReadable(true, true);
        target.setWritable(true, true);
        return target.getAbsolutePath();
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.trim().isEmpty()) return name;
            }
        } catch (Exception ignored) {
        }
        String fallback = uri.getLastPathSegment();
        return fallback == null || fallback.trim().isEmpty() ? "id_key" : fallback;
    }

    private String safeName(String name) {
        String safe = name.replaceAll("[^A-Za-z0-9._-]+", "_");
        return safe.isEmpty() ? "id_key" : safe;
    }

    private void emitIdentityFilePicked(JSONObject result) {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript(
                "window.__ltIdentityFilePicked&&window.__ltIdentityFilePicked(" + result.toString() + ")",
                null
        ));
    }

    private void enterFullscreen() {
        Window window = getWindow();
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams params = window.getAttributes();
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(params);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getDecorView().getWindowInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            return;
        }

        window.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    private static class NativeBridge {
        private final MainActivity activity;
        private final SharedPreferences prefs;
        private Session shellSession;
        private ChannelShell shellChannel;
        private InputStream shellIn;
        private OutputStream shellOut;
        private String juriSessionId;

        NativeBridge(MainActivity activity) {
            this.activity = activity;
            prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        }

        @JavascriptInterface
        public String request(String json) {
            try {
                JSONObject input = new JSONObject(json == null ? "{}" : json);
                JSONObject payload = input.optJSONObject("payload");
                JSONObject response = new JSONObject().put("ok", true);

                switch (input.optString("method")) {
                    case "ping":
                        return response.put("message", "android").toString();
                    case "openUrl":
                        openUrl(payload);
                        return response.toString();
                    case "setToken":
                        setJuriToken(payload == null ? "" : payload.optString("token", ""));
                        juriSessionId = null;
                        return response.toString();
                    case "hasToken":
                        return response.put("hasToken", !getJuriToken().isEmpty()).toString();
                    case "listCases":
                        return listCases(response, payload).toString();
                    case "getCase":
                        return getCase(response, payload).toString();
                    case "getSshProfiles":
                        return response
                                .put("profiles", new JSONArray(prefs.getString(KEY_SSH_PROFILES, "[]")))
                                .put("lastProfileId", prefs.getString(KEY_LAST_SSH_PROFILE_ID, ""))
                                .toString();
                    case "saveSshProfiles":
                        prefs.edit()
                                .putString(KEY_SSH_PROFILES, payloadArray(payload, "profiles").toString())
                                .apply();
                        return response.toString();
                    case "setLastSshProfileId":
                        prefs.edit()
                                .putString(KEY_LAST_SSH_PROFILE_ID, payload == null ? "" : payload.optString("profileId", ""))
                                .apply();
                        return response.toString();
                    case "clearSshSetup":
                        disconnectShell();
                        prefs.edit()
                                .putString(KEY_SSH_PROFILES, "[]")
                                .putString(KEY_LAST_SSH_PROFILE_ID, "")
                                .apply();
                        deleteTree(new File(activity.getFilesDir(), "ssh-keys"));
                        return response.toString();
                    case "pickIdentityFile":
                        activity.runOnUiThread(() -> {
                            try {
                                activity.pickIdentityFile();
                            } catch (ActivityNotFoundException exception) {
                                try {
                                    activity.emitIdentityFilePicked(new JSONObject()
                                            .put("ok", false)
                                            .put("error", "파일 선택 앱을 열 수 없습니다."));
                                } catch (Exception ignored) {
                                }
                            }
                        });
                        return response.toString();
                    case "listRemoteDirs":
                        return listRemoteDirs(response, payload).toString();
                    case "listRemoteFiles":
                        return listRemoteFiles(response, payload).toString();
                    case "syncOneDriveFolder":
                        return syncOneDriveFolder(response, payload).toString();
                    case "renderRemotePdf":
                        return renderRemotePdf(response, payload).toString();
                    case "readRemoteText":
                        return readRemoteText(response, payload).toString();
                    case "writeRemoteText":
                        return writeRemoteText(response, payload).toString();
                    case "testSshLogin":
                        return testSshLogin(response, payload).toString();
                    case "provisionSshKey":
                        return provisionSshKey(response, payload).toString();
                    case "startSshShell":
                        return startSshShell(response, payload).toString();
                    case "shellInput":
                        return sendShellInput(response, payload == null ? "" : payload.optString("input", "")).toString();
                    case "disconnectSshShell":
                        disconnectShell();
                        return response.toString();
                    case "agentPrompt":
                        return requireProfile(response)
                                .put("message", "SSH Agent 실행부 연결 전입니다.")
                                .toString();
                    case "terminalCommand":
                        String command = payload == null ? "" : payload.optString("command", "");
                        if (shellConnected()) return sendShellInput(response, command).toString();
                        JSONObject profile = requireSshProfile(payload);
                        Session session = connectSession(new JSch(), profile);
                        try {
                            return response.put("output", "$ " + command + "\n" + runExecOutput(session, command)).toString();
                        } finally {
                            session.disconnect();
                        }
                    default:
                        return error("unknown method");
                }
            } catch (Exception exception) {
                return error(exception.getMessage());
            }
        }

        private JSONObject startSshShell(JSONObject response, JSONObject payload) throws Exception {
            JSONObject profile = requireSshProfile(payload);
            disconnectShell();
            try {
                shellSession = connectSession(new JSch(), profile, profile.optBoolean("passwordOnly", false));
                shellChannel = (ChannelShell) shellSession.openChannel("shell");
                shellChannel.setPty(true);
                shellChannel.setPtyType("xterm");
                shellIn = shellChannel.getInputStream();
                shellOut = shellChannel.getOutputStream();
                shellChannel.connect(10000);
                return response.put("output", drainShell(700));
            } catch (Exception exception) {
                disconnectShell();
                throw exception;
            }
        }

        private JSONObject sendShellInput(JSONObject response, String input) throws Exception {
            if (!shellConnected()) {
                return response.put("ok", false).put("error", "SSH 터미널이 연결되어 있지 않습니다.");
            }
            shellOut.write((input + "\n").getBytes("UTF-8"));
            shellOut.flush();
            return response.put("output", drainShell(700));
        }

        private boolean shellConnected() {
            return shellSession != null
                    && shellSession.isConnected()
                    && shellChannel != null
                    && shellChannel.isConnected()
                    && !shellChannel.isClosed();
        }

        private String drainShell(int waitMs) throws Exception {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            long deadline = System.currentTimeMillis() + waitMs;
            byte[] buffer = new byte[4096];
            while (System.currentTimeMillis() < deadline) {
                while (shellIn != null && shellIn.available() > 0) {
                    int n = shellIn.read(buffer);
                    if (n > 0) out.write(buffer, 0, n);
                }
                Thread.sleep(40);
            }
            return out.toString("UTF-8").trim();
        }

        private void disconnectShell() {
            if (shellChannel != null) shellChannel.disconnect();
            if (shellSession != null) shellSession.disconnect();
            shellChannel = null;
            shellSession = null;
            shellIn = null;
            shellOut = null;
        }

        private void openUrl(JSONObject payload) throws Exception {
            String url = payload == null ? "" : payload.optString("url", "").trim();
            if (!url.startsWith("https://jurisupport.com/")) throw new Exception("JuriSupport 링크만 열 수 있습니다.");
            activity.runOnUiThread(() -> activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
        }

        private JSONObject listCases(JSONObject response, JSONObject payload) throws Exception {
            JSONObject args = new JSONObject()
                    .put("page", payload == null ? 1 : payload.optInt("page", 1))
                    .put("limit", payload == null ? 50 : payload.optInt("limit", 50));
            putIfPresent(args, "search", payload == null ? "" : payload.optString("search", ""));
            putIfPresent(args, "status", payload == null ? "" : payload.optString("status", ""));
            putIfPresent(args, "caseType", payload == null ? "" : payload.optString("caseType", ""));
            return response.put("cases", callJuriTool("list_cases", args));
        }

        private JSONObject getCase(JSONObject response, JSONObject payload) throws Exception {
            String id = payload == null ? "" : payload.optString("id", "").trim();
            if (id.isEmpty()) throw new Exception("사건 ID가 없습니다.");
            return response.put("case", callJuriTool("get_case", new JSONObject().put("id", id)));
        }

        private Object callJuriTool(String name, JSONObject args) throws Exception {
            String token = getJuriToken();
            if (token.isEmpty()) throw new Exception("JuriSupport 토큰이 설정되지 않았습니다.");
            if (juriSessionId == null || juriSessionId.isEmpty()) juriSessionId = ensureJuriSession(token);
            JSONObject body = new JSONObject()
                    .put("jsonrpc", "2.0")
                    .put("id", 2)
                    .put("method", "tools/call")
                    .put("params", new JSONObject().put("name", name).put("arguments", args));
            JuriHttpResponse http = rawJuriPost(token, body, juriSessionId);
            JSONObject rpc = parseRpc(http.text);
            JSONObject rpcError = rpc == null ? null : rpc.optJSONObject("error");
            if (rpcError != null && rpcError.optString("message", "").toLowerCase().contains("session")) {
                juriSessionId = ensureJuriSession(token);
                http = rawJuriPost(token, body, juriSessionId);
                rpc = parseRpc(http.text);
                rpcError = rpc == null ? null : rpc.optJSONObject("error");
            }
            if (rpc == null) throw new Exception("JuriSupport 응답을 해석하지 못했습니다. HTTP " + http.status);
            if (rpcError != null) throw new Exception(rpcError.optString("message", "JuriSupport 오류"));
            return toolResult(rpc);
        }

        private String ensureJuriSession(String token) throws Exception {
            JSONObject init = new JSONObject()
                    .put("jsonrpc", "2.0")
                    .put("id", 1)
                    .put("method", "initialize")
                    .put("params", new JSONObject()
                            .put("protocolVersion", "2024-11-05")
                            .put("capabilities", new JSONObject())
                            .put("clientInfo", new JSONObject().put("name", "legal-terminal-mobile").put("version", "0.1.0")));
            JuriHttpResponse response = rawJuriPost(token, init, null);
            if (response.sessionId == null || response.sessionId.isEmpty()) throw new Exception("MCP 초기화 실패: HTTP " + response.status);
            rawJuriPost(token, new JSONObject().put("jsonrpc", "2.0").put("method", "notifications/initialized"), response.sessionId);
            return response.sessionId;
        }

        private JuriHttpResponse rawJuriPost(String token, JSONObject body, String sessionId) throws Exception {
            HttpURLConnection conn = (HttpURLConnection) new URL(MCP_URL).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Accept", "application/json, text/event-stream");
            if (sessionId != null && !sessionId.isEmpty()) conn.setRequestProperty("mcp-session-id", sessionId);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readUtf8(in);
            String nextSessionId = conn.getHeaderField("mcp-session-id");
            conn.disconnect();
            return new JuriHttpResponse(status, nextSessionId, text);
        }

        private JSONObject parseRpc(String text) throws Exception {
            String trimmed = text == null ? "" : text.trim();
            if (trimmed.isEmpty()) return null;
            if (trimmed.startsWith("{")) return new JSONObject(trimmed);
            StringBuilder data = new StringBuilder();
            for (String line : trimmed.split("\\r?\\n")) {
                if (line.startsWith("data:")) data.append(line.substring(5).trim());
            }
            return data.length() == 0 ? null : new JSONObject(data.toString());
        }

        private Object toolResult(JSONObject rpc) throws Exception {
            JSONObject result = rpc.optJSONObject("result");
            if (result == null) return JSONObject.NULL;
            JSONArray content = result.optJSONArray("content");
            if (content == null) return result;
            for (int i = 0; i < content.length(); i++) {
                JSONObject item = content.optJSONObject(i);
                if (item == null || !"text".equals(item.optString("type"))) continue;
                return parseJsonValue(item.optString("text", ""));
            }
            return result;
        }

        private Object parseJsonValue(String text) throws Exception {
            String trimmed = text == null ? "" : text.trim();
            if (trimmed.startsWith("{")) return new JSONObject(trimmed);
            if (trimmed.startsWith("[")) return new JSONArray(trimmed);
            return trimmed;
        }

        private String readUtf8(InputStream in) throws Exception {
            if (in == null) return "";
            StringBuilder out = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) out.append(line).append('\n');
            }
            return out.toString();
        }

        private void setJuriToken(String token) throws Exception {
            String value = token == null ? "" : token.trim();
            if (value.isEmpty()) {
                prefs.edit().remove(KEY_JS_TOKEN).apply();
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, juriTokenKey());
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String data = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            prefs.edit().putString(KEY_JS_TOKEN, iv + ":" + data).apply();
        }

        private String getJuriToken() throws Exception {
            String saved = prefs.getString(KEY_JS_TOKEN, "");
            if (saved.isEmpty()) return "";
            String[] parts = saved.split(":", 2);
            if (parts.length != 2) return "";
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, juriTokenKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        }

        private SecretKey juriTokenKey() throws Exception {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (!keyStore.containsAlias(JS_TOKEN_KEY_ALIAS)) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(
                        JS_TOKEN_KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build());
                generator.generateKey();
            }
            return (SecretKey) keyStore.getKey(JS_TOKEN_KEY_ALIAS, null);
        }

        private JSONObject testSshLogin(JSONObject response, JSONObject payload) throws Exception {
            JSch jsch = new JSch();
            JSONObject profile = requireSshProfile(payload);
            Session session = connectSession(jsch, profile, profile.optBoolean("passwordOnly", false));
            session.disconnect();
            return response.put("message", "로그인 성공");
        }

        private JSONObject provisionSshKey(JSONObject response, JSONObject payload) throws Exception {
            JSONObject profile = requireSshProfile(payload);
            profile.put("identityFile", "");
            profile.put("passwordOnly", true);
            if (profile.optString("password", "").isEmpty()) {
                return response.put("ok", false).put("error", "비밀번호가 필요합니다.");
            }

            JSch jsch = new JSch();
            File dir = new File(activity.getFilesDir(), "ssh-keys");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("개인키 저장 폴더를 만들 수 없습니다.");
            File privateKey = new File(dir, activity.safeName(profile.optString("user") + "@" + profile.optString("host") + "_id_rsa"));
            String comment = "legal-terminal-mobile " + profile.optString("user") + "@" + profile.optString("host");

            KeyPair keyPair = KeyPair.genKeyPair(jsch, KeyPair.RSA, 4096);
            keyPair.setPublicKeyComment(comment);
            try (FileOutputStream out = new FileOutputStream(privateKey)) {
                keyPair.writePrivateKey(out);
            }
            ByteArrayOutputStream publicOut = new ByteArrayOutputStream();
            keyPair.writePublicKey(publicOut, comment);
            keyPair.dispose();
            privateKey.setReadable(true, true);
            privateKey.setWritable(true, true);
            String publicKey = publicOut.toString("UTF-8").trim();

            Session session = connectSession(new JSch(), profile, true);
            try {
                runExec(session, "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && grep -qxF "
                        + shq(publicKey)
                        + " ~/.ssh/authorized_keys || printf '%s\\n' "
                        + shq(publicKey)
                        + " >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys");
            } finally {
                session.disconnect();
            }
            return response
                    .put("identityFile", privateKey.getAbsolutePath())
                    .put("publicKey", publicKey);
        }

        private void deleteTree(File file) {
            if (file == null || !file.exists()) return;
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteTree(child);
            }
            file.delete();
        }

        private JSONObject listRemoteDirs(JSONObject response, JSONObject payload) throws Exception {
            JSch jsch = new JSch();
            JSONObject profile = requireSshProfile(payload);
            Session session = null;
            ChannelSftp sftp = null;
            try {
                session = connectSession(jsch, profile);
                sftp = (ChannelSftp) session.openChannel("sftp");
                sftp.connect(10000);
                String start = payload.optString("path", "~").trim();
                sftp.cd(resolveSftpPath(sftp, start));
                String path = sftp.pwd();
                JSONArray entries = new JSONArray();
                Vector<?> list = sftp.ls(".");
                for (Object item : list) {
                    ChannelSftp.LsEntry entry = (ChannelSftp.LsEntry) item;
                    String name = entry.getFilename();
                    if (!entry.getAttrs().isDir() || ".".equals(name) || "..".equals(name)) continue;
                    entries.put(new JSONObject()
                            .put("name", name)
                            .put("path", childPath(path, name)));
                }
                return response
                        .put("path", path)
                        .put("parent", parentPath(path))
                        .put("entries", entries);
            } finally {
                if (sftp != null) sftp.disconnect();
                if (session != null) session.disconnect();
            }
        }

        private JSONObject listRemoteFiles(JSONObject response, JSONObject payload) throws Exception {
            JSONObject profile = requireSshProfile(payload);
            String mode = payload == null ? "files" : payload.optString("mode", "files");
            Session session = null;
            ChannelSftp sftp = null;
            try {
                session = connectSession(new JSch(), profile);
                sftp = (ChannelSftp) session.openChannel("sftp");
                sftp.connect(10000);
                String start = payload.optString("path", "~").trim();
                sftp.cd(resolveSftpPath(sftp, start));
                String path = sftp.pwd();
                JSONArray entries = new JSONArray();
                Vector<?> list = sftp.ls(".");
                for (Object item : list) {
                    ChannelSftp.LsEntry entry = (ChannelSftp.LsEntry) item;
                    String name = entry.getFilename();
                    if (".".equals(name) || "..".equals(name)) continue;
                    boolean dir = entry.getAttrs().isDir();
                    boolean text = name.matches("(?i).+\\.(md|txt)$");
                    boolean pdf = name.matches("(?i).+\\.pdf$");
                    if (!dir && !(text || ("records".equals(mode) && pdf))) continue;
                    entries.put(new JSONObject()
                            .put("name", name)
                            .put("path", childPath(path, name))
                            .put("dir", dir)
                            .put("pdf", pdf)
                            .put("text", text)
                            .put("size", entry.getAttrs().getSize()));
                }
                return response
                        .put("path", path)
                        .put("parent", parentPath(path))
                        .put("entries", entries);
            } finally {
                if (sftp != null) sftp.disconnect();
                if (session != null) session.disconnect();
            }
        }

        private JSONObject syncOneDriveFolder(JSONObject response, JSONObject payload) throws Exception {
            JSONObject profile = requireSshProfile(payload);
            String path = payload.optString("path", "").trim();
            String direction = payload.optString("direction", "pull").trim();
            if (path.isEmpty()) throw new Exception("동기화할 기록 폴더 경로가 없습니다.");
            if (!"pull".equals(direction) && !"push".equals(direction)) throw new Exception("동기화 방향이 잘못되었습니다.");
            String cloudPath = payload.optString("cloudPath", "").trim();
            if (cloudPath.isEmpty()) cloudPath = oneDriveCloudPath(path);
            if (cloudPath.isEmpty()) throw new Exception("OneDrive 경로가 아닙니다: " + path);
            String command = rcloneCopyCommand(path, cloudPath, direction);
            Session session = null;
            try {
                session = connectSession(new JSch(), profile);
                String output = runExecOutput(session, command, 10 * 60 * 1000, true);
                return response.put("direction", direction).put("path", path).put("output", output);
            } finally {
                if (session != null) session.disconnect();
            }
        }

        private JSONObject readRemoteText(JSONObject response, JSONObject payload) throws Exception {
            JSONObject profile = requireSshProfile(payload);
            String path = payload.optString("path", "").trim();
            if (path.isEmpty()) throw new Exception("파일 경로가 없습니다.");
            Session session = null;
            ChannelSftp sftp = null;
            try {
                session = connectSession(new JSch(), profile);
                sftp = (ChannelSftp) session.openChannel("sftp");
                sftp.connect(10000);
                String realPath = resolveSftpPath(sftp, path);
                long size = sftp.stat(realPath).getSize();
                if (size > 10 * 1024 * 1024) throw new Exception("10MB 넘는 텍스트 파일은 열지 않습니다.");
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (InputStream in = sftp.get(realPath)) {
                    byte[] buffer = new byte[8192];
                    int n;
                    while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                }
                return response
                        .put("path", realPath)
                        .put("name", baseName(realPath))
                        .put("content", out.toString("UTF-8"));
            } finally {
                if (sftp != null) sftp.disconnect();
                if (session != null) session.disconnect();
            }
        }

        private JSONObject renderRemotePdf(JSONObject response, JSONObject payload) throws Exception {
            JSONObject profile = requireSshProfile(payload);
            String path = payload.optString("path", "").trim();
            if (path.isEmpty()) throw new Exception("PDF 경로가 없습니다.");
            int maxPages = Math.max(1, Math.min(payload.optInt("maxPages", 50), 50));
            File dir = new File(activity.getCacheDir(), "remote-pdf");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("PDF 캐시 폴더를 만들 수 없습니다.");
            File pdf = new File(dir, System.currentTimeMillis() + "-" + activity.safeName(baseName(path)));
            Session session = null;
            ChannelSftp sftp = null;
            try {
                session = connectSession(new JSch(), profile);
                sftp = (ChannelSftp) session.openChannel("sftp");
                sftp.connect(10000);
                String realPath = resolveSftpPath(sftp, path);
                long size = sftp.stat(realPath).getSize();
                if (size > 50L * 1024L * 1024L) throw new Exception("50MB 넘는 PDF는 아직 열지 않습니다.");
                try (FileOutputStream out = new FileOutputStream(pdf)) {
                    try (InputStream in = sftp.get(realPath)) {
                        copy(in, out);
                    }
                } catch (Exception sftpFailure) {
                    try (FileOutputStream out = new FileOutputStream(pdf, false)) {
                        String cloudPath = oneDriveCloudPath(realPath);
                        execToStream(session, cloudPath.isEmpty() ? "cat " + shq(realPath) : hydrateOneDriveCatCommand(realPath), out);
                    }
                }

                JSONArray pages = new JSONArray();
                try (ParcelFileDescriptor fd = ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY);
                     PdfRenderer renderer = new PdfRenderer(fd)) {
                    int pageCount = renderer.getPageCount();
                    int count = Math.min(pageCount, maxPages);
                    for (int i = 0; i < count; i++) {
                        try (PdfRenderer.Page page = renderer.openPage(i)) {
                            int width = 1080;
                            int height = Math.max(1, width * page.getHeight() / page.getWidth());
                            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                            bitmap.eraseColor(Color.WHITE);
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                            ByteArrayOutputStream image = new ByteArrayOutputStream();
                            bitmap.compress(Bitmap.CompressFormat.PNG, 90, image);
                            bitmap.recycle();
                            pages.put(new JSONObject()
                                    .put("number", i + 1)
                                    .put("src", "data:image/png;base64," + Base64.encodeToString(image.toByteArray(), Base64.NO_WRAP)));
                        }
                    }
                    return response
                            .put("path", realPath)
                            .put("name", baseName(realPath))
                            .put("pageCount", pageCount)
                            .put("truncated", pageCount > count)
                            .put("pages", pages);
                }
            } finally {
                if (sftp != null) sftp.disconnect();
                if (session != null) session.disconnect();
                //noinspection ResultOfMethodCallIgnored
                pdf.delete();
            }
        }

        private JSONObject writeRemoteText(JSONObject response, JSONObject payload) throws Exception {
            JSONObject profile = requireSshProfile(payload);
            String path = payload.optString("path", "").trim();
            if (path.isEmpty()) throw new Exception("파일 경로가 없습니다.");
            byte[] data = payload.optString("content", "").getBytes(StandardCharsets.UTF_8);
            if (data.length > 10 * 1024 * 1024) throw new Exception("10MB 넘는 텍스트 파일은 저장하지 않습니다.");
            Session session = null;
            ChannelSftp sftp = null;
            try {
                session = connectSession(new JSch(), profile);
                sftp = (ChannelSftp) session.openChannel("sftp");
                sftp.connect(10000);
                String realPath = resolveSftpPath(sftp, path);
                String tmp = realPath + ".tmp-" + System.currentTimeMillis();
                sftp.put(new ByteArrayInputStream(data), tmp);
                try {
                    sftp.rename(tmp, realPath);
                } catch (Exception first) {
                    try {
                        sftp.rm(realPath);
                    } catch (Exception ignored) {
                    }
                    sftp.rename(tmp, realPath);
                }
                return response.put("path", realPath).put("bytes", data.length);
            } finally {
                if (sftp != null) sftp.disconnect();
                if (session != null) session.disconnect();
            }
        }

        private String resolveSftpPath(ChannelSftp sftp, String path) throws Exception {
            String value = path == null ? "" : path.trim();
            if (value.isEmpty() || "~".equals(value)) return sftp.getHome();
            if (value.startsWith("~/")) return sftp.getHome() + value.substring(1);
            return value;
        }

        private JSONObject requireSshProfile(JSONObject payload) throws Exception {
            JSONObject profile = payload == null ? null : payload.optJSONObject("profile");
            if (profile == null) throw new Exception("SSH 프로필이 없습니다.");
            String host = profile.optString("host", "").trim();
            String user = profile.optString("user", "").trim();
            String identityFile = profile.optString("identityFile", "").trim();
            String password = profile.optString("password", "");
            if (host.isEmpty() || user.isEmpty()) throw new Exception("호스트와 사용자를 입력하세요.");
            if (profile.optBoolean("passwordOnly", false) && password.isEmpty()) throw new Exception("비밀번호가 필요합니다.");
            if (!profile.optBoolean("passwordOnly", false) && identityFile.isEmpty() && password.isEmpty()) throw new Exception("개인키 또는 비밀번호가 필요합니다.");
            return profile;
        }

        private Session connectSession(JSch jsch, JSONObject profile) throws Exception {
            return connectSession(jsch, profile, false);
        }

        private Session connectSession(JSch jsch, JSONObject profile, boolean passwordOnly) throws Exception {
            String identityFile = profile.optString("identityFile", "").trim();
            String password = profile.optString("password", "");
            if (passwordOnly) identityFile = "";
            if (!identityFile.isEmpty() && !new File(identityFile).canRead()) {
                throw new Exception("개인키를 읽을 수 없습니다: " + identityFile + "\n개인키 경로의 찾아보기 버튼으로 파일을 선택해 앱 저장소에 복사하세요.");
            }
            if (!passwordOnly && !identityFile.isEmpty()) jsch.addIdentity(identityFile);
            Session session = jsch.getSession(
                    profile.optString("user", "").trim(),
                    profile.optString("host", "").trim(),
                    profile.optInt("port", 22)
            );
            if (!password.isEmpty()) {
                session.setPassword(password);
                session.setUserInfo(new PasswordUserInfo(password));
            }
            Properties config = new Properties();
            config.put("StrictHostKeyChecking", "no");
            config.put("PreferredAuthentications", passwordOnly
                    ? "password,keyboard-interactive"
                    : (identityFile.isEmpty()
                    ? "password,keyboard-interactive"
                    : "publickey,password,keyboard-interactive"));
            session.setConfig(config);
            session.connect(10000);
            checkHostFingerprint(jsch, session);
            return session;
        }

        private void runExec(Session session, String command) throws Exception {
            ChannelExec channel = (ChannelExec) session.openChannel("exec");
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            channel.setCommand(command);
            channel.setErrStream(err);
            channel.connect(10000);
            long deadline = System.currentTimeMillis() + 15000;
            while (!channel.isClosed() && System.currentTimeMillis() < deadline) Thread.sleep(50);
            if (!channel.isClosed()) {
                channel.disconnect();
                throw new Exception("원격 키 등록 시간이 초과되었습니다.");
            }
            int status = channel.getExitStatus();
            channel.disconnect();
            if (status != 0) throw new Exception(err.toString("UTF-8").trim());
        }

        private String runExecOutput(Session session, String command) throws Exception {
            return runExecOutput(session, command, 15000, false);
        }

        private String runExecOutput(Session session, String command, long timeoutMs) throws Exception {
            return runExecOutput(session, command, timeoutMs, false);
        }

        private String runExecOutput(Session session, String command, long timeoutMs, boolean failOnStatus) throws Exception {
            ChannelExec channel = (ChannelExec) session.openChannel("exec");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            channel.setCommand(command);
            channel.setOutputStream(out);
            channel.setErrStream(err);
            channel.connect(10000);
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (!channel.isClosed() && System.currentTimeMillis() < deadline) Thread.sleep(50);
            if (!channel.isClosed()) {
                channel.disconnect();
                throw new Exception("명령 실행 시간이 초과되었습니다.");
            }
            int status = channel.getExitStatus();
            channel.disconnect();
            String text = out.toString("UTF-8") + err.toString("UTF-8");
            if (failOnStatus && status != 0) throw new Exception(text.trim().isEmpty() ? "exit " + status : text.trim());
            if (status != 0 && text.trim().isEmpty()) return "exit " + status;
            return text.trim();
        }

        private void checkHostFingerprint(JSch jsch, Session session) throws Exception {
            String hostKey = session.getHostKey().getFingerPrint(jsch);
            String key = session.getHost() + ":" + session.getPort();
            JSONObject known = new JSONObject(prefs.getString(KEY_HOST_FINGERPRINTS, "{}"));
            String saved = known.optString(key, "");
            if (!saved.isEmpty() && !saved.equals(hostKey)) {
                throw new Exception("서버 호스트키가 변경되었습니다: " + key);
            }
            if (saved.isEmpty()) {
                known.put(key, hostKey);
                prefs.edit().putString(KEY_HOST_FINGERPRINTS, known.toString()).apply();
            }
        }

        private String childPath(String parent, String name) {
            if ("/".equals(parent)) return "/" + name;
            return parent + "/" + name;
        }

        private String parentPath(String path) {
            if (path == null || path.isEmpty() || "/".equals(path)) return "/";
            int index = path.lastIndexOf('/');
            return index <= 0 ? "/" : path.substring(0, index);
        }

        private String baseName(String path) {
            int index = path == null ? -1 : path.lastIndexOf('/');
            return index < 0 ? path : path.substring(index + 1);
        }

        private String oneDriveCloudPath(String path) {
            String[] parts = path.replace('\\', '/').split("/");
            for (int i = 0; i < parts.length; i++) {
                if (parts[i].toLowerCase().startsWith("onedrive")) {
                    StringBuilder out = new StringBuilder();
                    for (int j = i + 1; j < parts.length; j++) {
                        if (parts[j].isEmpty()) continue;
                        if (out.length() > 0) out.append('/');
                        out.append(parts[j]);
                    }
                    return out.toString();
                }
            }
            return "";
        }

        private String rcloneCopyCommand(String macFolder, String cloudPath, String direction) {
            String bootstrap = String.join("\n",
                    "PATH=\"/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH\"",
                    "rclone_bin=$(command -v rclone 2>/dev/null || true)",
                    "if [ -z \"$rclone_bin\" ]; then",
                    "  for p in /opt/homebrew/bin/rclone /usr/local/bin/rclone /opt/local/bin/rclone; do",
                    "    [ -x \"$p\" ] && rclone_bin=\"$p\" && break",
                    "  done",
                    "fi",
                    "if [ -z \"$rclone_bin\" ]; then echo \"rclone not found. 원격 Mac에서 brew install rclone 후 rclone config로 OneDrive를 연결하세요.\" >&2; exit 127; fi",
                    "remotes=$(\"$rclone_bin\" listremotes)",
                    "if [ -z \"$remotes\" ]; then echo \"rclone remote가 없습니다. 원격 Mac에서 rclone config를 먼저 실행하세요.\" >&2; exit 66; fi"
            );
            String cloudRel = shq(cloudPath.replaceFirst("^/+", ""));
            String pickRemote = "remote=''\n"
                    + "for r in $remotes; do\n"
                    + "  case \"$(printf '%s' \"$r\" | tr '[:upper:]' '[:lower:]')\" in *one*) "
                    + ("pull".equals(direction)
                    ? "\"$rclone_bin\" lsf \"${r}${cloud_rel}\" --max-depth 1 >/dev/null 2>&1 && remote=\"$r\" && break"
                    : "remote=\"$r\" && break")
                    + " ;; esac\n"
                    + "done\n"
                    + "if [ -z \"$remote\" ]; then\n"
                    + "  for r in $remotes; do "
                    + ("pull".equals(direction)
                    ? "\"$rclone_bin\" lsf \"${r}${cloud_rel}\" --max-depth 1 >/dev/null 2>&1 && remote=\"$r\" && break"
                    : "remote=\"$r\" && break")
                    + "; done\n"
                    + "fi\n"
                    + "if [ -z \"$remote\" ]; then echo \"directory not found in rclone remotes: ${cloud_rel}\" >&2; echo \"사용 가능한 remote:\" >&2; printf '%s\\n' \"$remotes\" >&2; exit 66; fi";
            String cloud = "\"${remote}${cloud_rel}\"";
            String mac = shq(macFolder);
            String src = "pull".equals(direction) ? cloud : mac;
            String dst = "pull".equals(direction) ? mac : cloud;
            String mkdir = "pull".equals(direction) ? "mkdir -p " + mac : "\"$rclone_bin\" mkdir " + cloud + " >/dev/null 2>&1 || true";
            String copy = "\"$rclone_bin\" copy " + src + " " + dst
                    + " --update --create-empty-src-dirs --transfers=4 --checkers=8 --retries=1 --low-level-retries=1 --stats-one-line --stats=5s";
            if ("push".equals(direction)) {
                copy = String.join("\n",
                        "src_dir=" + mac,
                        "tmp=\"${TMPDIR:-/tmp}/legal-terminal-rclone-files.$$\"",
                        "trap 'rm -f \"$tmp\"' EXIT HUP INT TERM",
                        ": > \"$tmp\"",
                        "( cd \"$src_dir\" && find . -type f | while IFS= read -r f; do",
                        "  clean=${f#./}",
                        "  flags=$(ls -lO \"$f\" 2>/dev/null || true)",
                        "  if printf '%s\\n' \"$flags\" | grep -q 'dataless'; then echo \"건너뜀(OneDrive 미다운로드): $clean\"; continue; fi",
                        "  printf '%s\\n' \"$clean\" >> \"$tmp\"",
                        "done )",
                        "if [ ! -s \"$tmp\" ]; then echo \"업로드할 로컬 실체 파일이 없습니다. 먼저 OneDrive 내리기를 실행하세요.\"; exit 0; fi",
                        "\"$rclone_bin\" copy \"$src_dir\" " + cloud + " --files-from-raw \"$tmp\" --update --create-empty-src-dirs --transfers=4 --checkers=8 --retries=1 --low-level-retries=1 --stats-one-line --stats=5s"
                );
            }
            return bootstrap + "\n"
                    + "cloud_rel=" + cloudRel + "\n"
                    + pickRemote + "\n"
                    + "echo \"OneDrive " + ("pull".equals(direction) ? "내리기" : "올리기") + ": " + cloudPath.replace("\"", "\\\"") + "\"\n"
                    + mkdir + "\n"
                    + copy;
        }

        private String rcloneCatCommand(String cloudPath) {
            return String.join("\n",
                    "PATH=\"/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH\"",
                    "rclone_bin=$(command -v rclone 2>/dev/null || true)",
                    "if [ -z \"$rclone_bin\" ]; then for p in /opt/homebrew/bin/rclone /usr/local/bin/rclone /opt/local/bin/rclone; do [ -x \"$p\" ] && rclone_bin=\"$p\" && break; done; fi",
                    "if [ -z \"$rclone_bin\" ]; then echo \"rclone not found\" >&2; exit 127; fi",
                    "remotes=$(\"$rclone_bin\" listremotes)",
                    "cloud_rel=" + shq(cloudPath.replaceFirst("^/+", "")),
                    "tmp=\"${TMPDIR:-/tmp}/legal-terminal-rclone-pdf.$$\"",
                    "err=\"${tmp}.err\"",
                    "trap 'rm -f \"$tmp\" \"$err\"' EXIT HUP INT TERM",
                    "for r in $remotes; do",
                    "  rm -f \"$tmp\" \"$err\"",
                    "  if \"$rclone_bin\" copyto \"${r}${cloud_rel}\" \"$tmp\" --ignore-times --retries=1 --low-level-retries=1 2>\"$err\"; then cat \"$tmp\"; exit 0; fi",
                    "done",
                    "cat \"$err\" >&2",
                    "exit 66"
            );
        }

        private String hydrateOneDriveCatCommand(String path) {
            return String.join("\n",
                    "p=" + shq(path),
                    "err=\"/tmp/legal-terminal-onedrive-$$.err\"",
                    "cleanup() { rm -f \"$err\"; }",
                    "trap cleanup EXIT HUP INT TERM",
                    "is_dataless() { ls -lO \"$p\" 2>/dev/null | grep -q dataless; }",
                    "try_read() { python3 - \"$p\" >/dev/null 2>\"$err\" <<'PY'\nimport sys\nwith open(sys.argv[1], 'rb') as f:\n    f.read(4096)\nPY\n}",
                    "if ! is_dataless && try_read; then cat \"$p\"; exit 0; fi",
                    "onedrive=\"/Applications/OneDrive.app/Contents/MacOS/OneDrive\"",
                    "if [ -x \"$onedrive\" ]; then open -ga OneDrive >/dev/null 2>&1 || true; \"$onedrive\" /pin \"$p\" >/dev/null 2>&1 || true; fi",
                    "fileproviderctl materialize \"$p\" >/dev/null 2>&1 || true",
                    "brctl download \"$p\" >/dev/null 2>&1 || true",
                    "deadline=$(( $(date +%s) + 590 ))",
                    "while [ \"$(date +%s)\" -lt \"$deadline\" ]; do",
                    "  if ! is_dataless && try_read; then cat \"$p\"; exit 0; fi",
                    "  sleep 2",
                    "done",
                    "cat \"$err\" >&2 2>/dev/null || true",
                    "ls -lO@ \"$p\" >&2 2>/dev/null || true",
                    "exit 1"
            );
        }

        private void copy(InputStream in, OutputStream out) throws Exception {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        }

        private void execToStream(Session session, String command, OutputStream out) throws Exception {
            ChannelExec exec = null;
            ByteArrayOutputStream err = new ByteArrayOutputStream();
            try {
                exec = (ChannelExec) session.openChannel("exec");
                exec.setCommand(command);
                exec.setErrStream(err);
                try (InputStream in = exec.getInputStream()) {
                    exec.connect(10000);
                    copy(in, out);
                    while (!exec.isClosed()) Thread.sleep(50);
                }
                if (exec.getExitStatus() != 0) throw new Exception(err.toString("UTF-8").trim());
            } finally {
                if (exec != null) exec.disconnect();
            }
        }

        private String shq(String value) {
            return "'" + value.replace("'", "'\\''") + "'";
        }

        private JSONArray payloadArray(JSONObject payload, String key) {
            JSONArray value = payload == null ? null : payload.optJSONArray(key);
            return value == null ? new JSONArray() : value;
        }

        private void putIfPresent(JSONObject object, String key, String value) throws Exception {
            String trimmed = value == null ? "" : value.trim();
            if (!trimmed.isEmpty()) object.put(key, trimmed);
        }

        private JSONObject requireProfile(JSONObject response) throws Exception {
            if (prefs.getString(KEY_LAST_SSH_PROFILE_ID, "").isEmpty()) {
                response.put("ok", false);
                response.put("error", "SSH 프로필을 먼저 선택해야 합니다.");
            }
            return response;
        }

        private String error(String message) {
            try {
                return new JSONObject()
                        .put("ok", false)
                        .put("error", message == null ? "error" : message)
                        .toString();
            } catch (Exception ignored) {
                return "{\"ok\":false,\"error\":\"error\"}";
            }
        }

        private static class JuriHttpResponse {
            final int status;
            final String sessionId;
            final String text;

            JuriHttpResponse(int status, String sessionId, String text) {
                this.status = status;
                this.sessionId = sessionId;
                this.text = text;
            }
        }

        private static class PasswordUserInfo implements UserInfo, UIKeyboardInteractive {
            private final String password;

            PasswordUserInfo(String password) {
                this.password = password;
            }

            public String getPassword() { return password; }
            public String getPassphrase() { return null; }
            public boolean promptPassword(String message) { return true; }
            public boolean promptPassphrase(String message) { return false; }
            public boolean promptYesNo(String message) { return true; }
            public void showMessage(String message) {}

            public String[] promptKeyboardInteractive(
                    String destination,
                    String name,
                    String instruction,
                    String[] prompt,
                    boolean[] echo
            ) {
                String[] answers = new String[prompt.length];
                for (int i = 0; i < answers.length; i++) answers[i] = password;
                return answers;
            }
        }
    }
}
