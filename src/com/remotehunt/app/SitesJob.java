package com.remotehunt.app;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Background check of the websites you follow, about every 30 minutes (even when the app is closed).
 * It runs the app's own site checker (www/bg.html → js/sites.js) in an invisible WebView, so the background and
 * the app use exactly the same code. New jobs → phone notification and, if you turned it on, an email.
 */
public class SitesJob extends JobService {
    static final long MAX_RUN_MS = 4 * 60 * 1000L;

    final Handler ui = new Handler(Looper.getMainLooper());
    ExecutorService pool;
    final Map<String, String> results = new ConcurrentHashMap<String, String>();
    WebView web;
    JobParameters params;
    boolean finished;

    @Override
    public boolean onStartJob(JobParameters p) {
        if (MainActivity.foreground) return false; // the open app checks by itself
        MainActivity.kvWrite(this, "alerts.bgStart", String.valueOf(System.currentTimeMillis()));
        params = p; finished = false;
        pool = Executors.newFixedThreadPool(3);
        try {
            web = new WebView(getApplicationContext());
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setAllowFileAccess(false);
            web.addJavascriptInterface(new BgBridge(), "Android");
            web.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                    return MainActivity.serveAsset(SitesJob.this, req.getUrl());
                }
            });
            web.loadUrl("https://" + MainActivity.APP_HOST + "/www/bg.html");
        } catch (Throwable t) {
            finish();
            return false;
        }
        ui.postDelayed(new Runnable() { public void run() { finish(); } }, MAX_RUN_MS);
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters p) {
        cleanup();
        return true; // try again later
    }

    void finish() {
        if (finished) return;
        finished = true;
        cleanup();
        try { jobFinished(params, false); } catch (Exception ignored) { }
    }

    void cleanup() {
        ui.removeCallbacksAndMessages(null);
        if (web != null) {
            try { web.stopLoading(); web.destroy(); } catch (Exception ignored) { }
            web = null;
        }
        if (pool != null) pool.shutdownNow();
    }

    void callJs(final String js) {
        ui.post(new Runnable() {
            public void run() { if (web != null) web.evaluateJavascript(js, null); }
        });
    }

    void deliver(final String id, final String json) {
        results.put(id, json);
        callJs("window.__httpDone && __httpDone(" + JSONObject.quote(id) + ")");
    }

    /** The subset of the app's bridge that the site checker needs. */
    class BgBridge {
        @JavascriptInterface public String kvGet(String key) { return MainActivity.kvRead(SitesJob.this, key); }
        @JavascriptInterface public void kvSet(String key, String value) { MainActivity.kvWrite(SitesJob.this, key, value); }
        @JavascriptInterface public void kvRemove(String key) { MainActivity.kvWrite(SitesJob.this, key, null); }
        @JavascriptInterface public String platform() { return "android-bg"; }

        @JavascriptInterface
        public void http(final String id, final String reqJson) {
            pool.execute(new Runnable() { public void run() { deliver(id, MainActivity.doHttp(reqJson)); } });
        }

        @JavascriptInterface
        public void sendMail(final String id, final String cfgJson) {
            pool.execute(new Runnable() { public void run() { deliver(id, Alerts.sendMail(cfgJson)); } });
        }

        @JavascriptInterface
        public String httpTake(String id) {
            String r = results.remove(id);
            return r == null ? "{\"status\":0,\"error\":\"missing\"}" : r;
        }

        @JavascriptInterface
        public void notify(int id, String title, String text) { Alerts.notify(SitesJob.this, id, title, text); }

        @JavascriptInterface
        public boolean notificationsAllowed() { return Alerts.allowed(SitesJob.this); }

        /** The check is over (summary is saved for Settings → New-job alerts). */
        @JavascriptInterface
        public void done(String summary) {
            MainActivity.kvWrite(SitesJob.this, "alerts.bgLast", summary);
            ui.post(new Runnable() { public void run() { finish(); } });
        }
    }
}
