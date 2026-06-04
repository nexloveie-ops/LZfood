package ie.lzfood.cashier;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Build;
import android.util.Log;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * WebView client tuned for CITAQ H10-3 (Android 5.1): old system CA store often breaks HTTPS.
 */
public class CashierWebViewClient extends WebViewClient {

    private static final String TAG = "LZFOODWebView";

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        Log.i(TAG, "onPageStarted: " + url);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        Log.i(TAG, "onPageFinished: " + url);
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        // Android 5.x POS WebView: often missing Let's Encrypt roots → blank page without this.
        Log.w(TAG, "SSL error (proceeding for POS compatibility): " + error);
        handler.proceed();
    }

    @Override
    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
        Log.e(TAG, "onReceivedError code=" + errorCode + " desc=" + description + " url=" + failingUrl);
        showErrorPage(view, failingUrl, description);
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
            String desc = error.getDescription() != null ? error.getDescription().toString() : "unknown";
            Log.e(TAG, "onReceivedError (API23+) code=" + error.getErrorCode() + " desc=" + desc);
            showErrorPage(view, request.getUrl().toString(), desc);
        }
    }

    private void showErrorPage(WebView view, String url, String description) {
        String safeUrl = url != null ? url.replace("<", "").replace(">", "") : "";
        String safeDesc = description != null ? description.replace("<", "").replace(">", "") : "";
        String html =
            "<html><body style='font-family:sans-serif;padding:16px'>"
            + "<h3>LZFOOD 页面加载失败</h3>"
            + "<p>这不是系统浏览器，是 App 内置 WebView。</p>"
            + "<p><b>URL:</b> " + safeUrl + "</p>"
            + "<p><b>原因:</b> " + safeDesc + "</p>"
            + "<p>建议：设置 → 应用 → Android System WebView / Chrome → 更新；"
            + "或检查 WiFi 与 https://food.lztechserve.com 是否可访问。</p>"
            + "</body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    @Override
    @SuppressWarnings("deprecation")
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return !isHttpUrl(url);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            return !isHttpUrl(request.getUrl().toString());
        }
        return false;
    }

    private static boolean isHttpUrl(String url) {
        return url != null && (url.startsWith("http://") || url.startsWith("https://"));
    }
}
