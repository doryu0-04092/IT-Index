package com.itindex.app.pairing;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * LAN内直接ペアリングのAndroid側「待ち受け役」。
 *
 * POST /sync を1本だけ受け付ける最小のHTTPサーバーを、Android標準の ServerSocket だけで実装する
 * （NanoHTTPD等の外部ライブラリは追加しない）。
 *
 * このプラグインは搬送だけを担う。受信した本文（文字列）をそのままJS側（'pairingRequest'イベント）へ渡し、
 * JS側が respond() で返した文字列をそのまま応答として返すだけで、暗号化・JSONの解釈・マージは一切行わない
 * （それらは src/pairing/ が担当済み）。
 *
 * PC側の同等実装 electron/pairingServer.ts とプロトコル・タイムアウト・サイズ上限を揃えている。
 */
@CapacitorPlugin(name = "PairingServer")
public class PairingServerPlugin extends Plugin {

    private static final int PREFERRED_PORT = 17321;
    private static final int PORT_FALLBACK_ATTEMPTS = 10;
    private static final long MAX_BODY_BYTES = 32L * 1024 * 1024; // 32MB。PC側と揃える
    private static final int SESSION_TIMEOUT_MS = 120_000; // 誰も接続してこなければ自動的に閉じる
    private static final int RESPONSE_TIMEOUT_MS = 30_000; // JS側からのrespond()待ちタイムアウト

    /** 受信処理・タイムアウト監視用。UIスレッドをブロックしないため、すべてここで実行する。 */
    private final ExecutorService executor = Executors.newCachedThreadPool();

    private final Map<String, PendingRequest> pending = new ConcurrentHashMap<>();
    private int requestCounter = 0;

    private volatile ServerSocket serverSocket;
    private volatile Thread acceptThread;
    private final Object lifecycleLock = new Object();

    private static final class PendingRequest {
        final Socket socket;
        final Future<?> timeoutFuture;

        PendingRequest(Socket socket, Future<?> timeoutFuture) {
            this.socket = socket;
            this.timeoutFuture = timeoutFuture;
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        synchronized (lifecycleLock) {
            stopInternal();

            String lanAddress = pickLanAddress();
            if (lanAddress == null) {
                JSObject ret = new JSObject();
                ret.put("url", JSObject.NULL);
                ret.put("reason", "LAN内で到達可能なIPv4アドレスが見つかりませんでした。Wi-Fi/LAN接続を確認してください。");
                call.resolve(ret);
                return;
            }

            ServerSocket socket = null;
            int boundPort = -1;
            for (int i = 0; i <= PORT_FALLBACK_ATTEMPTS; i++) {
                int port = PREFERRED_PORT + i;
                try {
                    ServerSocket candidate = new ServerSocket();
                    candidate.setReuseAddress(true);
                    candidate.bind(new InetSocketAddress(port));
                    socket = candidate;
                    boundPort = port;
                    break;
                } catch (IOException e) {
                    // このポートは使用中。次のポートへフォールバック
                }
            }

            if (socket == null) {
                JSObject ret = new JSObject();
                ret.put("url", JSObject.NULL);
                ret.put("reason", "ポート" + PREFERRED_PORT + "付近が使用中のため、サーバーを起動できませんでした。");
                call.resolve(ret);
                return;
            }

            this.serverSocket = socket;
            final ServerSocket finalSocket = socket;
            acceptThread = new Thread(() -> acceptLoop(finalSocket), "pairing-server-accept");
            acceptThread.setDaemon(true);
            acceptThread.start();

            JSObject ret = new JSObject();
            ret.put("url", "http://" + lanAddress + ":" + boundPort);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        synchronized (lifecycleLock) {
            stopInternal();
        }
        call.resolve();
    }

    @PluginMethod
    public void respond(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId == null) {
            call.reject("requestId is required");
            return;
        }
        String body = call.getString("body"); // null可: エラー応答(400)を意味する

        PendingRequest request = pending.remove(requestId);
        if (request == null) {
            // 既にタイムアウト済み・不明なIDは無視（PC側の挙動と揃える）
            call.resolve();
            return;
        }
        request.timeoutFuture.cancel(false);

        executor.execute(() -> {
            if (body == null) {
                writeResponse(request.socket, 400, "Bad Request");
            } else {
                writeResponse(request.socket, 200, body);
            }
            closeQuietly(request.socket);
            // 1セッション1回のみ。応答を返したら自動でサーバーを閉じる
            synchronized (lifecycleLock) {
                stopInternal();
            }
        });

        call.resolve();
    }

    @Override
    protected void handleOnStop() {
        // アプリがバックグラウンドに回ったときにポートを掴んだままにしない
        synchronized (lifecycleLock) {
            stopInternal();
        }
        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lifecycleLock) {
            stopInternal();
        }
        super.handleOnDestroy();
    }

    /** サーバーを停止する。二重呼び出しでも失敗しない。呼び出し元で lifecycleLock を保持していること。 */
    private void stopInternal() {
        ServerSocket socket = this.serverSocket;
        this.serverSocket = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // close失敗は無視してよい
            }
        }

        Thread thread = this.acceptThread;
        this.acceptThread = null;
        if (thread != null && thread.isAlive()) {
            thread.interrupt();
        }

        // 応答待ちのリクエストが残っていれば、ソケットを畳む前にエラー応答を返しておく
        for (Map.Entry<String, PendingRequest> entry : pending.entrySet()) {
            PendingRequest request = entry.getValue();
            request.timeoutFuture.cancel(false);
            writeResponse(request.socket, 503, "Service Unavailable");
            closeQuietly(request.socket);
        }
        pending.clear();
    }

    private void acceptLoop(ServerSocket socket) {
        try {
            socket.setSoTimeout(SESSION_TIMEOUT_MS);
            Socket client = socket.accept(); // 1セッションにつき1回だけ受け付ける
            // これ以上の接続は受け付けない。以後の到達はサーバーソケットのクローズで自然に拒否される
            closeQuietly(socket);
            synchronized (lifecycleLock) {
                if (this.serverSocket == socket) {
                    this.serverSocket = null;
                }
            }
            handleClient(client);
        } catch (SocketTimeoutException e) {
            // 誰も接続してこなかった。セッションタイムアウトで終了
            synchronized (lifecycleLock) {
                stopInternal();
            }
        } catch (IOException e) {
            // stop() でサーバーソケットが閉じられた場合など。異常ではない
        }
    }

    private void handleClient(Socket client) {
        executor.execute(() -> {
            try {
                client.setSoTimeout(RESPONSE_TIMEOUT_MS);
                InputStream in = client.getInputStream();

                ParsedRequest req;
                try {
                    req = readRequest(in);
                } catch (TooLargeException e) {
                    writeResponse(client, 413, "Payload Too Large");
                    closeQuietly(client);
                    synchronized (lifecycleLock) {
                        stopInternal();
                    }
                    return;
                } catch (IOException e) {
                    writeResponse(client, 400, "Bad Request");
                    closeQuietly(client);
                    synchronized (lifecycleLock) {
                        stopInternal();
                    }
                    return;
                }

                if (!"POST".equals(req.method) || !"/sync".equals(req.path)) {
                    writeResponse(client, 404, "Not Found");
                    closeQuietly(client);
                    synchronized (lifecycleLock) {
                        stopInternal();
                    }
                    return;
                }

                String requestId;
                synchronized (this) {
                    requestCounter += 1;
                    requestId = "req-" + System.currentTimeMillis() + "-" + requestCounter;
                }

                final String finalRequestId = requestId;
                Future<?> timeoutFuture = executor.submit(() -> {
                    try {
                        Thread.sleep(RESPONSE_TIMEOUT_MS);
                    } catch (InterruptedException e) {
                        return; // respond()が先に処理し、このタスクはキャンセル済み
                    }
                    PendingRequest timedOut = pending.remove(finalRequestId);
                    if (timedOut != null) {
                        writeResponse(timedOut.socket, 504, "Gateway Timeout");
                        closeQuietly(timedOut.socket);
                        synchronized (lifecycleLock) {
                            stopInternal();
                        }
                    }
                });

                pending.put(requestId, new PendingRequest(client, timeoutFuture));

                JSObject data = new JSObject();
                data.put("requestId", requestId);
                data.put("body", req.body);
                notifyListeners("pairingRequest", data);
            } catch (IOException e) {
                closeQuietly(client);
                synchronized (lifecycleLock) {
                    stopInternal();
                }
            }
        });
    }

    // ---- HTTPの最小パース ----

    private static final class ParsedRequest {
        String method;
        String path;
        String body;
    }

    private static final class TooLargeException extends IOException {
    }

    private ParsedRequest readRequest(InputStream in) throws IOException {
        String requestLine = readLine(in);
        if (requestLine == null || requestLine.isEmpty()) {
            throw new IOException("empty request line");
        }
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) {
            throw new IOException("malformed request line");
        }

        ParsedRequest result = new ParsedRequest();
        result.method = parts[0];
        result.path = parts[1];

        long contentLength = -1;
        boolean chunked = false;
        String line;
        while ((line = readLine(in)) != null && !line.isEmpty()) {
            String lower = line.toLowerCase(Locale.ROOT);
            if (lower.startsWith("content-length:")) {
                try {
                    contentLength = Long.parseLong(line.substring(line.indexOf(':') + 1).trim());
                } catch (NumberFormatException e) {
                    throw new IOException("malformed content-length");
                }
            } else if (lower.startsWith("transfer-encoding:") && lower.contains("chunked")) {
                chunked = true;
            }
        }

        if (chunked) {
            // 本プロトコルはPC側(electron/pairingServer.ts)同様、単純なContent-Length本文のみを想定する
            throw new IOException("chunked transfer-encoding is not supported");
        }

        if (contentLength < 0) {
            result.body = "";
            return result;
        }

        if (contentLength > MAX_BODY_BYTES) {
            throw new TooLargeException();
        }

        byte[] buffer = new byte[(int) contentLength];
        int read = 0;
        while (read < buffer.length) {
            int n = in.read(buffer, read, buffer.length - read);
            if (n < 0) {
                throw new IOException("unexpected end of stream while reading body");
            }
            read += n;
        }

        result.body = new String(buffer, StandardCharsets.UTF_8);
        return result;
    }

    /** '\n' までを1行として読む。ヘッダはASCII/Latin-1前提。バッファリングせず、本文の読み取り開始位置を正確に保つ。 */
    private String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int b;
        boolean sawAny = false;
        while ((b = in.read()) != -1) {
            sawAny = true;
            if (b == '\n') {
                break;
            }
            if (b != '\r') {
                line.write(b);
            }
        }
        if (!sawAny && line.size() == 0) {
            return null; // EOF
        }
        return line.toString(StandardCharsets.ISO_8859_1.name());
    }

    private void writeResponse(Socket socket, int statusCode, String body) {
        try {
            OutputStream out = socket.getOutputStream();
            byte[] bodyBytes = body.getBytes(StandardCharsets.UTF_8);
            String statusText = statusText(statusCode);
            String headers = "HTTP/1.1 " + statusCode + " " + statusText + "\r\n"
                + "Content-Type: text/plain; charset=utf-8\r\n"
                + "Content-Length: " + bodyBytes.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";
            out.write(headers.getBytes(StandardCharsets.ISO_8859_1));
            out.write(bodyBytes);
            out.flush();
        } catch (IOException e) {
            // 相手が既に切断している等。送れなくても後続のクローズ処理は続ける
        }
    }

    private String statusText(int statusCode) {
        switch (statusCode) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 413: return "Payload Too Large";
            case 503: return "Service Unavailable";
            case 504: return "Gateway Timeout";
            default: return "Unknown";
        }
    }

    private void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // close失敗は無視してよい
        }
    }

    /** ServerSocket は Socket を継承していないため、待ち受け側にも同じ形の後始末を用意する */
    private void closeQuietly(ServerSocket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // close失敗は無視してよい
        }
    }

    private String pickLanAddress() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            String fallback = null;
            while (interfaces.hasMoreElements()) {
                NetworkInterface iface = interfaces.nextElement();
                if (iface.isLoopback() || !iface.isUp()) {
                    continue;
                }
                Enumeration<InetAddress> addresses = iface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress addr = addresses.nextElement();
                    if (addr.isLoopbackAddress() || addr.getAddress().length != 4) {
                        continue; // IPv4のみ、ループバック以外
                    }
                    String host = addr.getHostAddress();
                    if (host == null) continue;
                    if (isPrivateAddress(host)) {
                        return host;
                    }
                    if (fallback == null) {
                        fallback = host;
                    }
                }
            }
            return fallback;
        } catch (SocketException e) {
            return null;
        }
    }

    private boolean isPrivateAddress(String addr) {
        if (addr.startsWith("192.168.")) return true;
        if (addr.startsWith("10.")) return true;
        if (addr.startsWith("172.")) {
            String[] parts = addr.split("\\.");
            if (parts.length > 1) {
                try {
                    int second = Integer.parseInt(parts[1]);
                    return second >= 16 && second <= 31;
                } catch (NumberFormatException ignored) {
                    return false;
                }
            }
        }
        return false;
    }
}
