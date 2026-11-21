import com.remotehunt.app.SmtpClient;

import java.io.*;
import java.net.*;
import java.util.*;

/**
 * Tests the alert-email client against a fake SMTP server on this computer (protocol, login, message format),
 * then checks the TLS connection to smtp.gmail.com (certificate + greeting only; nothing is sent; needs internet).
 *   javac -d /tmp/st src/com/remotehunt/app/Tls.java src/com/remotehunt/app/SmtpClient.java tests/java/SmtpTest.java && java -cp /tmp/st SmtpTest
 */
public class SmtpTest {
    static int n = 0;
    static void ok(boolean c, String m) { if (!c) throw new AssertionError(m); n++; }

    public static void main(String[] a) throws Exception {
        final List<String> lines = Collections.synchronizedList(new ArrayList<String>());
        final StringBuilder data = new StringBuilder();
        final ServerSocket ss = new ServerSocket(0);
        Thread srv = new Thread(new Runnable() {
            public void run() {
                try (Socket s = ss.accept()) {
                    BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), "UTF-8"));
                    Writer out = new OutputStreamWriter(s.getOutputStream(), "UTF-8");
                    out.write("220 fake.smtp ready\r\n"); out.flush();
                    String l; boolean inData = false;
                    while ((l = in.readLine()) != null) {
                        if (inData) { if (l.equals(".")) { inData = false; out.write("250 2.0.0 OK queued\r\n"); } else data.append(l).append('\n'); out.flush(); continue; }
                        lines.add(l);
                        if (l.startsWith("EHLO")) out.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 SMTPUTF8\r\n");
                        else if (l.startsWith("AUTH PLAIN ")) out.write(new String(Base64.getDecoder().decode(l.substring(11)), "UTF-8").equals("\0me@gmail.com\0app-pass") ? "235 2.7.0 Accepted\r\n" : "535 5.7.8 Bad credentials\r\n");
                        else if (l.startsWith("MAIL FROM") || l.startsWith("RCPT TO")) out.write("250 OK\r\n");
                        else if (l.equals("DATA")) { out.write("354 Go ahead\r\n"); inData = true; }
                        else if (l.equals("QUIT")) { out.write("221 Bye\r\n"); out.flush(); break; }
                        out.flush();
                    }
                } catch (Exception e) { e.printStackTrace(); }
            }
        });
        srv.start();
        SmtpClient c = new SmtpClient();
        c.connect("127.0.0.1", ss.getLocalPort(), false, 5000);
        String body = "New jobs:\n  • LLM Evaluator — Acme AI\n    https://g/2\n.starts with a dot\n";
        c.send("me@gmail.com", "app-pass", "me@gmail.com", "me@gmail.com", "1 new job: LLM Evaluator at Acme AI", body);
        c.quit();
        srv.join(5000);
        ok(lines.get(0).startsWith("EHLO"), "EHLO first");
        ok(lines.contains("MAIL FROM:<me@gmail.com>") && lines.contains("RCPT TO:<me@gmail.com>"), "envelope from/to yourself");
        String msg = data.toString();
        ok(msg.contains("Subject: =?UTF-8?B?" + Base64.getEncoder().encodeToString("1 new job: LLM Evaluator at Acme AI".getBytes("UTF-8")) + "?="), "UTF-8 subject");
        ok(msg.contains("Content-Type: text/plain; charset=UTF-8") && msg.contains("Content-Transfer-Encoding: base64"), "plain text, base64");
        String b64 = msg.substring(msg.indexOf("\n\n") + 2).replace("\n", "");
        ok(new String(Base64.getDecoder().decode(b64), "UTF-8").equals(body.replace("\n", "\r\n")), "body arrives intact (incl. a line starting with a dot)");
        System.out.println("PASS fake server: login, envelope, subject and body (" + n + " checks)");

        // wrong app password -> clear message
        final ServerSocket ss2 = new ServerSocket(0);
        new Thread(new Runnable() { public void run() {
            try (Socket s = ss2.accept()) { BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream())); Writer out = new OutputStreamWriter(s.getOutputStream());
                out.write("220 x\r\n"); out.flush(); String l;
                while ((l = in.readLine()) != null) { out.write(l.startsWith("EHLO") ? "250 x\r\n" : l.startsWith("AUTH") ? "535 5.7.8 Username and Password not accepted\r\n" : "221 bye\r\n"); out.flush(); if (l.equals("QUIT")) break; }
            } catch (Exception e) { } } }).start();
        SmtpClient c2 = new SmtpClient();
        c2.connect("127.0.0.1", ss2.getLocalPort(), false, 5000);
        try { c2.send("me@gmail.com", "wrong", "me@gmail.com", "me@gmail.com", "s", "b"); throw new AssertionError("no error"); }
        catch (Exception e) { ok(e.getMessage().contains("check the email address and app password"), "wrong password message: " + e.getMessage()); }
        c2.quit();
        // header injection is refused
        try { new SmtpClient().send("a", "b", "a", "x@y.z\r\nBcc: evil@x", "s", "b"); throw new AssertionError("accepted"); } catch (Exception e) { ok(e.getMessage().contains("Invalid"), "CR/LF refused"); }
        System.out.println("PASS wrong password and header injection handled");

        // real Gmail SMTP over TLS: certificate checked, server greets (no login, nothing sent)
        Socket g = com_remotehunt_tls("smtp.gmail.com", 465);
        BufferedReader gin = new BufferedReader(new InputStreamReader(g.getInputStream()));
        String greet = gin.readLine(); g.close();
        ok(greet.startsWith("220"), "gmail greeting: " + greet);
        System.out.println("PASS smtp.gmail.com:465 TLS + certificate OK: " + greet.substring(0, Math.min(40, greet.length())));
    }

    static Socket com_remotehunt_tls(String host, int port) throws Exception {
        java.lang.reflect.Method m = Class.forName("com.remotehunt.app.Tls").getDeclaredMethod("connect", String.class, int.class, int.class);
        m.setAccessible(true);
        return (Socket) m.invoke(null, host, port, 15000);
    }
}
