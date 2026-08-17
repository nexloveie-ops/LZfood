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
 * Waiter WebView may only stay on:
 *   /{slug}/login?waiter=1
 *   /{slug}/cashier/... ?waiter=1
 * Everything else (portal, customer, admin) is sent to cashier order.
 */
public class WaiterWebViewClient extends WebViewClient {

    private static final String TAG = "LZFOODWaiter";

    public interface FlagInjector {
        void inject(WebView view);
    }

    public interface StoreUrls {
        String origin();
        String slug();
        String loginUrl();
        String cashierOrderUrl();
    }

    private final StoreUrls urls;
    private final FlagInjector flagInjector;

    public WaiterWebViewClient(StoreUrls urls, FlagInjector flagInjector) {
        this.urls = urls;
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

    @Override
    public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
        super.doUpdateVisitedHistory(view, url, isReload);
        // SPA (React Router) changes path without shouldOverrideUrlLoading.
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            return;
        }
        String rewritten = rewriteToWaiterPage(url);
        if (rewritten == null) {
            Log.i(TAG, "block off-path: " + url);
            view.loadUrl(urls.cashierOrderUrl());
            return;
        }
        if (!rewritten.equals(url)) {
            Log.i(TAG, "rewrite " + url + " -> " + rewritten);
            view.loadUrl(rewritten);
        }
    }

    private boolean handleUrl(WebView view, String url) {
        if (url == null) return true;
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            return true;
        }
        String rewritten = rewriteToWaiterPage(url);
        if (rewritten == null) {
            Log.i(TAG, "block off-path: " + url);
            view.loadUrl(urls.cashierOrderUrl());
            return true;
        }
        if (!rewritten.equals(url)) {
            Log.i(TAG, "rewrite " + url + " -> " + rewritten);
            view.loadUrl(rewritten);
            return true;
        }
        return false;
    }

    /**
     * @return same URL, or URL with waiter=1, or null if not allowed
     */
    String rewriteToWaiterPage(String url) {
        Uri uri = Uri.parse(url);
        String origin = urls.origin();
        String slug = urls.slug();
        if (origin == null || slug == null || slug.isEmpty()) return null;

        String hostPath = uri.getScheme() + "://" + uri.getAuthority();
        if (!origin.equalsIgnoreCase(hostPath)) {
            return null;
        }

        String path = uri.getPath() != null ? uri.getPath() : "";
        String prefix = "/" + slug;
        String loginPath = prefix + "/login";
        String cashierPrefix = prefix + "/cashier";

        boolean login = path.equals(loginPath) || path.equals(loginPath + "/");
        boolean cashier = path.equals(cashierPrefix)
                || path.startsWith(cashierPrefix + "/");
        if (!login && !cashier) {
            return null;
        }

        if ("1".equals(uri.getQueryParameter("waiter"))) {
            return url;
        }
        Uri.Builder b = uri.buildUpon().clearQuery();
        if (uri.getQueryParameterNames() != null) {
            for (String key : uri.getQueryParameterNames()) {
                if ("waiter".equals(key)) continue;
                for (String val : uri.getQueryParameters(key)) {
                    b.appendQueryParameter(key, val);
                }
            }
        }
        b.appendQueryParameter("waiter", "1");
        return b.build().toString();
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
            Log.e(TAG, "error " + error.getErrorCode() + " " + error.getDescription());
        }
    }
}
