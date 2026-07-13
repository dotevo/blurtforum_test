package pl.blurt.forum;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.SharedPreferences;

/**
 * SecureStorage — a small key/value store backed by
 * androidx.security EncryptedSharedPreferences, whose master key lives in
 * the Android Keystore (hardware-backed on most devices). This replaces
 * localStorage for anything sensitive (private keys) on native builds.
 *
 * Deliberately minimal: get/set/remove/clear on string values only. The
 * web app is responsible for JSON.stringify/parse — this plugin doesn't
 * know or care what's inside the string.
 *
 * NOTE: this file was written to match the Capacitor Android plugin API as
 * of @capacitor/android 8.x, but could not be compiled in the sandbox this
 * was authored in (no Android SDK available there). Your own Gradle build
 * is the first real compile of this file — if there's an API mismatch
 * (method name / signature) send me the compiler error and I'll fix it.
 */
@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {

    private static final String FILE_NAME = "blurtforum_secure_kv";

    private SharedPreferences prefs;

    private SharedPreferences getPrefs() throws Exception {
        if (prefs == null) {
            MasterKey masterKey = new MasterKey.Builder(getContext())
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();

            prefs = EncryptedSharedPreferences.create(
                getContext(),
                FILE_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        }
        return prefs;
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("`key` and `value` are required");
            return;
        }
        try {
            getPrefs().edit().putString(key, value).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to write secure value: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("`key` is required");
            return;
        }
        try {
            String value = getPrefs().getString(key, null);
            JSObject ret = new JSObject();
            ret.put("value", value);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to read secure value: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("`key` is required");
            return;
        }
        try {
            getPrefs().edit().remove(key).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to remove secure value: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        try {
            getPrefs().edit().clear().apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to clear secure storage: " + e.getMessage(), e);
        }
    }
}
