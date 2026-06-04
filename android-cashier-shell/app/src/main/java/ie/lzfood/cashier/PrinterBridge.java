package ie.lzfood.cashier;

import android.content.Context;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

/**
 * Exposed to WebView as window.LZFOODPrinter (see MainActivity).
 * LZFOOD frontend: printText(plain, copies) when bridge exists; else browser print.
 *
 * TODO: replace stub with CITAQ /dev/ttyS1 ESC/POS (115200, GBK for Chinese).
 */
public class PrinterBridge {

    private static final String TAG = "LZFOODPrinter";

    private final Context context;

    public PrinterBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public String getVersion() {
        return "0.1.0-stub";
    }

    @JavascriptInterface
    public void printText(String text, int copies) {
        if (text == null || text.isEmpty()) return;
        int n = copies < 1 ? 1 : copies;
        for (int i = 0; i < n; i++) {
            writeToInternalPrinter(text);
        }
    }

    @JavascriptInterface
    public void printEscPosBase64(String payloadBase64, int copies) {
        // Optional path: decode base64 → raw ESC/POS bytes → serial port
        printText("[ESC/POS base64 not implemented yet]", copies);
    }

    private void writeToInternalPrinter(String plainText) {
        Log.i(TAG, "printText len=" + plainText.length());
        // Stub: visible feedback until serial/Citaq SDK is wired
        Toast.makeText(context, "LZFOOD print (stub) — wire /dev/ttyS1", Toast.LENGTH_SHORT).show();
        // Production: open SerialPort(new File("/dev/ttyS1"), 115200, ...) and write ESC/POS bytes
    }
}
