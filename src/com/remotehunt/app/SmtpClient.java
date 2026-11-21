package com.remotehunt.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Minimal SMTP client for new-job alerts: logs in with the same app password used for reading mail and sends one
 * plain-text email (normally from you to yourself). No external libraries; pure Java so it can be tested on a
 * desktop JVM.
 */
public class SmtpClient {
    private Socket socket;
    private InputStream in;
    private OutputStream out;

    public void connect(String host, int port, boolean ssl, int timeoutMs) throws Exception {
        if (ssl) {
            socket = Tls.connect(host, port, timeoutMs); // certificate must belong to `host`
        } else {
            socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
        }
        in = new BufferedInputStream(socket.getInputStream());
        out = socket.getOutputStream();
        expect(reply(), 220, "Mail server refused the connection");
    }

    /** Log in (AUTH PLAIN), then send one message. */
    public void send(String user, String pass, String from, String to, String subject, String body) throws Exception {
        for (String v : new String[]{user, pass, from, to, subject}) {
            if (v == null || v.indexOf('\r') >= 0 || v.indexOf('\n') >= 0) throw new Exception("Invalid email settings");
        }
        cmd("EHLO remotehunt.app", 250, "Mail server refused EHLO");
        String r = cmdRaw("AUTH PLAIN " + base64(("\0" + user + "\0" + pass).getBytes("UTF-8")));
        if (!r.startsWith("235")) {
            throw new Exception(r.startsWith("535") || r.startsWith("534")
                    ? "Login failed: check the email address and app password" : "Login failed: " + r);
        }
        cmd("MAIL FROM:<" + from + ">", 250, "Sender refused");
        String rc = cmdRaw("RCPT TO:<" + to + ">");
        if (!rc.startsWith("250") && !rc.startsWith("251")) throw new Exception("Recipient refused: " + rc);
        cmd("DATA", 354, "Mail server refused the message");
        out.write(message(from, to, subject, body, new Date()).getBytes("UTF-8"));
        out.write(".\r\n".getBytes("UTF-8"));
        out.flush();
        expect(reply(), 250, "Message not accepted");
    }

    public void quit() {
        try { cmdRaw("QUIT"); } catch (Exception ignored) { }
        try { socket.close(); } catch (Exception ignored) { }
    }

    /** The full message: headers + base64 body (base64 lines never start with ".", so no dot-stuffing is needed). */
    static String message(String from, String to, String subject, String body, Date date) throws Exception {
        SimpleDateFormat f = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss Z", Locale.US);
        StringBuilder m = new StringBuilder();
        m.append("From: RemoteHunt <").append(from).append(">\r\n");
        m.append("To: <").append(to).append(">\r\n");
        m.append("Subject: =?UTF-8?B?").append(base64(subject.getBytes("UTF-8"))).append("?=\r\n");
        m.append("Date: ").append(f.format(date)).append("\r\n");
        m.append("Message-ID: <").append(date.getTime()).append('.').append(Long.toHexString(Double.doubleToLongBits(Math.random()))).append("@remotehunt.app>\r\n");
        m.append("MIME-Version: 1.0\r\n");
        m.append("Content-Type: text/plain; charset=UTF-8\r\n");
        m.append("Content-Transfer-Encoding: base64\r\n\r\n");
        String b = base64(body.replace("\r\n", "\n").replace("\n", "\r\n").getBytes("UTF-8"));
        for (int i = 0; i < b.length(); i += 76) m.append(b, i, Math.min(b.length(), i + 76)).append("\r\n");
        return m.toString();
    }

    static String base64(byte[] d) {
        final String A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        StringBuilder s = new StringBuilder((d.length + 2) / 3 * 4);
        for (int i = 0; i < d.length; i += 3) {
            int n = (d[i] & 0xff) << 16 | (i + 1 < d.length ? (d[i + 1] & 0xff) << 8 : 0) | (i + 2 < d.length ? d[i + 2] & 0xff : 0);
            s.append(A.charAt(n >> 18 & 63)).append(A.charAt(n >> 12 & 63));
            s.append(i + 1 < d.length ? A.charAt(n >> 6 & 63) : '=');
            s.append(i + 2 < d.length ? A.charAt(n & 63) : '=');
        }
        return s.toString();
    }

    private void cmd(String c, int code, String what) throws Exception { expect(cmdRaw(c), code, what); }

    private String cmdRaw(String c) throws Exception {
        out.write((c + "\r\n").getBytes("UTF-8"));
        out.flush();
        return reply();
    }

    private static void expect(String reply, int code, String what) throws Exception {
        if (!reply.startsWith(String.valueOf(code))) throw new Exception(what + ": " + reply);
    }

    /** One reply; multi-line replies ("250-...") are joined and end at the "250 " line. */
    private String reply() throws Exception {
        StringBuilder all = new StringBuilder();
        while (true) {
            String line = readLine();
            all.append(line);
            if (line.length() < 4 || line.charAt(3) != '-') return all.toString();
            all.append(' ');
        }
    }

    private String readLine() throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
        }
        if (c == -1 && b.size() == 0) throw new Exception("Connection closed by mail server");
        return new String(b.toByteArray(), "UTF-8");
    }
}
