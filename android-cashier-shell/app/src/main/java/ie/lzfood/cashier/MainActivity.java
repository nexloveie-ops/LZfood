package ie.lzfood.cashier;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

/**
 * WebView + LZFOODPrinter → /dev/ttyS1 ESC/POS (CITAQ H10-3).
 * Primary goal: thermal printer. Requires this App (not Firefox) for print bridge.
 * If cashier URL is white screen, update Android System WebView or use menu → 打印机测试.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "LZFOODCashier";
    private static final int BLANK_CHECK_MS = 6000;
    private static final String ASSET_TEST_PAGE = "file:///android_asset/print_test.html";

    private final Handler handler = new Handler(Looper.getMainLooper());

    private WebView webView;
    private String startUrl;
    private boolean blankChecked;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        startUrl = getString(R.string.cashier_start_url);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        webView.addJavascriptInterface(new PrinterBridge(this), "LZFOODPrinter");
        webView.setWebViewClient(new CashierWebViewClient(this::scheduleBlankCheck));

        Log.i(TAG, "Load cashier: " + startUrl);
        webView.loadUrl(startUrl);
    }

    private void scheduleBlankCheck(WebView view, String url) {
        if (url == null || url.startsWith("file://")) {
            return;
        }
        blankChecked = false;
        handler.postDelayed(() -> runBlankCheck(view), BLANK_CHECK_MS);
    }

    private void runBlankCheck(WebView view) {
        if (blankChecked) {
            return;
        }
        view.evaluateJavascript(
            "(function(){ try {"
                + " var t=(document.body&&document.body.innerText||'').replace(/\\s/g,'').length;"
                + " var h=document.body&&document.body.innerHTML?document.body.innerHTML.length:0;"
                + " return (t<8&&h<80)?'blank':'ok';"
                + " } catch(e){ return 'err';} })();",
            value -> {
                blankChecked = true;
                if (value != null && value.contains("blank")) {
                    Toast.makeText(
                        this,
                        "收银页白屏：请更新 System WebView，或菜单→打印机测试",
                        Toast.LENGTH_LONG).show();
                }
            });
    }

    private void reloadCashier() {
        blankChecked = false;
        webView.loadUrl(startUrl);
    }

    private void openPrinterTest() {
        blankChecked = true;
        webView.loadUrl(ASSET_TEST_PAGE);
    }

    private void openInFirefox() {
        String[] pkgs = {"org.mozilla.firefox", "org.mozilla.firefox_beta"};
        for (String pkg : pkgs) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(startUrl));
                i.setPackage(pkg);
                startActivity(i);
                Toast.makeText(this, "Firefox 无法驱动热敏机，仅可浏览", Toast.LENGTH_LONG).show();
                return;
            } catch (Exception ignored) {
                /* try next */
            }
        }
        Toast.makeText(this, "未找到 Firefox", Toast.LENGTH_SHORT).show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "刷新收银");
        menu.add(0, 2, 0, "打印机测试");
        menu.add(0, 3, 2, "用 Firefox 打开(无打印)");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            reloadCashier();
            return true;
        }
        if (item.getItemId() == 2) {
            openPrinterTest();
            return true;
        }
        if (item.getItemId() == 3) {
            openInFirefox();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
