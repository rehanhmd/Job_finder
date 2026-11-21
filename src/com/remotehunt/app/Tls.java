package com.remotehunt.app;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Locale;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * TLS connection that checks the server's certificate belongs to `host` (a raw SSLSocket does not), and sends
 * SNI. Used for reading mail (IMAP) and sending alerts (SMTP): without the check, anyone on the network with any
 * valid certificate could read the app password. Pure Java so it can be tested on a desktop JVM.
 */
final class Tls {
    private Tls() { }

    static boolean onAndroid() {
        return System.getProperty("java.vm.name", "").toLowerCase(Locale.US).contains("dalvik");
    }

    static SSLSocket connect(String host, int port, int timeoutMs) throws Exception {
        Socket plain = new Socket();
        plain.connect(new InetSocketAddress(host, port), timeoutMs);
        plain.setSoTimeout(timeoutMs);
        SSLSocket s = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(plain, host, port, true);
        boolean checkedByTls = false;
        try {
            SSLParameters p = s.getSSLParameters();
            // Android 7+ and desktop Java (called by reflection: the app compiles against Android 6)
            SSLParameters.class.getMethod("setEndpointIdentificationAlgorithm", String.class).invoke(p, "HTTPS");
            s.setSSLParameters(p);
            checkedByTls = true;
        } catch (Throwable t) { /* older Android: verified below */ }
        s.startHandshake();
        if ((onAndroid() || !checkedByTls) && !HttpsURLConnection.getDefaultHostnameVerifier().verify(host, s.getSession())) {
            try { s.close(); } catch (Exception ignored) { }
            throw new Exception("The mail server's certificate is not valid for " + host + ". Connection stopped to protect your password.");
        }
        return s;
    }
}
