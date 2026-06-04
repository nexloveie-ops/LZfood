package ie.lzfood.cashier;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

/**
 * Full-screen WebView for LZFOOD cashier (not the system browser).
 * CITAQ H10-3 / Android 5.1: may need SSL proceed + updated System WebView.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "LZFOODCashier";

    private WebView webView;
    private String startUrl;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        startUrl = getString(R.string.cashier_start_url);
        webView = new WebView(this);
        setContentView(webView);

        configureWebSettings(webView.getSettings());

        webView.addJavascriptInterface(new PrinterBridge(this), "LZFOODPrinter");
        webView.setWebViewClient(new CashierWebViewClient());

        Log.i(TAG, "Loading cashier URL: " + startUrl);
        Toast.makeText(this, "正在打开收银页…", Toast.LENGTH_SHORT).show();
        webView.loadUrl(startUrl);
    }

    private void configureWebSettings(WebSettings settings) {
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);

        // Help old WebView render modern pages; avoid looking like obsolete default UA.
        String ua = settings.getUserAgentString();
        if (ua != null && !ua.contains("Chrome")) {
            settings.setUserAgentString(ua + " Chrome/94.0 LZFOODCashier/1.0");
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    private void reloadCashier() {
        if (webView != null) {
            webView.loadUrl(startUrl);
        }
    }

    private void openInExternalBrowser() {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(startUrl));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            Toast.makeText(this, "已用系统浏览器打开（仅调试；打印需本 App）", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "无法打开浏览器: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "刷新");
        menu.add(0, 2, 1, "用浏览器打开(调试)");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            reloadCashier();
            return true;
        }
        if (item.getItemId() == 2) {
            openInExternalBrowser();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
