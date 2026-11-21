import com.remotehunt.app.ImapClient;

/**
 * Network test for the IMAP TLS check (needs internet). Run from the project root:
 *   javac -d /tmp/it src/com/remotehunt/app/ImapClient.java tests/java/ImapTlsTest.java && java -cp /tmp/it ImapTlsTest
 */
public class ImapTlsTest {
    public static void main(String[] a) throws Exception {
        // 1. a real mail server with a matching certificate: connects and greets
        ImapClient ok = new ImapClient();
        ok.connect("imap.gmail.com", 993, true, 15000);
        ok.logout();
        System.out.println("PASS imap.gmail.com: certificate accepted");

        // 2. a valid certificate for a DIFFERENT name must be refused before anything is sent
        try {
            new ImapClient().connect("wrong.host.badssl.com", 443, true, 15000);
            throw new AssertionError("FAIL: certificate for another host name was accepted");
        } catch (AssertionError e) {
            throw e;
        } catch (Exception e) {
            // only a TLS/certificate rejection counts: a timeout or bad greeting means TLS to the wrong host succeeded
            boolean tlsRefused = e instanceof javax.net.ssl.SSLException || String.valueOf(e.getMessage()).contains("certificate is not valid");
            if (!tlsRefused) throw new AssertionError("FAIL: TLS to the wrong host succeeded (then " + e.getClass().getSimpleName() + ")");
            System.out.println("PASS wrong.host.badssl.com refused: " + e.getClass().getSimpleName());
        }
    }
}
