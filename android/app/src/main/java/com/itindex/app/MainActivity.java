package com.itindex.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.itindex.app.pairing.PairingServerPlugin;
import com.itindex.app.security.SecureKeyStorePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PairingServerPlugin.class);
        registerPlugin(SecureKeyStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
