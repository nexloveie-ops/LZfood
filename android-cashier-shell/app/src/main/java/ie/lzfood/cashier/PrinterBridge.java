package ie.lzfood.cashier;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

/**
 * window.LZFOODPrinter — used by LZFOOD web app (posPrint.ts) inside WebView only.
 */
public class PrinterBridge {

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public PrinterBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public String getVersion() {
        return "0.3.6-32col";
    }

    @JavascriptInterface
    public void printText(String text, int copies) {
        EscPosPrinter.printText(text, copies, (ok, error) -> mainHandler.post(() -> {
            if (ok) {
                Toast.makeText(context, "已发送到热敏打印机", Toast.LENGTH_SHORT).show();
            } else {
                Toast.makeText(
                    context,
                    "打印失败: " + (error != null ? error : "unknown"),
                    Toast.LENGTH_LONG).show();
            }
        }));
    }

    @JavascriptInterface
    public void printEscPosBase64(String payloadBase64, int copies) {
        printText("[base64 ESC/POS not implemented]", copies);
    }
}
