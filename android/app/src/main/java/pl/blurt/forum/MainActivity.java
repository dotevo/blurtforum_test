package pl.blurt.forum;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Custom (non-npm) plugins must be registered manually, before
        // super.onCreate() sets up the Capacitor bridge.
        registerPlugin(SecureStoragePlugin.class);
        registerPlugin(BackgroundSeedPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
