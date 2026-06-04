package ie.lzfood.cashier;

import android.util.Log;

import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * CITAQ H10-3 internal printer via /dev/ttyS1 @ 115200, ESC/POS.
 * @see <a href="https://briankhuu.com/blog/2023/09/12/citaq-h10-3-exploration-log/">CITAQ H10-3 notes</a>
 */
public final class EscPosPrinter {

    private static final String TAG = "EscPosPrinter";
    private static final String DEVICE_PATH = "/dev/ttyS1";
    private static final int BAUD = 115200;

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();

    private EscPosPrinter() {}

    public static void printText(String text, int copies, PrintCallback callback) {
        EXEC.execute(() -> {
            String err = null;
            for (int i = 0; i < Math.max(1, copies); i++) {
                err = writeOnce(text);
                if (err != null) break;
            }
            if (callback != null) {
                final String result = err;
                callback.onDone(result == null, result);
            }
        });
    }

    private static String writeOnce(String text) {
        byte[] body;
        try {
            body = buildEscPosPayload(text);
        } catch (Exception e) {
            return "build: " + e.getMessage();
        }
        OutputStream out = null;
        try {
            out = new FileOutputStream(DEVICE_PATH);
            out.write(body);
            out.flush();
            Log.i(TAG, "Wrote " + body.length + " bytes to " + DEVICE_PATH);
            return null;
        } catch (IOException e) {
            Log.e(TAG, "Serial write failed: " + e.getMessage());
            return e.getMessage();
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                    /* ignore */
                }
            }
        }
    }

    private static byte[] buildEscPosPayload(String text) throws IOException {
        Charset charset;
        try {
            charset = Charset.forName("GBK");
        } catch (Exception e) {
            charset = Charset.forName("UTF-8");
        }
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        buf.write(new byte[] {0x1B, 0x40}); // ESC @ init
        for (String line : text.replace("\r\n", "\n").split("\n", -1)) {
            buf.write(line.getBytes(charset));
            buf.write('\n');
        }
        buf.write(new byte[] {0x1B, 0x64, 0x04}); // feed 4 lines
        buf.write(new byte[] {0x1D, 0x56, 0x42, 0x00}); // partial cut
        return buf.toByteArray();
    }

    public interface PrintCallback {
        void onDone(boolean ok, String error);
    }
}
