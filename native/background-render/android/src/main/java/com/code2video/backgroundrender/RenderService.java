package com.code2video.backgroundrender;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * Foreground service that keeps the app process (and its WebView) alive and the CPU
 * awake while a video renders, so rendering continues after leaving the app.
 */
public class RenderService extends Service {

    static final String CHANNEL_PROGRESS = "c2v_render";
    static final String CHANNEL_DONE = "c2v_done";
    static final int NOTIFICATION_ID = 7101;
    static final int DONE_ID = 7102;
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    private static final long WAKE_LOCK_TIMEOUT_MS = 3 * 60 * 60 * 1000L;
    private PowerManager.WakeLock wakeLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        Notification n = buildProgress(this, title, text, -1);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Code2Video:render");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL_PROGRESS) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_PROGRESS, "ভিডিও রেন্ডার", NotificationManager.IMPORTANCE_LOW);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CHANNEL_DONE) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_DONE, "রেন্ডার সম্পন্ন", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    private static PendingIntent openApp(Context ctx) {
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (launch == null) return null;
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        return PendingIntent.getActivity(ctx, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** progress: 0..100, or negative for an indeterminate bar. */
    static Notification buildProgress(Context ctx, String title, String text, int progress) {
        ensureChannels(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.c2v_ic_render)
            .setContentTitle(title != null ? title : "ভিডিও রেন্ডার হচ্ছে")
            .setContentText(text != null ? text : "")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setProgress(100, Math.max(0, progress), progress < 0)
            .setContentIntent(openApp(ctx));
        return b.build();
    }

    static void notifyProgress(Context ctx, String title, String text, int progress) {
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, buildProgress(ctx, title, text, progress));
        } catch (SecurityException ignored) {
            // Notification permission denied: rendering still continues.
        }
    }

    static void notifyDone(Context ctx, String title, String text) {
        ensureChannels(ctx);
        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_DONE)
            .setSmallIcon(R.drawable.c2v_ic_render)
            .setContentTitle(title)
            .setContentText(text != null ? text : "")
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx))
            .build();
        try {
            NotificationManagerCompat.from(ctx).notify(DONE_ID, n);
        } catch (SecurityException ignored) {
            // Notification permission denied.
        }
    }
}
