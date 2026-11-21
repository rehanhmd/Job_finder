# RemoteHunt (personal edition)

A private Android app, just for me. It reads my CVs with AI, finds fresh fully-remote jobs on companies' own hiring systems and on trusted remote boards, flags scams, fills application forms, and tracks applications, including email replies.

It runs on my own free Cloudflare server. Nobody else's server, keys or access codes are involved.

## Changes from the original RemoteHunt v3

- **Single owner, no code screen.** There is no admin page and no invite codes. The server checks one secret, `ACCESS_CODE`. The app carries that code in `assets/www/js/config.js` and signs in by itself. If you change the secret on the server, put the new code in `config.js` and rebuild; until then the app asks you to type it. A new sign-in logs the previous phone out.
- **Accounts.** Tap the name at the top to switch, add, rename or delete accounts. Each account has its own CVs (up to 5), profile, standard answers, tracker, saved answers and email settings. The AI, AI keys and job search are shared. The first account is "Me" and keeps your earlier data. Websites you sign in to inside the in-app browser (Workday and so on) stay signed in across accounts.
- **My sites.** On the Jobs tab, paste any job page you want to follow. Three kinds of link work:
  - A company's hiring board, like `jobs.ashbyhq.com/mercor` or `boards.greenhouse.io/scaleai`.
  - A company careers page, like `labelbox.com/company/careers`. If the page embeds Greenhouse, Lever, Ashby, Workable, SmartRecruiters or Recruitee, or links to its "open roles" page, the board is found automatically. For pages that load jobs with JavaScript, the board is found by the company's name.
  - Any other page: its job links are listed.

  Sites are checked when the app opens, at most every 30 minutes, and when you tap ↻ Check. Jobs that appear later are marked **NEW**, and the Jobs tab shows how many. Company boards show remote jobs by default; untick "Only remote jobs" on a site to see all of them. Each account has its own sites.
- **Faster, more reliable AI.** If Gemini's main model hasn't answered within 15 seconds, its light model starts alongside it and the first answer wins. When a stronger provider fails, the reply says why, in `skipped`.
- **Search without AI.** If AI can't read a CV, the basic parser still finds the job title near the top. Search then falls back to job titles and skills instead of stopping.
- **No over-the-air code updates.** The original downloaded unsigned code changes from the server into the app. To update this version, rebuild and reinstall it.
- **Gmail connection is verified.** The IMAP client checks that the server's certificate belongs to the mail server, and sends the server name (SNI). The original accepted any valid certificate, so the app password could be captured. `tests/java/ImapTlsTest.java` demonstrates the difference.
- **Autofill fills only on real hiring sites.** Automatic fill (no tap) works only on known hiring systems (Greenhouse, Lever, Ashby, Workday and others), or on the site of the job you chose, if that job isn't flagged. On any other page you tap ⚡ Autofill yourself.
- **Embedded forms open automatically only from known hiring systems.**
- **A job page can't swap in a fake autofill agent.** The agent no longer lives on `window`.
- **Links are checked.** Job links must be `http(s)`. The in-app browser opens only web pages. `intent:` links can't target the app's own components.
- **Phone hardening:**
  - Chrome debugging is enabled only in debug builds.
  - Android backup is off, so tokens, the mail password and CVs stay on the phone.
  - Plain-http traffic is off.
- **Imported backups are cleaned.** Unknown tracker statuses are reset. A custom AI address must be `https`.
- **Server status is private.** The public `/` page shows only `{"ok":true}`. Provider and crawler status is at `/v1/status`, which requires sign-in.

## One-time setup

All tools live in `~/.local` (Java 17, Node 24, Android SDK, `wrangler`). `build.sh` finds them by itself.

### 1. Server (Cloudflare, free)

```bash
cd server
wrangler login                      # opens the browser; sign up or in to Cloudflare
wrangler d1 create remotehunt       # copy the printed database_id into wrangler.toml
wrangler secret put ACCESS_CODE     # type your code, format RH-XXXXX-XXXXX
wrangler secret put GEMINI_KEY      # optional: free key from https://aistudio.google.com/apikey
wrangler deploy                     # prints https://remotehunt-personal.<you>.workers.dev
```

Optional extra AI keys work the same way: `GROQ_KEY`, `CEREBRAS_KEY`, `OPENROUTER_KEY` and `MISTRAL_KEY`. Several keys can go in one secret, separated by commas. Cloudflare Workers AI is always the last fallback.

The daily AI limit defaults to 200 calls. It protects your keys. Change it with a `DAILY_CAP` variable.

### 2. Put your access code in the app

```bash
cp assets/www/js/config.example.js assets/www/js/config.js   # then edit it: accessCode: 'RH-…'
```

`config.js` is in `.gitignore`, so your code never ends up on GitHub.

### 3. Point the app at your server

`BUILTIN_URL` in `assets/www/js/ai.js` holds your worker's address plus `/v1`. It is already set to `https://remotehunt-personal.hunt-job.workers.dev/v1`.

### 4. Build and install

```bash
./build.sh            # -> build/RemoteHunt.apk
```

Copy the APK to the phone and open it, allowing "Install unknown apps", or use `adb install -r build/RemoteHunt.apk`. Then enter your access code.

The app ID is `com.personal.remotehunt`, so it installs alongside the original RemoteHunt.

**Keep the APK, `debug.keystore` and `config.js` private.** The APK contains your access code. Back up `debug.keystore`: Every update must be signed with the same key. If you lose the key, you must uninstall the app, which erases its data. If someone else gets the key, they can sign a fake update.

## Tests

```bash
cd server && node test.mjs && node crawl.test.mjs && cd ..   # server
node --test tests/unit.test.js                                # app logic (jsdom)
node tests/e2e/run.js                                         # whole app in headless Chrome
javac -d /tmp/it src/com/remotehunt/app/ImapClient.java tests/java/ImapTlsTest.java && java -cp /tmp/it ImapTlsTest   # needs internet
```

Run `javac` and `java` from `~/.local/jdk17/Contents/Home/bin` if they aren't on your PATH.
