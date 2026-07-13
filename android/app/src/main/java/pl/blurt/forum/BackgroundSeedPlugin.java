package pl.blurt.forum;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * BackgroundSeed — start/stop the foreground service that keeps the app
 * alive (screen off) while the JS webtorrent client seeds.
 *
 * On Android 13+ a foreground service's notification needs POST_NOTIFICATIONS
 * to actually be visible. We request it here (rather than pulling in a full
 * notifications plugin) since it's the one permission this feature needs.
 * If the user denies it, we still start the service — the notification just
 * won't show, but the process stays alive and seeding still works, which
 * matches "seeding shouldn't depend on the user tolerating a notification".
 *
 * NOTE: written against @capacitor/android 8.x conventions (Permission /
 * PermissionCallback / requestPermissionForAlias) but not compiled here (no
 * Android SDK in this sandbox) — first real compile is your Gradle build.
 */
@CapacitorPlugin(
    name = "BackgroundSeed",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class BackgroundSeedPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "startAfterPermissionResult");
            return;
        }
        startServiceInternal(call);
    }

    @PermissionCallback
    private void startAfterPermissionResult(PluginCall call) {
        // Proceed regardless of the grant result: worst case on Android 13+
        // the notification is hidden, but the foreground service + wake
        // lock still run, which is the part that actually matters for
        // seeding to continue with the screen off.
        startServiceInternal(call);
    }

    private void startServiceInternal(PluginCall call) {
        int fileCount = call.getInt("fileCount", 0);
        Intent intent = new Intent(getContext(), SeedForegroundService.class);
        intent.setAction(SeedForegroundService.ACTION_START);
        intent.putExtra(SeedForegroundService.EXTRA_FILE_COUNT, fileCount);
        getContext().startForegroundService(intent);
        call.resolve();
    }

    @PluginMethod
    public void updateCount(PluginCall call) {
        int fileCount = call.getInt("fileCount", 0);
        Intent intent = new Intent(getContext(), SeedForegroundService.class);
        intent.setAction(SeedForegroundService.ACTION_UPDATE);
        intent.putExtra(SeedForegroundService.EXTRA_FILE_COUNT, fileCount);
        getContext().startForegroundService(intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), SeedForegroundService.class);
        intent.setAction(SeedForegroundService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        // Best-effort only — Android doesn't give a cheap direct API for
        // "is my Service currently started"; we track it purely on the JS
        // side (see background-seed.ts) and don't rely on this call.
        JSObject ret = new JSObject();
        ret.put("running", false);
        call.resolve(ret);
    }
}
