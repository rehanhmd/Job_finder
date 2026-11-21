package com.remotehunt.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONObject;

/**
 * New-job alerts: the 30-minute background check (JobScheduler), phone notifications and alert emails.
 * The app is compiled against Android 6, so the Android 8+ notification channel is created by reflection.
 */
final class Alerts {
    static final String CHANNEL = "new_jobs";
    static final String EXTRA_OPEN = "open";
    static final int JOB_ID = 4711;
    static final long EVERY_MS = 30 * 60 * 1000L;

    private Alerts() { }

    /** Start (or keep) the periodic check, or cancel it. Survives restarts (setPersisted). */
    static void schedule(Context c, boolean on) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            if (!on) { js.cancel(JOB_ID); return; }
            for (JobInfo ji : js.getAllPendingJobs()) if (ji.getId() == JOB_ID && ji.getIntervalMillis() == EVERY_MS) return; // already running
            js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, SitesJob.class))
                    .setPeriodic(EVERY_MS)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build());
        } catch (Exception ignored) { }
    }

    static boolean scheduled(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            for (JobInfo ji : js.getAllPendingJobs()) if (ji.getId() == JOB_ID) return true;
        } catch (Exception ignored) { }
        return false;
    }

    /** Notifications allowed? (Android 13+ asks the user; earlier versions allow them unless turned off.) */
    static boolean allowed(Context c) {
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            return (Boolean) NotificationManager.class.getMethod("areNotificationsEnabled").invoke(nm);
        } catch (Throwable t) { return true; }
    }

    private static void ensureChannel(Context c, NotificationManager nm) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            Class<?> nc = Class.forName("android.app.NotificationChannel");
            Object ch = nc.getConstructor(String.class, CharSequence.class, int.class).newInstance(CHANNEL, "New jobs on your sites", 3 /* IMPORTANCE_DEFAULT */);
            nc.getMethod("setDescription", String.class).invoke(ch, "Jobs that appeared on the websites you follow in RemoteHunt");
            NotificationManager.class.getMethod("createNotificationChannel", nc).invoke(nm, ch);
        } catch (Throwable ignored) { }
    }

    /** Show a notification that opens the app on the Jobs tab. */
    static void notify(Context c, int id, String title, String text) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            ensureChannel(c, nm);
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) b = (Notification.Builder) Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(c, CHANNEL);
            else b = new Notification.Builder(c);
            Intent open = new Intent(c, MainActivity.class).putExtra(EXTRA_OPEN, "jobs").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_UPDATE_CURRENT | 0x04000000 /* FLAG_IMMUTABLE */);
            b.setSmallIcon(android.R.drawable.ic_menu_search)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setStyle(new Notification.BigTextStyle().bigText(text))
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setColor(0xFF6366F1);
            nm.notify(id, b.build());
        } catch (Throwable ignored) { }
    }

    /** cfg: {host, port, user, pass, to, subject, body} → {"status":200} or {"status":0,"error":...}. */
    static String sendMail(String cfgJson) {
        JSONObject res = new JSONObject();
        SmtpClient c = new SmtpClient();
        try {
            JSONObject cfg = new JSONObject(cfgJson);
            String user = cfg.getString("user");
            c.connect(cfg.getString("host"), cfg.optInt("port", 465), true, 25000);
            try {
                c.send(user, cfg.getString("pass"), user, cfg.optString("to", user), cfg.optString("subject", "RemoteHunt"), cfg.optString("body", ""));
            } finally {
                c.quit();
            }
            res.put("status", 200);
        } catch (Exception e) {
            try { res.put("status", 0); res.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
        }
        return res.toString();
    }
}
