// Google Drive backup storage for COGNIX[WS] (ADR-0368): encrypted copies
// of your backups in your own Drive, in a "COGNIX[WS] backups" folder. The
// core encrypts every object before it reaches this process, and the app
// sees only the files it created (drive.file).
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Door, send } from "./lib/door.mjs";
import { authRequest, exchange } from "./lib/google.mjs";
import { HostAPI } from "./lib/host.mjs";

const env = process.env;
const required = ["PICODE_URL", "PICODE_EXT_TOKEN", "PICODE_EXT_DATA", "PICODE_EXT_PORT", "PICODE_EXT_PROXY_SECRET"];
if (Number(process.versions.node.split(".")[0]) < 22 || required.some((k) => !env[k])) {
  console.error("Start this storage from COGNIX[WS] (Node.js 22 or newer).");
  process.exit(1);
}
const secret = env.PICODE_EXT_PROXY_SECRET;
const host = new HostAPI({ url: env.PICODE_URL, token: env.PICODE_EXT_TOKEN, dataDir: env.PICODE_EXT_DATA });
const SECRET_KEY = "refresh_token";

// The sign-in is a sealed secret the process keeps itself (writer: process):
// read once, then followed in memory as this process signs in and out.
let token;
let refused = false;
async function account() {
  if (token === undefined) {
    const s = await host.request("/api/ext/v1/settings"); // throws while the host does not answer
    token = s?.secrets?.[SECRET_KEY] || "";
  }
  return token && !refused ? { refreshToken: token } : null;
}
const door = new Door({ account, refused: () => refused, onRefused: () => { refused = true; } });

// ---- the sign-in, on a loopback redirect ----
let pending = null; // { server, state, verifier, redirect, timer }
async function connect() {
  closePending();
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const req = authRequest(redirect);
  pending = { server, state: req.state, verifier: req.verifier, redirect, timer: setTimeout(closePending, 10 * 60e3) };
  server.on("request", async (rq, rs) => {
    const u = new URL(rq.url, redirect);
    const page = (title, line) => { rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); rs.end(`<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${title}</title><body style="font:16px system-ui;margin:3rem;max-width:36rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${line}</p></body>`); };
    if (u.pathname !== "/callback") { rs.writeHead(404); rs.end(); return; }
    const mine = pending;
    if (!mine || u.searchParams.get("state") !== mine.state) { page("Sign-in expired", "Start again from COGNIX[WS] → Google Drive."); return; }
    if (u.searchParams.get("error")) { page("Not connected", "Google did not grant access. You can close this tab."); closePending(mine); return; }
    try {
      const t = await exchange(u.searchParams.get("code"), mine.verifier, mine.redirect);
      // Signed out, or a newer sign-in started, while Google answered: this
      // one keeps nothing.
      if (pending !== mine) { page("Sign-in replaced", "Start again from COGNIX[WS] → Google Drive."); return; }
      await host.request(`/api/ext/v1/secrets/${SECRET_KEY}`, { method: "PUT", body: { value: t.refresh } });
      token = t.refresh;
      refused = false;
      page("Connected to Google Drive", "You can close this tab and go back to COGNIX[WS]. Add a destination in Backups to start copying.");
    } catch (e) {
      page("Not connected", e?.reason === "scope_not_granted" ? "COGNIX[WS] needs permission to keep its own files in your Drive. Start again and allow it." : "The sign-in did not finish. Start again from COGNIX[WS].");
    }
    closePending(mine);
  });
  return { url: req.url };
}
function closePending(only) {
  if (!pending || (only && pending !== only)) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending = null;
}

// Signing out forgets the sign-in on this computer only. Google's revoke
// would end the app's access for the whole account, cutting off every other
// computer signed in with it; the person does that from their Google
// Account when they mean it.
async function disconnect() {
  closePending();
  await host.request(`/api/ext/v1/secrets/${SECRET_KEY}`, { method: "DELETE" });
  token = "";
  refused = false;
}

async function state() {
  const a = await account().catch(() => null);
  const st = a ? await door.status({ wait: true }) : null;
  const place = st?.connections?.[0];
  return { signedIn: !!token && !refused, needsSignIn: refused, signingIn: !!pending, account: place?.label || "", used: place?.used, total: place?.total, problem: st && st.state !== "ready" ? st.next : "" };
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
// The core sends the relay's secret as a header and as Basic picode:<secret>.
// The repositories ask for Basic: a page's relay sends only the header and
// must never reach them (ADR-0368, decision 13).
function basicOK(req) {
  const basic = /^Basic (.+)$/.exec(req.headers.authorization || "");
  return !!basic && same(Buffer.from(basic[1], "base64").toString(), "picode:" + secret);
}
function allowed(req, repositoryRoute) {
  if (repositoryRoute) return basicOK(req);
  return same(req.headers["x-picode-proxy-secret"] || "", secret) || basicOK(req);
}
const json = (res, code, value) => send(res, code, JSON.stringify(value), "application/json");

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://storage").pathname;
    const repo = path.startsWith("/repo/");
    if (!allowed(req, repo)) return send(res, 401, "unauthorized");
    if (path === "/status" && req.method === "GET") return json(res, 200, await door.status());
    if (path === "/state" && req.method === "GET") return json(res, 200, await state());
    if (path === "/connect" && req.method === "POST") return json(res, 200, await connect());
    if (path === "/disconnect" && req.method === "POST") { await disconnect(); return json(res, 200, await state()); }
    const m = /^\/repo\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (!m) return send(res, 404, "not found");
    return await door.handle(req, res, m[1], m[2], m[3]);
  } catch {
    send(res, 502, "storage error");
  }
});
server.listen(Number(env.PICODE_EXT_PORT), "127.0.0.1");

function shutdown() { closePending(); server.close(); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
