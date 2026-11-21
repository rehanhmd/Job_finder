package com.remotehunt.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * RemoteHunt: thin native shell. The whole app UI and logic live in assets/www (HTML/JS),
 * served from a virtual https origin. Native code provides what a web page cannot do:
 * CORS-free HTTP, file storage, picking the CV file, and the "apply" browser with autofill.
 */
public class MainActivity extends Activity {

    static final String APP_HOST = "appassets.androidplatform.net";
    static final String APP_URL = "https://" + APP_HOST + "/www/index.html";
    static final int REQ_PICK_CV = 41;
    static final int REQ_PICK_UPLOAD = 42;
    static final int REQ_NOTIFY = 43;

    WebView appWeb;
    WebView jobWeb;
    LinearLayout applyPanel;
    TextView applyStatus;
    ProgressBar applyProgress;
    final Handler ui = new Handler(Looper.getMainLooper());
    final ExecutorService pool = Executors.newFixedThreadPool(6);
    final Map<String, String> httpResults = new ConcurrentHashMap<String, String>();
    ValueCallback<Uri[]> pendingUpload;
    String pendingSlot = "main";
    String injectJs;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 21) {
            Window w = getWindow();
            w.setStatusBarColor(Color.parseColor("#0F172A"));
            w.setNavigationBarColor(Color.parseColor("#0F172A"));
        }
        // Chrome remote debugging exposes everything the app stores (tokens, mail password): debug builds only
        boolean debuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(debuggable);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0F172A"));

        appWeb = new WebView(this);
        setupCommon(appWeb);
        // the app's own screens never need plain-http content
        if (Build.VERSION.SDK_INT >= 21) appWeb.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        appWeb.addJavascriptInterface(new Bridge(), "Android");
        appWeb.setWebViewClient(new AppClient());
        appWeb.setWebChromeClient(new WebChromeClient());
        root.addView(appWeb, new FrameLayout.LayoutParams(-1, -1));

        applyPanel = buildApplyPanel();
        applyPanel.setVisibility(View.GONE);
        root.addView(applyPanel, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);
        if (getIntent() != null) launchTab = getIntent().getStringExtra(Alerts.EXTRA_OPEN);
        appWeb.loadUrl(APP_URL);
    }

    /** True while the app is on screen: the background site check then leaves the work to the open app. */
    static volatile boolean foreground;
    String launchTab;

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Android may re-create the app (e.g. after it was killed in the background) and deliver this before the page
        // has loaded: keep the wish until the page asks for it (launchTab) or, if it is already running, switch now.
        if (intent != null && "jobs".equals(intent.getStringExtra(Alerts.EXTRA_OPEN))) {
            launchTab = "jobs";
            callApp("if (window.RH && RH.go && window.Android && Android.launchTab() === 'jobs') RH.go('jobs')");
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_NOTIFY) callApp("window.RH && RH.onNotifyPermission && RH.onNotifyPermission(" + Alerts.allowed(this) + ")");
    }

    @Override
    protected void onPause() {
        super.onPause();
        foreground = false;
        // keep job-site logins: write cookies to disk now
        if (Build.VERSION.SDK_INT >= 21) CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
        if (appWeb != null) appWeb.evaluateJavascript("window.RH && RH.onResume && RH.onResume()", null);
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (applyPanel.getVisibility() == View.VISIBLE) {
            if (jobWeb.canGoBack()) jobWeb.goBack();
            else closeApplyPanel();
            return;
        }
        appWeb.evaluateJavascript("(window.RH && RH.onBack) ? String(RH.onBack()) : 'false'",
                new ValueCallback<String>() {
                    public void onReceiveValue(String v) {
                        if (v == null || !v.contains("true")) finish();
                    }
                });
    }

    int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    void setupCommon(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    }

    // ------------------------------------------------------------------ apply panel (job site browser)

    LinearLayout buildApplyPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.WHITE);
        panel.setClickable(true);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#0F172A"));
        bar.setPadding(dp(4), dp(4), dp(4), dp(4));

        bar.addView(barButton("✕", "#334155", new View.OnClickListener() {
            public void onClick(View v) { closeApplyPanel(); }
        }));
        bar.addView(barButton("‹", "#334155", new View.OnClickListener() {
            public void onClick(View v) { if (jobWeb.canGoBack()) jobWeb.goBack(); }
        }));

        applyStatus = new TextView(this);
        applyStatus.setTextColor(Color.parseColor("#CBD5E1"));
        applyStatus.setTextSize(12);
        applyStatus.setMaxLines(2);
        applyStatus.setPadding(dp(6), 0, dp(6), 0);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, -2, 1f);
        bar.addView(applyStatus, slp);

        bar.addView(barButton("Save", "#334155", new View.OnClickListener() {
            public void onClick(View v) { captureAnswers(); }
        }));
        bar.addView(barButton("⚡ Autofill", "#6366F1", new View.OnClickListener() {
            public void onClick(View v) { startAutofill(false); }
        }));
        bar.addView(barButton("↗", "#334155", new View.OnClickListener() {
            public void onClick(View v) {
                String u = jobWeb.getUrl();
                if (u != null) openExternal(u);
            }
        }));
        panel.addView(bar, new LinearLayout.LayoutParams(-1, -2));

        applyProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        applyProgress.setMax(100);
        applyProgress.setVisibility(View.GONE);
        panel.addView(applyProgress, new LinearLayout.LayoutParams(-1, dp(3)));

        jobWeb = new WebView(this);
        setupCommon(jobWeb);
        jobWeb.getSettings().setSupportMultipleWindows(false);
        jobWeb.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) CookieManager.getInstance().setAcceptThirdPartyCookies(jobWeb, true);
        jobWeb.setWebViewClient(new JobClient());
        jobWeb.setWebChromeClient(new JobChrome());
        panel.addView(jobWeb, new LinearLayout.LayoutParams(-1, 0, 1f));
        return panel;
    }

    TextView barButton(String label, String bg, View.OnClickListener l) {
        TextView b = new TextView(this);
        b.setText(label);
        b.setTextColor(Color.WHITE);
        b.setTextSize(14);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(12), dp(8), dp(12), dp(8));
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setColor(Color.parseColor(bg));
        d.setCornerRadius(dp(8));
        b.setBackground(d);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.setMargins(dp(3), 0, dp(3), 0);
        b.setLayoutParams(lp);
        return b;
    }

    /** Only real web pages may be opened in the apply browser (no javascript:, file:, content:, intent: …). */
    static boolean isWebUrl(String url) {
        if (url == null) return false;
        String u = url.trim().toLowerCase(java.util.Locale.US);
        return u.startsWith("https://") || u.startsWith("http://");
    }

    void openApplyPanel(String url) {
        if (!isWebUrl(url)) { Toast.makeText(this, "This job link can't be opened", Toast.LENGTH_SHORT).show(); return; }
        applyPanel.setVisibility(View.VISIBLE);
        setApplyStatus("Loading…  Tap ⚡ Autofill when the application form is on screen.");
        jobWeb.loadUrl(url);
    }

    void closeApplyPanel() {
        applyPanel.setVisibility(View.GONE);
        jobWeb.stopLoading();
        jobWeb.loadUrl("about:blank");
        jobWeb.clearHistory();
        callApp("RH.onApplyClosed && RH.onApplyClosed()");
    }

    void setApplyStatus(String s) {
        if (applyStatus != null) applyStatus.setText(s);
    }

    String readAsset(String path) {
        try {
            InputStream in = getAssets().open(path);
            return new String(readAll(in), "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    String inject() {
        if (injectJs == null) injectJs = readAsset("inject/autofill.js");
        return injectJs;
    }

    /**
     * Script that runs the autofill agent and returns JSON.stringify(expr). The agent lives in a local variable
     * (__rh) of this one evaluation, so the job page cannot replace it with a fake one.
     */
    String agentJs(String expr) {
        return "(function(){var __rh=" + inject() + "\n;return JSON.stringify(" + expr + ");})()";
    }

    void callApp(final String js) {
        ui.post(new Runnable() {
            public void run() { appWeb.evaluateJavascript(js, null); }
        });
    }

    /** Step 1: scan the form in the job page, hand the field list to the app logic. */
    void startAutofill(final boolean auto) {
        if (!auto) setApplyStatus("Scanning form…");
        jobWeb.evaluateJavascript(agentJs("__rh ? __rh.collect() : {error:'inject failed'}"),
                new ValueCallback<String>() {
                    public void onReceiveValue(String value) {
                        if (value == null || value.equals("null")) value = JSONObject.quote("{\"error\":\"no result\"}");
                        String page = JSONObject.quote(String.valueOf(jobWeb.getUrl()));
                        String title = JSONObject.quote(String.valueOf(jobWeb.getTitle()));
                        appWeb.evaluateJavascript("RH.autofill.onFields(" + value + "," + page + "," + title + "," + auto + ")", null);
                    }
                });
    }

    /** Step 2: the app computed values; write them into the job page. */
    void applyFillsNow(final String fillsJson, final boolean needsFile) {
        String fileArg = "null";
        if (needsFile) {
            try {
                JSONObject meta = new JSONObject(kvRead("cv.meta"));
                File f = new File(meta.getString("path"));
                if (f.exists()) {
                    JSONObject o = new JSONObject();
                    o.put("name", meta.optString("name", f.getName()));
                    o.put("mime", meta.optString("mime", "application/pdf"));
                    o.put("b64", Base64.encodeToString(readAll(new FileInputStream(f)), Base64.NO_WRAP));
                    fileArg = o.toString();
                }
            } catch (Exception ignored) { }
        }
        String js = agentJs("__rh.fill(" + JSONObject.quote(fillsJson) + "," + fileArg + ")");
        jobWeb.evaluateJavascript(js, new ValueCallback<String>() {
            public void onReceiveValue(String value) {
                if (value == null || value.equals("null")) value = JSONObject.quote("{\"error\":\"fill failed\"}");
                appWeb.evaluateJavascript("RH.autofill.onFilled(" + value + ")", null);
            }
        });
    }

    /** Remember what the user typed so it can be reused next time. */
    void captureAnswers() {
        setApplyStatus("Saving your answers…");
        jobWeb.evaluateJavascript(agentJs("__rh.capture()"), new ValueCallback<String>() {
            public void onReceiveValue(String value) {
                if (value == null || value.equals("null")) value = JSONObject.quote("{\"items\":[]}");
                appWeb.evaluateJavascript("RH.autofill.onCapture(" + value + ")", null);
            }
        });
    }

    /** Detect "application submitted" pages and sites that need an account; reported to the app's tracker. */
    void schedulePageInfo(final String url) {
        if (url == null || url.startsWith("about:")) return;
        long[] delays = new long[]{2500, 6000};
        for (long d : delays) {
            ui.postDelayed(new Runnable() {
                public void run() {
                    if (applyPanel.getVisibility() != View.VISIBLE || !url.equals(jobWeb.getUrl())) return;
                    jobWeb.evaluateJavascript(agentJs("__rh ? __rh.pageInfo() : null"), new ValueCallback<String>() {
                        public void onReceiveValue(String v) {
                            if (v != null && !v.equals("null")) appWeb.evaluateJavascript("RH.onPageInfo && RH.onPageInfo(" + v + ")", null);
                        }
                    });
                }
            }, d);
        }
    }

    /** Automatic autofill: try a few times after a page (or single-page-app route) loads. */
    void scheduleAuto(final String url) {
        String pref = kvRead("autofill.auto");
        if (pref != null && pref.trim().equals("false")) return;
        if (url == null || url.startsWith("about:")) return;
        long[] delays = new long[]{1200, 3500, 7000};
        for (long d : delays) {
            ui.postDelayed(new Runnable() {
                public void run() {
                    if (applyPanel.getVisibility() == View.VISIBLE && url.equals(jobWeb.getUrl())) startAutofill(true);
                }
            }, d);
        }
    }

    void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
    }

    class AppClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            return serveAsset(MainActivity.this, req.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url.startsWith("https://" + APP_HOST)) return false;
            openExternal(url);
            return true;
        }
    }

    /** The app's own files, served from https://appassets.androidplatform.net/ (null for any other address). */
    static WebResourceResponse serveAsset(Context c, Uri u) {
        if (!APP_HOST.equals(u.getHost())) return null;
        String path = u.getPath();
        if (path == null || path.equals("/")) path = "/www/index.html";
        path = path.substring(1);
        try {
            return new WebResourceResponse(mimeFor(path), "UTF-8", c.getAssets().open(path));
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "UTF-8", new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    class JobClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url.startsWith("http://") || url.startsWith("https://")) return false;
            if (url.startsWith("about:") || url.startsWith("javascript:") || url.startsWith("data:") || url.startsWith("blob:")) return false;
            if (url.startsWith("intent:")) {
                try {
                    Intent i = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                    String fb = i.getStringExtra("browser_fallback_url");
                    if (isWebUrl(fb)) { view.loadUrl(fb); return true; }
                    // a web page may only ask to open another app the way a browser allows: no explicit
                    // component, no selector, no URI-permission grants
                    i.addCategory(Intent.CATEGORY_BROWSABLE);
                    i.setComponent(null);
                    if (Build.VERSION.SDK_INT >= 15) i.setSelector(null);
                    i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception ignored) { }
                return true;
            }
            openExternal(url); // mailto:, tel:, market: …
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            applyProgress.setVisibility(View.VISIBLE);
            String host = Uri.parse(url).getHost();
            setApplyStatus("Loading " + (host == null ? "" : host) + "…");
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            applyProgress.setVisibility(View.GONE);
            String host = Uri.parse(url).getHost();
            if (host != null && !url.startsWith("about:")) setApplyStatus(host + " — autofill runs when the form appears (or tap ⚡ Autofill)");
            scheduleAuto(url);
            schedulePageInfo(url);
            if (Build.VERSION.SDK_INT >= 21) CookieManager.getInstance().flush();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            // single-page apps (Ashby, Lever…) change route without a full page load
            if (!isReload && applyProgress.getVisibility() != View.VISIBLE) { scheduleAuto(url); schedulePageInfo(url); }
        }
    }

    class JobChrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int p) {
            applyProgress.setProgress(p);
        }

        @Override
        public boolean onShowFileChooser(WebView view, final ValueCallback<Uri[]> callback, final FileChooserParams params) {
            if (pendingUpload != null) pendingUpload.onReceiveValue(null);
            pendingUpload = callback;
            final File cv = savedCvFile();
            if (cv == null) {
                pickAnyFile();
                return true;
            }
            String cvName = cv.getName();
            try { cvName = new JSONObject(kvRead("cv.meta")).optString("name", cvName); } catch (Exception ignored) { }
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Upload a file")
                    .setItems(new String[]{"Attach my saved CV (" + cvName + ")", "Choose another file…"},
                            new DialogInterface.OnClickListener() {
                                public void onClick(DialogInterface d, int which) {
                                    if (which == 0) {
                                        Uri u = CvProvider.CV_URI;
                                        if (pendingUpload != null) pendingUpload.onReceiveValue(new Uri[]{u});
                                        pendingUpload = null;
                                    } else {
                                        pickAnyFile();
                                    }
                                }
                            })
                    .setOnCancelListener(new DialogInterface.OnCancelListener() {
                        public void onCancel(DialogInterface d) {
                            if (pendingUpload != null) pendingUpload.onReceiveValue(null);
                            pendingUpload = null;
                        }
                    })
                    .show();
            return true;
        }
    }

    void pickAnyFile() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        try {
            startActivityForResult(Intent.createChooser(i, "Choose file"), REQ_PICK_UPLOAD);
        } catch (Exception e) {
            if (pendingUpload != null) pendingUpload.onReceiveValue(null);
            pendingUpload = null;
        }
    }

    File savedCvFile() {
        try {
            JSONObject meta = new JSONObject(kvRead("cv.meta"));
            File f = new File(meta.getString("path"));
            return f.exists() ? f : null;
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ activity results

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_UPLOAD) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) result = new Uri[]{data.getData()};
            if (pendingUpload != null) pendingUpload.onReceiveValue(result);
            pendingUpload = null;
            return;
        }
        if (requestCode == REQ_PICK_CV) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                callApp("RH.onCvPicked(null)");
                return;
            }
            final Uri uri = data.getData();
            pool.execute(new Runnable() {
                public void run() { importCv(uri, pendingSlot); }
            });
        }
    }

    static String safeSlot(String slot) {
        String s = slot == null ? "main" : slot.replaceAll("[^A-Za-z0-9_-]", "");
        return s.length() == 0 ? "main" : s;
    }

    void importCv(Uri uri, String slot) {
        try {
            String name = "cv";
            Cursor c = getContentResolver().query(uri, null, null, null, null);
            if (c != null) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (c.moveToFirst() && idx >= 0) name = c.getString(idx);
                c.close();
            }
            String mime = getContentResolver().getType(uri);
            if (mime == null) {
                String ext = MimeTypeMap.getFileExtensionFromUrl(name);
                mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            }
            if (mime == null) mime = "application/octet-stream";
            byte[] bytes = readAll(getContentResolver().openInputStream(uri));
            File dir = new File(new File(getFilesDir(), "cv"), safeSlot(slot));
            if (dir.exists()) {
                File[] old = dir.listFiles();
                if (old != null) for (File o : old) o.delete();
            }
            dir.mkdirs();
            String safe = name.replaceAll("[^A-Za-z0-9._ -]", "_");
            if (safe.length() == 0) safe = "cv";
            File out = new File(dir, safe);
            OutputStream os = new FileOutputStream(out);
            os.write(bytes);
            os.close();
            JSONObject meta = new JSONObject();
            meta.put("name", name);
            meta.put("mime", mime);
            meta.put("size", bytes.length);
            meta.put("path", out.getAbsolutePath());
            meta.put("savedAt", System.currentTimeMillis());
            meta.put("slot", safeSlot(slot));
            kvWrite("cv.meta", meta.toString());
            callApp("RH.onCvPicked(" + meta.toString() + ")");
        } catch (Exception e) {
            callApp("RH.onCvPicked({error:" + JSONObject.quote(String.valueOf(e.getMessage())) + "})");
        }
    }

    // ------------------------------------------------------------------ storage

    // shared with the background site checker (SitesJob): static, one lock for the whole app process
    static File kvFile(Context c, String key) {
        File dir = new File(c.getFilesDir(), "kv");
        dir.mkdirs();
        return new File(dir, key.replaceAll("[^A-Za-z0-9._-]", "_") + ".txt");
    }

    String kvRead(String key) { return kvRead(this, key); }
    void kvWrite(String key, String value) { kvWrite(this, key, value); }

    static synchronized String kvRead(Context c, String key) {
        try {
            File f = kvFile(c, key);
            if (!f.exists()) return null;
            return new String(readAll(new FileInputStream(f)), "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    static synchronized void kvWrite(Context c, String key, String value) {
        try {
            File f = kvFile(c, key);
            if (value == null) { f.delete(); return; }
            File tmp = new File(f.getPath() + ".tmp");
            OutputStream os = new FileOutputStream(tmp);
            os.write(value.getBytes("UTF-8"));
            os.close();
            if (!tmp.renameTo(f)) {
                f.delete();
                tmp.renameTo(f);
            }
        } catch (Exception ignored) { }
    }

    static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        try {
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        } finally {
            in.close();
        }
        return bo.toByteArray();
    }

    // ------------------------------------------------------------------ HTTP

    static String doHttp(String reqJson) {
        JSONObject res = new JSONObject();
        HttpURLConnection conn = null;
        try {
            JSONObject req = new JSONObject(reqJson);
            String method = req.optString("method", "GET").toUpperCase();
            URL url = new URL(req.getString("url"));
            int timeout = req.optInt("timeout", 60000);
            int redirects = 0;
            while (true) {
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(Math.min(timeout, 20000));
                conn.setReadTimeout(timeout);
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod(method);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) RemoteHunt/1.0");
                conn.setRequestProperty("Accept-Encoding", "gzip");
                JSONObject h = req.optJSONObject("headers");
                if (h != null) {
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        conn.setRequestProperty(k, h.getString(k));
                    }
                }
                String body = (req.has("body") && !req.isNull("body")) ? req.getString("body") : null;
                if (body != null && !method.equals("GET")) {
                    conn.setDoOutput(true);
                    byte[] b = body.getBytes("UTF-8");
                    conn.setFixedLengthStreamingMode(b.length);
                    OutputStream os = conn.getOutputStream();
                    os.write(b);
                    os.close();
                }
                int code = conn.getResponseCode();
                if (code >= 300 && code < 400 && redirects < 5 && conn.getHeaderField("Location") != null) {
                    url = new URL(url, conn.getHeaderField("Location"));
                    conn.disconnect();
                    redirects++;
                    if (code == 303) method = "GET";
                    continue;
                }
                InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String text = "";
                if (in != null) {
                    if ("gzip".equalsIgnoreCase(conn.getContentEncoding())) in = new GZIPInputStream(in);
                    text = new String(readAll(in), "UTF-8");
                }
                res.put("status", code);
                res.put("body", text);
                res.put("url", url.toString());
                break;
            }
        } catch (Exception e) {
            try {
                res.put("status", 0);
                res.put("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            } catch (Exception ignored) { }
        } finally {
            if (conn != null) conn.disconnect();
        }
        return res.toString();
    }

    // ------------------------------------------------------------------ JS bridge

    class Bridge {
        @JavascriptInterface
        public String kvGet(String key) { return kvRead(key); }

        @JavascriptInterface
        public void kvSet(String key, String value) { kvWrite(key, value); }

        @JavascriptInterface
        public void kvRemove(String key) { kvWrite(key, null); }

        @JavascriptInterface
        public void http(final String id, final String reqJson) {
            pool.execute(new Runnable() {
                public void run() {
                    httpResults.put(id, doHttp(reqJson));
                    callApp("window.__httpDone && __httpDone(" + JSONObject.quote(id) + ")");
                }
            });
        }

        /** Read recent emails over IMAP (app password). cfg: {host, port, user, pass, days}. Result via __httpDone(id)/httpTake. */
        @JavascriptInterface
        public void mailCheck(final String id, final String cfgJson) {
            pool.execute(new Runnable() {
                public void run() {
                    JSONObject res = new JSONObject();
                    ImapClient c = new ImapClient();
                    try {
                        JSONObject cfg = new JSONObject(cfgJson);
                        c.connect(cfg.getString("host"), cfg.optInt("port", 993), true, 25000);
                        c.login(cfg.getString("user"), cfg.getString("pass"));
                        java.util.List<ImapClient.Msg> list = c.recent(cfg.optInt("days", 30), cfg.optInt("max", 150), 1500);
                        org.json.JSONArray arr = new org.json.JSONArray();
                        for (ImapClient.Msg m : list) {
                            JSONObject o = new JSONObject();
                            o.put("id", m.seq + "|" + m.date); o.put("from", m.from); o.put("subject", m.subject); o.put("date", m.date); o.put("body", m.body);
                            arr.put(o);
                        }
                        res.put("status", 200);
                        res.put("body", new JSONObject().put("messages", arr).toString());
                    } catch (Exception e) {
                        try { res.put("status", 0); res.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
                    } finally {
                        c.logout();
                    }
                    httpResults.put(id, res.toString());
                    callApp("window.__httpDone && __httpDone(" + JSONObject.quote(id) + ")");
                }
            });
        }

        @JavascriptInterface
        public String httpTake(String id) {
            String r = httpResults.remove(id);
            return r == null ? "{\"status\":0,\"error\":\"missing\"}" : r;
        }

        @JavascriptInterface
        public void pickCv() { pickCvSlot("main"); }

        /** Pick a CV into its own slot so several CVs can be kept. */
        @JavascriptInterface
        public void pickCvSlot(String slot) {
            pendingSlot = safeSlot(slot);
            ui.post(new Runnable() {
                public void run() {
                    Intent i = new Intent(Build.VERSION.SDK_INT >= 19 ? Intent.ACTION_OPEN_DOCUMENT : Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                            "application/pdf",
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                            "application/msword", "text/plain", "application/rtf"});
                    try {
                        startActivityForResult(i, REQ_PICK_CV);
                    } catch (Exception e) {
                        callApp("RH.onCvPicked({error:'No file picker available'})");
                    }
                }
            });
        }

        @JavascriptInterface
        public String cvBase64() {
            try {
                File f = savedCvFile();
                if (f == null) return null;
                return Base64.encodeToString(readAll(new FileInputStream(f)), Base64.NO_WRAP);
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public String cvMeta() { return kvRead("cv.meta"); }

        /** Base64 of a stored CV, by the path in its meta (only files inside our CV folder). */
        @JavascriptInterface
        public String cvBase64Path(String path) {
            try {
                File root = new File(getFilesDir(), "cv").getCanonicalFile();
                File f = new File(path).getCanonicalFile();
                if (!f.getPath().startsWith(root.getPath() + File.separator) || !f.exists()) return null;
                return Base64.encodeToString(readAll(new FileInputStream(f)), Base64.NO_WRAP);
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public void deleteCvSlot(String slot) {
            File dir = new File(new File(getFilesDir(), "cv"), safeSlot(slot));
            File[] fs = dir.listFiles();
            if (fs != null) for (File f : fs) f.delete();
            dir.delete();
        }

        @JavascriptInterface
        public void openApply(final String url) {
            ui.post(new Runnable() {
                public void run() { openApplyPanel(url); }
            });
        }

        @JavascriptInterface
        public void closeApply() {
            ui.post(new Runnable() {
                public void run() { closeApplyPanel(); }
            });
        }

        @JavascriptInterface
        public void applyFills(final String fillsJson, final boolean needsFile) {
            ui.post(new Runnable() {
                public void run() { applyFillsNow(fillsJson, needsFile); }
            });
        }

        @JavascriptInterface
        public void loadInApply(final String url) {
            if (!isWebUrl(url)) return;
            ui.post(new Runnable() {
                public void run() { jobWeb.loadUrl(url); }
            });
        }

        @JavascriptInterface
        public void setApplyStatus(final String text) {
            ui.post(new Runnable() {
                public void run() { MainActivity.this.setApplyStatus(text); }
            });
        }

        @JavascriptInterface
        public void openExternal(final String url) {
            String u = url == null ? "" : url.trim().toLowerCase(java.util.Locale.US);
            if (!(isWebUrl(u) || u.startsWith("mailto:") || u.startsWith("tel:"))) return;
            ui.post(new Runnable() {
                public void run() { MainActivity.this.openExternal(url); }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            ui.post(new Runnable() {
                public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show(); }
            });
        }

        @JavascriptInterface
        public void copy(final String text) {
            ui.post(new Runnable() {
                public void run() {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("RemoteHunt", text));
                    Toast.makeText(MainActivity.this, "Copied", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void share(final String text) {
            ui.post(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(i, "Share"));
                }
            });
        }

        @JavascriptInterface
        public String platform() { return "android-" + Build.VERSION.SDK_INT; }

        /** Send one email with the app password (new-job alerts). cfg: {host, port, user, pass, to, subject, body}. Result via __httpDone(id)/httpTake. */
        @JavascriptInterface
        public void sendMail(final String id, final String cfgJson) {
            pool.execute(new Runnable() {
                public void run() {
                    httpResults.put(id, Alerts.sendMail(cfgJson));
                    callApp("window.__httpDone && __httpDone(" + JSONObject.quote(id) + ")");
                }
            });
        }

        /** Check followed sites every 30 minutes in the background (also after a restart), or stop doing so. */
        @JavascriptInterface
        public void scheduleSiteChecks(boolean on) { Alerts.schedule(MainActivity.this, on); }

        @JavascriptInterface
        public boolean notificationsAllowed() { return Alerts.allowed(MainActivity.this); }

        /** Android 13+: ask for permission to show notifications. Answer via RH.onNotifyPermission(granted). */
        @JavascriptInterface
        public void requestNotifications() {
            ui.post(new Runnable() {
                public void run() {
                    if (Build.VERSION.SDK_INT >= 33 && !Alerts.allowed(MainActivity.this)) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
                    else callApp("window.RH && RH.onNotifyPermission && RH.onNotifyPermission(" + Alerts.allowed(MainActivity.this) + ")");
                }
            });
        }

        /** Phone makers (OnePlus, Xiaomi…) may stop background checks to save battery; this opens the setting. */
        @JavascriptInterface
        public void openBatterySettings() {
            ui.post(new Runnable() {
                public void run() {
                    try { startActivity(new Intent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS")); }
                    catch (Exception e) { try { startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS)); } catch (Exception ignored) { } }
                }
            });
        }

        /** "jobs" when the app was opened from a new-job notification (asked once). */
        @JavascriptInterface
        public String launchTab() { String t = launchTab; launchTab = null; return t; }

        /** Stable per phone (and per signing key); survives reinstalling the app, differs on every other phone. */
        @JavascriptInterface
        public String deviceId() {
            String id = android.provider.Settings.Secure.getString(getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
            return id == null ? null : "a-" + id;
        }

        @JavascriptInterface
        public String deviceModel() { return (Build.MANUFACTURER + " " + Build.MODEL).trim(); }
    }
}
