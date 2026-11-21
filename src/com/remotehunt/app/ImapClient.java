package com.remotehunt.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;


/**
 * Minimal read-only IMAP client (no external libraries): logs in with an app password,
 * lists recent messages and returns From / Subject / Date and the first part of the body.
 * Mail is read on the phone only; nothing is sent to any server other than the mail provider.
 */
public class ImapClient {
    public static class Msg {
        public String seq, from = "", subject = "", date = "", body = "";
    }

    private Socket socket;
    private InputStream in;
    private OutputStream out;
    private int tag = 0;

    public void connect(String host, int port, boolean ssl, int timeoutMs) throws Exception {
        if (ssl) {
            socket = Tls.connect(host, port, timeoutMs); // certificate must belong to `host` (see Tls)
        } else {
            socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
        }
        in = new BufferedInputStream(socket.getInputStream());
        out = socket.getOutputStream();
        String greet = readLine();
        if (!greet.startsWith("* OK")) throw new Exception("Mail server refused the connection: " + greet);
    }

    static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    public void login(String user, String pass) throws Exception {
        if (user.matches("(?s).*[\\r\\n].*") || pass.matches("(?s).*[\\r\\n].*")) throw new Exception("Email or password contains a line break");
        List<String> r = command("LOGIN " + quote(user) + " " + quote(pass));
        String last = r.get(r.size() - 1);
        if (!last.contains(" OK")) {
            throw new Exception(last.contains("AUTHENTICATIONFAILED") || last.contains("Invalid")
                    ? "Login failed: check the email address and app password" : "Login failed: " + last.replaceAll("^\\S+ ", ""));
        }
    }

    /** Messages received in the last `days` days (newest first, at most `max`). */
    public List<Msg> recent(int days, int max, int bodyBytes) throws Exception {
        List<String> sel = command("EXAMINE INBOX"); // read-only: never changes flags
        if (!sel.get(sel.size() - 1).contains(" OK")) throw new Exception("Could not open the inbox");
        SimpleDateFormat f = new SimpleDateFormat("dd-MMM-yyyy", Locale.US);
        String since = f.format(new Date(System.currentTimeMillis() - days * 86400000L));
        List<String> sr = command("SEARCH SINCE " + since);
        List<String> ids = new ArrayList<String>();
        for (String line : sr) {
            if (line.startsWith("* SEARCH")) {
                for (String p : line.substring(8).trim().split("\\s+")) if (p.length() > 0) ids.add(p);
            }
        }
        List<Msg> result = new ArrayList<Msg>();
        if (ids.isEmpty()) return result;
        int from = Math.max(0, ids.size() - max);
        StringBuilder set = new StringBuilder();
        for (int i = from; i < ids.size(); i++) { if (set.length() > 0) set.append(','); set.append(ids.get(i)); }
        String t = nextTag();
        send(t + " FETCH " + set + " (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0." + bodyBytes + ">)");
        Msg cur = null;
        while (true) {
            String line = readLine();
            if (line.startsWith(t + " ")) {
                if (!line.contains(" OK")) throw new Exception("Could not read messages: " + line);
                break;
            }
            if (line.startsWith("* ") && line.contains(" FETCH ")) {
                cur = new Msg();
                cur.seq = line.substring(2, line.indexOf(' ', 2));
                result.add(cur);
            }
            // literals can appear anywhere in the response; consume them in order
            int open = line.lastIndexOf('{');
            while (open >= 0 && line.endsWith("}")) {
                int n = Integer.parseInt(line.substring(open + 1, line.length() - 1));
                String lit = new String(readBytes(n), "UTF-8");
                if (cur != null) {
                    String head = line.toUpperCase(Locale.US);
                    if (head.contains("HEADER.FIELDS")) parseHeaders(cur, lit);
                    else cur.body = lit;
                }
                line = readLine();
                open = line.lastIndexOf('{');
            }
        }
        java.util.Collections.reverse(result);
        return result;
    }

    static void parseHeaders(Msg m, String raw) {
        String unfolded = raw.replaceAll("\r?\n[ \t]+", " ");
        for (String h : unfolded.split("\r?\n")) {
            int c = h.indexOf(':');
            if (c <= 0) continue;
            String k = h.substring(0, c).trim().toLowerCase(Locale.US), v = h.substring(c + 1).trim();
            if (k.equals("from")) m.from = v;
            else if (k.equals("subject")) m.subject = v;
            else if (k.equals("date")) m.date = v;
        }
    }

    public void logout() {
        try { command("LOGOUT"); } catch (Exception ignored) { }
        try { socket.close(); } catch (Exception ignored) { }
    }

    private String nextTag() { return "R" + (++tag); }

    private void send(String s) throws Exception {
        out.write((s + "\r\n").getBytes("UTF-8"));
        out.flush();
    }

    private List<String> command(String cmd) throws Exception {
        String t = nextTag();
        send(t + " " + cmd);
        List<String> lines = new ArrayList<String>();
        while (true) {
            String line = readLine();
            lines.add(line);
            if (line.startsWith(t + " ")) return lines;
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

    private byte[] readBytes(int n) throws Exception {
        byte[] buf = new byte[n];
        int got = 0;
        while (got < n) {
            int r = in.read(buf, got, n - got);
            if (r < 0) throw new Exception("Connection closed while reading");
            got += r;
        }
        return buf;
    }
}
