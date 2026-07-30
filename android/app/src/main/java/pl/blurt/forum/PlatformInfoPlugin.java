package pl.blurt.forum;

import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * PlatformInfo — right now just one thing: reliable Android TV detection.
 *
 * Deliberately NOT based on sniffing the WebView's user-agent string (that's
 * what useApp.ts's older isAndroidTV() heuristic does, and it's only ever
 * been used as a *default guess* for a user-toggleable setting — never
 * meant to gate anything). This plugin instead asks Android directly via
 * PackageManager.FEATURE_LEANBACK, the same check Google's own guidance
 * recommends for "is this actually a TV device" — reliable regardless of
 * whatever the WebView happens to report in its UA string.
 *
 * NOTE: this file was written to match the Capacitor Android plugin API as
 * of @capacitor/android 8.x, but could not be compiled in the sandbox this
 * was authored in (no Android SDK available there) -- same caveat as
 * SecureStoragePlugin.java. Your own Gradle build is the first real compile
 * of this file; send me the compiler error if there's an API mismatch.
 */
@CapacitorPlugin(name = "PlatformInfo")
public class PlatformInfoPlugin extends Plugin {

    @PluginMethod
    public void isTV(PluginCall call) {
        boolean isTV = getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
        JSObject ret = new JSObject();
        ret.put("isTV", isTV);
        call.resolve(ret);
    }
}
