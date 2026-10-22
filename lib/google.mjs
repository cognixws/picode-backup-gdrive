// Google's OAuth for an installed app (loopback redirect + PKCE) with
// COGNIX[WS]'s official client, asking only for drive.file: the app sees
// the files it created, nothing else in the person's Drive.
//
// A desktop client's secret is not confidential (Google's own guidance for
// installed apps): it ships with the app, and PKCE is what protects a
// sign-in.
import { createHash, randomBytes } from "node:crypto";

export const CLIENT_ID = "346734817520-orogjop2gcsg4end83tgbn0a0rhor6oq.apps.googleusercontent.com";
export const CLIENT_SECRET = "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";
export const SCOPE = "https://www.googleapis.com/auth/drive.file";

// endpoints; a test points them at a stand-in.
export function endpoints(env = process.env) {
  // Only a stand-in on this computer: a stray variable cannot send the
  // sign-in anywhere else.
  const test = /^http:\/\/127\.0\.0\.1:\d+$/.test(env.GDRIVE_TEST_BASE || "") ? env.GDRIVE_TEST_BASE : "";
  return test
    ? { auth: test + "/o/oauth2/v2/auth", token: test + "/token", revoke: test + "/revoke", api: test + "/drive/v3", upload: test + "/upload/drive/v3" }
    : { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", revoke: "https://oauth2.googleapis.com/revoke", api: "https://www.googleapis.com/drive/v3", upload: "https://www.googleapis.com/upload/drive/v3" };
}

export class GoogleError extends Error {
  constructor(status, reason = "") { super(status ? `Google answered ${status}${reason ? " (" + reason + ")" : ""}` : "Google did not answer"); this.status = status; this.reason = reason; }
}

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// authRequest makes the sign-in URL and what finishing it needs.
export function authRequest(redirectUri, ep = endpoints()) {
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(24));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
    code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", state,
  });
  return { url: ep.auth + "?" + q, verifier, state };
}

async function form(url, fields) {
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(30_000) });
  } catch { throw new GoogleError(0); }
  let d = {};
  try { d = await r.json(); } catch { /* not JSON */ }
  // Only Google's error code travels, never its description.
  if (!r.ok) throw new GoogleError(r.status, typeof d.error === "string" && /^[a-z_]{1,40}$/.test(d.error) ? d.error : "");
  return d;
}

export async function exchange(code, verifier, redirectUri, ep = endpoints()) {
  const d = await form(ep.token, { code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  if (!d.refresh_token || !d.access_token) throw new GoogleError(502, "no_refresh_token");
  if (!String(d.scope || "").split(" ").includes(SCOPE)) throw new GoogleError(403, "scope_not_granted");
  return { refresh: d.refresh_token, access: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
}

export async function refresh(refreshToken, ep = endpoints()) {
  const d = await form(ep.token, { refresh_token: refreshToken, grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  if (!d.access_token) throw new GoogleError(502, "no_access_token");
  return { access: d.access_token, expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
}

export async function revoke(token, ep = endpoints()) {
  try { await form(ep.revoke, { token }); } catch { /* signing out goes on regardless */ }
}
