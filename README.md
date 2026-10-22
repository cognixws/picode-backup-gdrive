# Google Drive for COGNIX[WS] backups

A COGNIX[WS] extension that keeps encrypted copies of your backups in your own
Google Drive, in a folder called **COGNIX[WS] backups**.

COGNIX[WS] encrypts and deduplicates every copy on your computer before it
reaches this extension (ADR-0368). Your Drive holds only encrypted objects
named by their hash: Google can lose a copy, and COGNIX[WS]'s checks will find
it, but it cannot read or change one.

## Set up

1. In COGNIX[WS], open **Backups → Destinations → Add destination** and
   install **Google Drive**, or install this repository from **Extensions**.
2. Open the extension's page and choose **Sign in with Google**. Google asks
   for one permission: to see, edit, create and delete *only the files this
   app creates*. COGNIX[WS] never sees anything else in your Drive.
3. Back in **Add destination**, choose **Google Drive**.

**Signing out** on the extension's page stops copies on this computer; the
copies already in your Drive stay. To remove COGNIX[WS]'s access for every
computer at once, use your Google Account → Security → Third-party
connections.

## How it works

- Sign-in: Google's installed-app flow, a loopback redirect with PKCE, through
  COGNIX[WS]'s official OAuth client (project `cognixws-backups`), asking only
  `drive.file`. The refresh token is sealed by COGNIX[WS] in the extension's
  own encrypted secrets; it never reaches the page, the logs or the core's
  other screens.
- Layout: `COGNIX[WS] backups/<repository>/{config,keys,index,snapshots,locks,data}`.
- Every upload is checked against its name (the SHA-256 of its bytes) while
  it streams, the last piece held back until it matches, and again against
  the checksum Drive computed.
- Ranges always answer 206; only status codes ever reach COGNIX[WS], never
  Google's own error text.
- One place per Google account: its id follows the account, so a destination
  never follows a sign-in into someone else's Drive.

## Test

```bash
node --test test/*.test.mjs
```

The tests run COGNIX[WS]'s conformance kit against a stand-in for Google's
OAuth and Drive v3 APIs (pages of three, tokens that work once, no checksum,
Range ignored, rate limits, folders deleted in Drive).

## License

Apache-2.0.
