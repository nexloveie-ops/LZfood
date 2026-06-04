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
 * Full-screen WebView for LZFOOD cashier (not Firefox).
 * CITAQ H10-3 / Android 5.1: Firefox may work while WebView stays white — update System WebView.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "LZFOODCashier";
    private static final int BLANK_CHECK_DELAY_MS = 5000;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private WebView webView;
    private String startUrl;
    private boolean blankCheckDone;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        startUrl = getString(R.string.cashier_start_url);
        webView = new WebView(this);
        setContentView(webView);

        configureWebSettings(webView.getSettings());

        webView.addJavascriptInterface(new PrinterBridge(this), "LZFOODPrinter");
        webView.setWebChromeClient(new CashierWebChromeClient());
        webView.setWebViewClient(new CashierWebViewClient(this::scheduleBlankPageCheck));

        Log.i(TAG, "Loading cashier URL: " + startUrl);
        Log.i(TAG, "WebView UA: " + webView.getSettings().getUserAgentString());
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

    private void scheduleBlankPageCheck(WebView view, String url) {
        if (url == null || !url.startsWith("http")) {
            return;
        }
        blankCheckDone = false;
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(() -> runBlankPageCheck(view), BLANK_CHECK_DELAY_MS);
    }

    private void runBlankPageCheck(WebView view) {
        if (blankCheckDone || view == null) {
            return;
        }
        view.evaluateJavascript(
            "(function(){ try {"
                + " var b = document.body;"
                + " if (!b) return 'no-body';"
                + " var t = (b.innerText || '').replace(/\\s+/g,'').length;"
                + " var r = document.getElementById('root');"
                + " var h = b.innerHTML ? b.innerHTML.length : 0;"
                + " if (t < 8 && h < 80) return 'blank';"
                + " return 'ok:' + t;"
                + " } catch(e) { return 'err:' + e.message; } })();",
            value -> {
                blankCheckDone = true;
                Log.i(TAG, "blank check result=" + value);
                if (value == null || value.contains("blank") || value.contains("no-body")) {
                    showWebViewTooOldPage(view);
                }
            });
    }

    private void showWebViewTooOldPage(WebView view) {
        String html =
            "<html><head><meta charset='utf-8'/>"
            + "<style>body{font-family:sans-serif;padding:14px;font-size:15px;line-height:1.5}"
            + "h2{color:#c62828}ol{padding-left:20px}</style></head><body>"
            + "<h2>收银页白屏（WebView 过旧）</h2>"
            + "<p>您已确认 <b>Firefox 能打开</b> 同一网址，说明网络和网站正常。"
            + "本 App 使用的是 <b>Android 系统 WebView</b>，不是 Firefox，"
            + "当前 H10 上的 WebView 内核太旧，无法运行 LZFOOD 现代收银界面（React）。</p>"
            + "<p><b>请按顺序尝试：</b></p><ol>"
            + "<li>设置 → 应用 → 找到 <b>Android System WebView</b> 或 <b>WebView</b>（不是 Firefox）→ 若有更新则更新，重启设备。</li>"
            + "<li>若无应用商店：在电脑下载 <b>Android System WebView</b> APK（armeabi-v7a，适配 Android 5.x），"
            + "拷到 H10 安装（包名 com.google.android.webview）。</li>"
            + "<li>菜单「刷新」重试；仍白屏则暂用 Firefox 收银（<b>无法驱动内置打印机</b>）。</li>"
            + "</ol>"
            + "<p style='font-size:12px;color:#666'>URL: " + startUrl + "</p>"
            + "</body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        Toast.makeText(this, "WebView 过旧，请更新 System WebView", Toast.LENGTH_LONG).show();
    }

    private void reloadCashier() {
        blankCheckDone = false;
        if (webView != null) {
            webView.loadUrl(startUrl);
        }
    }

    private void openInExternalBrowser() {
        String[] firefoxPackages = {
            "org.mozilla.firefox",
            "org.mozilla.firefox_beta",
            "org.mozilla.fennec_aurora"
        };
        for (String pkg : firefoxPackages) {
            if (tryOpenBrowser(pkg)) {
                Toast.makeText(this, "已在 Firefox 中打开（无法在此模式打印小票）", Toast.LENGTH_LONG).show();
                return;
            }
        }
        if (tryOpenBrowser(null)) {
            Toast.makeText(this, "已用浏览器打开（无法在此模式打印小票）", Toast.LENGTH_LONG).show();
        } else {
            Toast.makeText(this, "未找到 Firefox", Toast.LENGTH_LONG).show();
        }
    }

    private boolean tryOpenBrowser(String packageName) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(startUrl));
            if (packageName != null) {
                intent.setPackage(packageName);
            }
            startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "open browser failed pkg=" + packageName + ": " + e.getMessage());
            return false;
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "刷新");
        menu.add(0, 2, 1, "用 Firefox 打开");
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

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
