package ie.lzfood.waiter;

import android.annotation.SuppressLint;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

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
    private FrameLayout webHost;
    private FrameLayout slugHost;
    private View slugScreen;
    private EditText slugInput;
    private String origin;
    private String storeSlug = "";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        origin = getString(R.string.waiter_origin).replaceAll("/+$", "");

        slugScreen = getLayoutInflater().inflate(R.layout.activity_slug, null);
        slugInput = slugScreen.findViewById(R.id.slug_input);
        Button open = slugScreen.findViewById(R.id.slug_open);

        slugHost = new FrameLayout(this);
        slugHost.addView(slugScreen, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        padForIme(slugHost);

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

        webHost = new FrameLayout(this);
        webHost.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        padForIme(webHost);

        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SLUG, "");
        if (saved != null && !saved.isEmpty()) {
            slugInput.setText(saved);
            openStore(saved);
        } else {
            showSlugScreen();
        }

        open.setOnClickListener(v -> openStore(slugInput.getText().toString()));
    }

    private void padForIme(View host) {
        ViewCompat.setOnApplyWindowInsetsListener(host, (v, insets) -> {
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            Insets sys = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(sys.left, sys.top, sys.right, Math.max(ime.bottom, sys.bottom));
            return insets;
        });
    }

    private void showSlugScreen() {
        storeSlug = "";
        setContentView(slugHost);
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
        setContentView(webHost);
        webView.loadUrl(loginUrl());
    }

    String loginUrl() {
        return origin + "/" + storeSlug + "/login?waiter=1";
    }

    String cashierOrderUrl() {
        return origin + "/" + storeSlug + "/cashier/order?waiter=1";
    }

    private void injectWaiterFlag(WebView view) {
        view.evaluateJavascript(
                "window.LZFOODWaiter={isWaiter:true};"
                        + "document.documentElement.classList.add('lzfood-waiter');"
                        + "(function(){"
                        + "if(document.getElementById('lz-waiter-css'))return;"
                        + "var s=document.createElement('style');s.id='lz-waiter-css';"
                        + "s.textContent='html.lzfood-waiter .option-group__choices{grid-template-columns:repeat(3,minmax(0,1fr))!important}';"
                        + "document.documentElement.appendChild(s);"
                        + "})();",
                null);
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
        if (webView.getParent() != null && webHost.getParent() != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        if (webHost.getParent() != null) {
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
