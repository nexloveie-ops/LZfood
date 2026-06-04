package ie.lzfood.cashier;

import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

/** Logs JS console from the cashier page (helps debug white screen on old WebView). */
public class CashierWebChromeClient extends WebChromeClient {

    private static final String TAG = "LZFOODWebView";

    @Override
    public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
        Log.d(
            TAG,
            "JS "
                + consoleMessage.messageLevel()
                + " @"
                + consoleMessage.sourceId()
                + ":"
                + consoleMessage.lineNumber()
                + " "
                + consoleMessage.message());
        return true;
    }

    @Override
    public void onProgressChanged(WebView view, int newProgress) {
        if (newProgress == 100) {
            Log.i(TAG, "load progress 100%");
        }
    }
}
