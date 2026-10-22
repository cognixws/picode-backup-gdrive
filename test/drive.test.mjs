import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { runConformance } from "./conformance.mjs";
import { fakeGoogle } from "./fake-google.mjs";
import { storage } from "./helpers.mjs";
import { authRequest } from "../lib/google.mjs";
import { connectionOf } from "../lib/door.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

for (const [label, opts] of [["", {}], [" (pages of 3, tokens that work once, no checksum, Range ignored)", { pageSize: 3, expireTokens: true, checksum: false, ignoreRange: true }]]) {
  test("the conformance kit passes" + label, { timeout: 120_000 }, async () => {
    const google = await fakeGoogle(opts);
    const s = await storage(google);
    try {
      const st = await s.status();
      assert.equal(st.state, "ready", JSON.stringify(st));
      const c = st.connections[0];
      assert.equal(c.label, "My Drive · person@example.com");
      assert.equal(c.total, 16106127360);
      const { passed, failed } = await runConformance({ base: `${s.url}/repo/${c.id}/cognix-test`, secret: s.secret, status: s.url + "/status", log: () => {} });
      assert.deepEqual(failed, [], `${passed} passed`);
    } finally { s.stop(); google.close(); }
  });
}

test("nobody signed in asks to sign in; a sign-in Google refuses asks again", { timeout: 60_000 }, async () => {
  const google = await fakeGoogle();
  const none = await storage(google, {});
  try { assert.deepEqual(await none.status(), { state: "needs-setup", next: "sign-in", connections: [] }); } finally { none.stop(); }
  const refused = await storage(google, { refresh_token: "revoked" });
  try {
    assert.deepEqual(await refused.status(), { state: "needs-attention", next: "sign-in", connections: [] });
    const st = await refused.page("/state");
    assert.equal(st.needsSignIn, true);
  } finally { refused.stop(); google.close(); }
});

test("only status codes reach COGNIX[WS], never Google's words", { timeout: 60_000 }, async () => {
  const google = await fakeGoogle();
  const s = await storage(google);
  try {
    const c = (await s.status()).connections[0];
    for (const path of ["/config", "/keys/" + "a".repeat(64)]) {
      const res = await fetch(`${s.url}/repo/${c.id}/r${path}`, { headers: s.basic });
      assert.equal(res.status, 404);
      assert.ok(!(await res.text()).includes("SECRET"));
    }
    const st = JSON.stringify(await s.page("/state"));
    assert.ok(!st.includes("SECRET"));
  } finally { s.stop(); google.close(); }
});

test("a body that is not its name never becomes a file", { timeout: 60_000 }, async () => {
  const google = await fakeGoogle();
  const s = await storage(google);
  try {
    const c = (await s.status()).connections[0];
    await fetch(`${s.url}/repo/${c.id}/r/?create=true`, { method: "POST", headers: s.basic });
    const url = `${s.url}/repo/${c.id}/r/data/${"b".repeat(64)}`;
    const res = await fetch(url, { method: "POST", headers: s.basic, body: randomBytes(100_000) });
    assert.notEqual(res.status, 200);
    assert.equal((await fetch(url, { method: "HEAD", headers: s.basic })).status, 404);
    assert.ok(![...google.files.values()].some((f) => f.name === "b".repeat(64)), "Drive kept a body that is not its name");
  } finally { s.stop(); google.close(); }
});

test("cancelled uploads leave nothing and the next one goes at once", { timeout: 60_000 }, async () => {
  const google = await fakeGoogle();
  const s = await storage(google);
  try {
    const c = (await s.status()).connections[0];
    const base = `${s.url}/repo/${c.id}/r/data/`;
    await fetch(`${s.url}/repo/${c.id}/r/?create=true`, { method: "POST", headers: s.basic });
    await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise((resolve) => {
      const req = request(base + sha(Buffer.from("cancel" + i)), { method: "POST", headers: { ...s.basic, "Content-Length": 4 << 20 } });
      req.on("error", () => resolve());
      req.write(randomBytes(1 << 16));
      setTimeout(() => { req.destroy(); resolve(); }, 300);
    })));
    const body = randomBytes(1000);
    const t = Date.now();
    assert.equal((await fetch(base + sha(body), { method: "POST", headers: s.basic, body })).status, 200);
    assert.ok(Date.now() - t < 3000, "the next upload waited " + (Date.now() - t) + " ms");
    assert.equal([...google.files.values()].filter((f) => f.mimeType === "file").length, 1);
  } finally { s.stop(); google.close(); }
});

test("repositories already in the Drive are named, only those with a config", { timeout: 60_000 }, async () => {
  const google = await fakeGoogle();
  const s = await storage(google);
  try {
    const c = (await s.status()).connections[0];
    for (const r of ["cognix-a", "cognix-b"]) await fetch(`${s.url}/repo/${c.id}/${r}/?create=true`, { method: "POST", headers: s.basic });
    assert.equal((await fetch(`${s.url}/repo/${c.id}/cognix-a/config`, { method: "POST", headers: s.basic, body: randomBytes(10) })).status, 200);
  } finally { s.stop(); }
  const again = await storage(google);
  try { assert.deepEqual((await again.status()).connections[0].repositories, ["cognix-a"]); } finally { again.stop(); google.close(); }
});

test("signing out removes the sealed sign-in; nothing in the Drive goes", { timeout: 60_000 }, async () => {
  const google = await fakeGoogle();
  const s = await storage(google);
  try {
    const c = (await s.status()).connections[0];
    await fetch(`${s.url}/repo/${c.id}/r/?create=true`, { method: "POST", headers: s.basic });
    const before = google.files.size;
    const st = await s.page("/disconnect", "POST");
    assert.equal(st.signedIn, false);
    assert.deepEqual(s.host.writes, ["DELETE refresh_token"]);
    assert.equal(google.files.size, before);
    assert.equal((await s.status()).next, "sign-in");
  } finally { s.stop(); google.close(); }
});

test("the page's relay never reaches the repositories", { timeout: 60_000 }, async () => {
  const google = await fakeGoogle();
  const s = await storage(google);
  try {
    const c = (await s.status()).connections[0];
    for (const path of [`/repo/${c.id}/r/config`, `/x/../repo/${c.id}/r/config`]) {
      assert.equal((await fetch(s.url + path, { headers: { "X-PiCode-Proxy-Secret": s.secret } })).status, 401, path);
    }
  } finally { s.stop(); google.close(); }
});

test("the sign-in URL asks for drive.file only, offline, with PKCE", () => {
  const r = authRequest("http://127.0.0.1:5555/callback");
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), r.state);
  assert.equal(u.searchParams.get("code_challenge"), createHash("sha256").update(r.verifier).digest("base64url"));
});

test("the place follows the account and keeps invisible characters out", () => {
  const a = connectionOf({ user: { emailAddress: "a@x.com", permissionId: "1" } });
  const b = connectionOf({ user: { emailAddress: "a@x.com", permissionId: "2" } });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^drive-[0-9a-f]{16}$/);
  assert.equal(connectionOf({ user: { emailAddress: "a‮@x.com", permissionId: "1" } }).label, "My Drive · a@x.com");
});
