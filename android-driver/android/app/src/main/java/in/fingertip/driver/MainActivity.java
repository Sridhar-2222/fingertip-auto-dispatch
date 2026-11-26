package in.fingertip.driver;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

// Owner, 26 Nov 2026: the driver app must keep sending its location and checking for rides when it is not on screen
// (phone in the pocket, WhatsApp opened). Two things stop that on many phones:
//  1. battery saving freezes the app in the background -> ask once to let it run (no prompt when already allowed);
//  2. the web page's timers slow down or stop when hidden -> keep the WebView running after the screen leaves the app.
// The location foreground service (visible "on duty" notification) keeps the app process alive.
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        askToRunInBackground();
    }

    @SuppressLint("BatteryLife")
    private void askToRunInBackground() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception ignored) {
            // Some phones have no such screen; the app still works while on screen.
        }
    }

    private void keepWebViewRunning() {
        if (bridge == null) return;
        WebView w = bridge.getWebView();
        if (w == null) return;
        w.onResume();
        w.resumeTimers();
    }

    @Override
    public void onPause() {
        super.onPause();
        keepWebViewRunning();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewRunning();
    }
}
