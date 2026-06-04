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
 * CITAQ H10-3 (80mm / 48 cols) via /dev/ttyS1.
 * Web tags: @H@ @C@ center (ESC a, no leading spaces), @A@ right, @N@ left, @T@ bold total, @D@ rule.
 */
public final class EscPosPrinter {

    private static final String TAG = "EscPosPrinter";
    private static final String DEVICE_PATH = "/dev/ttyS1";
    private static final int BAUD = 115200;
    /** 80mm thermal paper — 48 chars per line (58mm ≈ 32). */
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
            writeAlignedLine(buf, line.substring(3), Align.CENTER, Size.DOUBLE);
            return;
        }
        if (line.startsWith("@C@")) {
            writeAlignedLine(buf, line.substring(3), Align.CENTER, Size.NORMAL);
            return;
        }
        if (line.startsWith("@A@")) {
            writeAlignedLine(buf, line.substring(3), Align.RIGHT, Size.NORMAL);
            return;
        }
        if (line.startsWith("@T@")) {
            writeTotalRow(buf, line.substring(3));
            return;
        }
        if (line.startsWith("@D@")) {
            writeAlignedLine(buf, repeatChar('-', LINE_COLS), Align.LEFT, Size.NORMAL);
            return;
        }
        if (line.startsWith("@N@")) {
            writeAlignedLine(buf, line.substring(3), Align.LEFT, Size.NORMAL);
            return;
        }
        if (line.startsWith("@R@")) {
            writeLegacyRow(buf, line.substring(3));
            return;
        }
        writeAlignedLine(buf, line, Align.LEFT, Size.NORMAL);
    }

    private enum Align { LEFT, CENTER, RIGHT }
    private enum Size { NORMAL, DOUBLE }

    /**
     * Print plain text only — no leading/trailing spaces (H10 strips them).
     * Center/right via ESC a in GBK mode.
     */
    private static void writeAlignedLine(
        ByteArrayOutputStream buf,
        String text,
        Align align,
        Size size
    ) throws IOException {
        String t = text == null ? "" : text.trim();
        if (t.isEmpty()) {
            buf.write('\n');
            return;
        }
        resetStyle(buf);
        buf.write(0x1B);
        buf.write(0x61);
        buf.write(align == Align.CENTER ? 1 : align == Align.RIGHT ? 2 : 0);
        if (size == Size.DOUBLE) {
            buf.write(0x1D);
            buf.write(0x21);
            buf.write(0x11);
        }
        buf.write(t.replace('\u20AC', ' ').getBytes(GBK));
        buf.write('\n');
        resetStyle(buf);
    }

    private static void writeTotalRow(ByteArrayOutputStream buf, String payload) throws IOException {
        for (String part : payload.split("\n", -1)) {
            if (part.isEmpty()) continue;
            resetStyle(buf);
            buf.write(0x1B);
            buf.write(0x45);
            buf.write(1);
            buf.write(0x1D);
            buf.write(0x21);
            buf.write(0x01);
            int tab = part.indexOf('\t');
            if (tab >= 0) {
                String left = part.substring(0, tab).trim();
                String right = part.substring(tab + 1).trim();
                int gap = LINE_COLS - displayWidth(left) - displayWidth(right);
                if (gap >= 1) {
                    buf.write(left.replace('\u20AC', ' ').getBytes(GBK));
                    buf.write(repeatChar(' ', gap).getBytes(GBK));
                    buf.write(right.replace('\u20AC', ' ').getBytes(GBK));
                } else {
                    buf.write(left.replace('\u20AC', ' ').getBytes(GBK));
                    buf.write('\n');
                    buf.write(0x1B);
                    buf.write(0x61);
                    buf.write(2);
                    buf.write(right.replace('\u20AC', ' ').getBytes(GBK));
                }
            } else {
                buf.write(part.replace('\u20AC', ' ').getBytes(GBK));
            }
            buf.write('\n');
            resetStyle(buf);
        }
    }

    private static void writeLegacyRow(ByteArrayOutputStream buf, String payload) throws IOException {
        int tab = payload.indexOf('\t');
        if (tab < 0) {
            writeAlignedLine(buf, payload, Align.LEFT, Size.NORMAL);
            return;
        }
        String left = payload.substring(0, tab).trim();
        String right = payload.substring(tab + 1).trim();
        int gap = LINE_COLS - displayWidth(left) - displayWidth(right);
        if (gap >= 1) {
            writeAlignedLine(buf, left + repeatChar(' ', gap) + right, Align.LEFT, Size.NORMAL);
        } else {
            writeAlignedLine(buf, left, Align.LEFT, Size.NORMAL);
            writeAlignedLine(buf, right, Align.RIGHT, Size.NORMAL);
        }
    }

    private static void resetStyle(ByteArrayOutputStream buf) throws IOException {
        buf.write(0x1B);
        buf.write(0x61);
        buf.write(0x00);
        buf.write(0x1B);
        buf.write(0x45);
        buf.write(0x00);
        buf.write(0x1D);
        buf.write(0x21);
        buf.write(0x00);
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
