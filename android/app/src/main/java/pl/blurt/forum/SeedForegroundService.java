package pl.blurt.forum;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Keeps the app process alive with the screen off by:
 *  1. Running as a foreground service with a persistent (low-importance)
 *     notification, which raises the process's priority so Android's Doze /
 *     App Standby don't suspend it as aggressively.
 *  2. Holding a PARTIAL_WAKE_LOCK, which keeps the CPU running (screen can
 *     still turn off) so JS timers / network sockets in the WebView keep
 *     ticking instead of being paused.
 *
 * This does NOT run the actual seeding logic natively — the existing
 * webtorrent JS in the WebView keeps doing that exactly as before. This
 * service's only job is to stop the OS from freezing that JS.
 *
 * NOTE: written against @capacitor/android 8.x / androidx.core conventions
 * but not compiled in this sandbox (no Android SDK here) — your Gradle
 * build is the first real compile. Send me the error if something doesn't
 * match your exact dependency versions.
 */
public class SeedForegroundService extends Service {

    public static final String ACTION_START = "pl.blurt.forum.action.START_SEED";
    public static final String ACTION_UPDATE = "pl.blurt.forum.action.UPDATE_SEED";
    public static final String ACTION_STOP = "pl.blurt.forum.action.STOP_SEED";
    public static final String EXTRA_FILE_COUNT = "fileCount";

    private static final String CHANNEL_ID = "seeding_channel";
    private static final int NOTIFICATION_ID = 4201;

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        int fileCount = intent != null ? intent.getIntExtra(EXTRA_FILE_COUNT, 0) : 0;

        if (ACTION_STOP.equals(action)) {
            stopSelfCleanly();
            return START_NOT_STICKY;
        }

        Notification notification = buildNotification(fileCount);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ requires declaring the foreground service type at
            // startForeground() time as well as in the manifest.
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        acquireWakeLock();

        return START_STICKY;
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BlurtForum::SeedWakeLock");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) {
            wakeLock.acquire();
        }
    }

    private void stopSelfCleanly() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        stopForeground(true);
        stopSelf();
    }

    private Notification buildNotification(int fileCount) {
        String text = fileCount > 0
            ? "Seedowanie " + fileCount + " " + (fileCount == 1 ? "pliku" : "plików")
            : "Seedowanie aktywne";

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("BlurtForum")
            .setContentText(text)
            // Placeholder system icon — swap for a real monochrome status-bar
            // icon (android:drawable, 24x24dp, white on transparent) before
            // shipping; this is just so the service compiles/runs today.
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Seedowanie w tle", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Stałe powiadomienie widoczne, gdy aplikacja seeduje pliki w tle");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
