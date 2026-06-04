package ie.lzfood.cashier;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

/**
 * Opens LZFOOD cashier in Firefox (not WebView).
 * H10 / Android 5.1: Firefox runs the site; System WebView is too old for React.
 * Built-in printer bridge (LZFOODPrinter) is not available in Firefox — use PrintProxy or WebView on newer devices later.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "LZFOODCashier";

    private static final String[] FIREFOX_PACKAGES = {
        "org.mozilla.firefox",
        "org.mozilla.firefox_beta",
        "org.mozilla.fennec_aurora"
    };

    private String startUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        startUrl = getString(R.string.cashier_start_url);

        if (openInFirefox()) {
            Toast.makeText(this, "已在 Firefox 中打开收银", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        showFallbackScreen();
    }

    private boolean openInFirefox() {
        for (String pkg : FIREFOX_PACKAGES) {
            if (launchBrowser(pkg)) {
                Log.i(TAG, "Opened cashier in Firefox: " + pkg);
                return true;
            }
        }
        Log.w(TAG, "Firefox not found, trying default browser");
        return launchBrowser(null);
    }

    private boolean launchBrowser(String packageName) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(startUrl));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (packageName != null) {
                intent.setPackage(packageName);
            }
            startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "launch failed pkg=" + packageName + ": " + e.getMessage());
            return false;
        }
    }

    private void showFallbackScreen() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        layout.setPadding(pad, pad, pad, pad);

        TextView msg = new TextView(this);
        msg.setText(
            "无法启动 Firefox。\n\n"
                + "请安装 Firefox 后重试。\n\n"
                + "收银地址：\n"
                + startUrl);
        layout.addView(msg);

        Button retry = new Button(this);
        retry.setText("用 Firefox 打开收银");
        retry.setOnClickListener(v -> {
            if (openInFirefox()) {
                finish();
            } else {
                Toast.makeText(this, "仍未找到 Firefox", Toast.LENGTH_SHORT).show();
            }
        });
        layout.addView(retry);

        setContentView(layout);
    }
}
