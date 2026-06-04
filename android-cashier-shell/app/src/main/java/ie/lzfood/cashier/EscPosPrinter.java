package ie.lzfood.cashier;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * CITAQ H10-3: /dev/ttyS1 @ 115200. Layout is pre-formatted in LZFOOD web (48 cols, fullwidth pad).
 * Tags: @H@ shop name (ASCII double+center), @T@ total row, @D@ divider, @N@ print line as-is.
 */
public final class EscPosPrinter {

    private static final String TAG = "EscPosPrinter";
    private static final String DEVICE_PATH = "/dev/ttyS1";
    private static final int BAUD = 115200;
    private static final int LINE_COLS = 48;

    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private static final Charset GBK;

    static {
        Charset c;
        try {
            c = Charset.forName("GBK");
        } catch (Exception e) {
            c = Charset.forName("UTF-8");
        }
        GBK = c;
    }

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
        configureSerialPort();
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

    private static void configureSerialPort() {
        String cmd = "stty -F " + DEVICE_PATH + " " + BAUD + " raw -echo 2>/dev/null";
        try {
            Process p = Runtime.getRuntime().exec(new String[] {"sh", "-c", cmd});
            p.waitFor();
        } catch (Exception e) {
            Log.w(TAG, "stty skipped: " + e.getMessage());
        }
    }

    private static byte[] buildEscPosPayload(String text) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(4096);
        buf.write(new byte[] {0x1B, 0x40});
        buf.write(new byte[] {0x1B, 0x39, 0x00});
        buf.write(new byte[] {0x1C, 0x26});

        for (String line : text.replace("\r\n", "\n").split("\n", -1)) {
            printTaggedLine(buf, line);
        }

        buf.write(new byte[] {0x1C, 0x2E});
        buf.write(new byte[] {0x1B, 0x64, 0x04});
        buf.write(new byte[] {0x1D, 0x56, 0x42, 0x00});
        return buf.toByteArray();
    }

    private static void printTaggedLine(ByteArrayOutputStream buf, String line) throws IOException {
        if (line.isEmpty()) {
            buf.write('\n');
            return;
        }
        if (line.startsWith("@H@")) {
            writeAsciiCenter(buf, line.substring(3), true);
            return;
        }
        if (line.startsWith("@T@")) {
            writeTotalRow(buf, line.substring(3));
            return;
        }
        if (line.startsWith("@D@")) {
            writeGbkRawLine(buf, repeatChar('-', LINE_COLS));
            return;
        }
        if (line.startsWith("@N@")) {
            writeGbkRawLine(buf, line.substring(3));
            return;
        }
        // Legacy tags from older web bundles
        if (line.startsWith("@C@")) {
            writeGbkRawLine(buf, line.substring(3));
            return;
        }
        if (line.startsWith("@R@")) {
            writeLegacyRow(buf, line.substring(3));
            return;
        }
        writeGbkRawLine(buf, line);
    }

    /** ASCII header: exit GBK, ESC a center + optional double size, re-enter GBK. */
    private static void writeAsciiCenter(ByteArrayOutputStream buf, String text, boolean doubleSize)
        throws IOException {
        String t = text == null ? "" : text.trim();
        if (t.isEmpty()) {
            buf.write('\n');
            return;
        }
        buf.write(new byte[] {0x1C, 0x2E});
        buf.write(0x1B);
        buf.write(0x61);
        buf.write(0x01);
        if (doubleSize) {
            buf.write(0x1D);
            buf.write(0x21);
            buf.write(0x11);
        }
        buf.write(t.getBytes(Charset.forName("US-ASCII")));
        buf.write('\n');
        buf.write(0x1D);
        buf.write(0x21);
        buf.write(0x00);
        buf.write(0x1B);
        buf.write(0x61);
        buf.write(0x00);
        buf.write(new byte[] {0x1B, 0x39, 0x00});
        buf.write(new byte[] {0x1C, 0x26});
    }

    private static void writeTotalRow(ByteArrayOutputStream buf, String payload) throws IOException {
        buf.write(0x1B);
        buf.write(0x45);
        buf.write(1);
        buf.write(0x1D);
        buf.write(0x21);
        buf.write(0x01);
        for (String part : payload.split("\n", -1)) {
            writeGbkRawLine(buf, part);
        }
        buf.write(0x1B);
        buf.write(0x45);
        buf.write(0x00);
        buf.write(0x1D);
        buf.write(0x21);
        buf.write(0x00);
    }

    private static void writeLegacyRow(ByteArrayOutputStream buf, String payload) throws IOException {
        int tab = payload.indexOf('\t');
        if (tab < 0) {
            writeGbkRawLine(buf, payload);
            return;
        }
        String left = payload.substring(0, tab).trim();
        String right = payload.substring(tab + 1).trim();
        int gap = LINE_COLS - displayWidth(left) - displayWidth(right);
        if (gap >= 1) {
            writeGbkRawLine(buf, left + repeatChar(' ', gap) + right);
        } else {
            writeGbkRawLine(buf, left);
            writeGbkRawLine(buf, repeatChar(' ', Math.max(0, LINE_COLS - displayWidth(right))) + right);
        }
    }

    /** Do not trim — leading fullwidth spaces are intentional centering. */
    private static void writeGbkRawLine(ByteArrayOutputStream buf, String text) throws IOException {
        if (text == null) return;
        String safe = text.replace('\u20AC', ' ');
        buf.write(safe.getBytes(GBK));
        buf.write('\n');
    }

    private static int displayWidth(String s) {
        if (s == null || s.isEmpty()) return 0;
        int w = 0;
        for (int i = 0; i < s.length(); ) {
            int cp = s.codePointAt(i);
            w += isWideCodePoint(cp) ? 2 : 1;
            i += Character.charCount(cp);
        }
        return w;
    }

    private static boolean isWideCodePoint(int cp) {
        return Character.isIdeographic(cp)
            || (cp >= 0x3000 && cp <= 0x9FFF)
            || (cp >= 0xAC00 && cp <= 0xD7AF)
            || (cp >= 0xFF01 && cp <= 0xFF60);
    }

    private static String repeatChar(char c, int n) {
        StringBuilder sb = new StringBuilder(n);
        for (int i = 0; i < n; i++) sb.append(c);
        return sb.toString();
    }

    public interface PrintCallback {
        void onDone(boolean ok, String error);
    }
}
