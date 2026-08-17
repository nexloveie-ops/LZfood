package ie.lzfood.waiter;

import android.annotation.SuppressLint;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Waiter phone app: enter store slug → cashier login (cashier accounts only) → place unpaid orders.
 * No printer / payment. Web UI is the existing cashier order page with ?waiter=1.
 */
public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "lzfood_waiter";
    private static final String KEY_SLUG = "store_slug";
    private static final Pattern SLUG = Pattern.compile("^[a-z0-9][a-z0-9-]{0,62}$");

    private WebView webView;
    private View slugScreen;
    private EditText slugInput;
    private String origin;
    private String storeSlug = "";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        origin = getString(R.string.waiter_origin).replaceAll("/+$", "");

        slugScreen = getLayoutInflater().inflate(R.layout.activity_slug, null);
        slugInput = slugScreen.findViewById(R.id.slug_input);
        Button open = slugScreen.findViewById(R.id.slug_open);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        webView.addJavascriptInterface(new WaiterBridge(), "LZFOODWaiter");
        webView.setWebViewClient(new WaiterWebViewClient(new WaiterWebViewClient.StoreUrls() {
            @Override public String origin() { return origin; }
            @Override public String slug() { return storeSlug; }
            @Override public String loginUrl() { return MainActivity.this.loginUrl(); }
            @Override public String cashierOrderUrl() { return MainActivity.this.cashierOrderUrl(); }
        }, this::injectWaiterFlag));

        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SLUG, "");
        if (saved != null && !saved.isEmpty()) {
            slugInput.setText(saved);
            openStore(saved);
        } else {
            showSlugScreen();
        }

        open.setOnClickListener(v -> openStore(slugInput.getText().toString()));
    }

    private void showSlugScreen() {
        storeSlug = "";
        setContentView(slugScreen);
    }

    private void openStore(String raw) {
        String slug = normalizeSlug(raw);
        if (slug.isEmpty()) {
            Toast.makeText(this, R.string.slug_invalid, Toast.LENGTH_SHORT).show();
            showSlugScreen();
            return;
        }
        storeSlug = slug;
        SharedPreferences.Editor ed = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        ed.putString(KEY_SLUG, slug);
        ed.apply();
        setContentView(webView);
        webView.loadUrl(loginUrl());
    }

    String loginUrl() {
        return origin + "/" + storeSlug + "/login?waiter=1";
    }

    String cashierOrderUrl() {
        return origin + "/" + storeSlug + "/cashier/order?waiter=1";
    }

    private void injectWaiterFlag(WebView view) {
        view.evaluateJavascript("window.LZFOODWaiter={isWaiter:true};", null);
    }

    static String normalizeSlug(String raw) {
        if (raw == null) return "";
        String s = raw.trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]", "");
        if (!SLUG.matcher(s).matches()) return "";
        return s;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView.getParent() != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        if (webView.getParent() != null) {
            showSlugScreen();
            return;
        }
        super.onBackPressed();
    }

    public static class WaiterBridge {
        @JavascriptInterface
        public boolean isWaiter() {
            return true;
        }
    }
}
