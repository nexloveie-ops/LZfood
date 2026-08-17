package ie.lzfood.waiter;

import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.function.Supplier;

/**
 * Keep the waiter WebView on this store's login / cashier pages.
 * Admin, customer, and portal URLs are bounced back to cashier order.
 */
public class WaiterWebViewClient extends WebViewClient {

    private static final String TAG = "LZFOODWaiter";

    public interface FlagInjector {
        void inject(WebView view);
    }

    private final Supplier<String> cashierOrderUrl;
    private final FlagInjector flagInjector;

    public WaiterWebViewClient(Supplier<String> cashierOrderUrl, FlagInjector flagInjector) {
        this.cashierOrderUrl = cashierOrderUrl;
        this.flagInjector = flagInjector;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        if (flagInjector != null) {
            flagInjector.inject(view);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return handleUrl(view, url);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            return handleUrl(view, request.getUrl().toString());
        }
        return false;
    }

    private boolean handleUrl(WebView view, String url) {
        if (url == null) return true;
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            return true;
        }
        Uri uri = Uri.parse(url);
        String path = uri.getPath() != null ? uri.getPath() : "";
        if (path.contains("/admin") || path.contains("/customer") || path.equals("/") || path.isEmpty()) {
            Log.i(TAG, "block leave-cashier: " + url);
            view.loadUrl(cashierOrderUrl.get());
            return true;
        }
        return false;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
            Log.e(TAG, "error " + error.getErrorCode() + " " + error.getDescription());
        }
    }
}
