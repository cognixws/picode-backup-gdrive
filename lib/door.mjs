// The storage door COGNIX[WS] calls (ADR-0368, decision 10): restic's REST
// protocol, version 2, under /repo/{connection}/{repository}/, kept in the
// person's Google Drive as folders the app created ("COGNIX[WS] backups" /
// repository / type / object), and the closed status at /status.
//
// The core encrypts and names every object by the SHA-256 of its bytes; the
// door checks the hash as the upload streams (the last piece is held back
// until it matches, so a wrong body never becomes a file) and again against
// the checksum Drive computed. Nothing Google says reaches the core but a
// status code.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Transform, pipeline } from "node:stream";
import { Drive, FOLDER } from "./drive.mjs";
import { GoogleError } from "./google.mjs";

export const ROOT_NAME = "COGNIX[WS] backups";
const TYPES = new Set(["data", "index", "snapshots", "keys", "locks"]);
const NAME = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,96}$/;
const MAX_OBJECT = 64 << 20;
const MAX_CONFIG = 1 << 20;
const V2 = "application/vnd.x.restic.rest.v2";

export function send(res, code, body = "", type = "text/plain") {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

// hashed passes a body through, holding its last piece until the whole
// body's SHA-256 is name; otherwise it fails, and the upload never ends.
export function hashed(name) {
  const h = createHash("sha256");
  let held = null;
  return new Transform({
    transform(chunk, _, done) {
      h.update(chunk);
      const out = held;
      held = chunk;
      done(null, out || undefined);
    },
    flush(done) {
      if (h.digest("hex") !== name) return done(new Error("the body is not its name"));
      done(null, held || undefined);
    },
  });
}

// connectionOf names the one place: the account's Drive. Its id follows the
// account, so a destination never follows a sign-in into another Drive.
export function connectionOf(about) {
  const email = String(about?.user?.emailAddress || "").replace(/[\p{Cc}\p{Cf}]/gu, "");
  const id = "drive-" + createHash("sha256").update(String(about?.user?.permissionId || email)).digest("hex").slice(0, 16);
  const text = "My Drive" + (email ? " · " + email : "");
  return { id, label: [...text].length <= 80 ? text : [...text].slice(0, 79).join("") + "…" };
}

export class Door {
  // account() answers { refreshToken } or null while nobody signed in;
  // onRefused runs when Google no longer accepts the sign-in.
  constructor({ account, refused = () => false, onRefused = () => {}, statusTTL = 60_000, statusWaitMs = 2_500, ep }) {
    this.account = account;
    this.refused = refused;
    this.onRefused = onRefused;
    this.statusTTL = statusTTL;
    this.statusWaitMs = statusWaitMs;
    this.ep = ep;
    this.drive = null;
    this.driveFor = "";
    this.place = null;
    this.folders = new Map(); // parent/name → folder id (or its promise)
    this.files = new Map(); // folder/name → { id, size }
    this.cached = null;
    this.inflight = null;
  }

  async client() {
    const a = await this.account();
    if (!a?.refreshToken) return null;
    if (this.driveFor !== a.refreshToken) {
      this.drive = new Drive({ refreshToken: a.refreshToken, onRefused: this.onRefused, ...(this.ep ? { ep: this.ep } : {}) });
      this.driveFor = a.refreshToken;
      this.folders.clear();
      this.files.clear();
      this.place = null;
      this.cached = null;
    }
    return this.drive;
  }

  // folder finds (or, with create, makes) a folder by name; two requests
  // for the same one share a single creation.
  async folder(drive, parent, name, create) {
    const key = parent + "/" + name;
    const known = this.folders.get(key);
    if (known) return known;
    const p = (async () => {
      const found = await drive.find(parent, name, { folders: true });
      if (found.length) return found[0].id;
      if (!create) return "";
      await drive.createFolder(parent, name);
      // Another computer may have made one too: everyone takes the oldest.
      const again = await drive.find(parent, name, { folders: true });
      return again[0]?.id || "";
    })();
    this.folders.set(key, p);
    try {
      const id = await p;
      if (id) this.folders.set(key, id);
      else this.folders.delete(key);
      // A lookup that found nothing does not answer a caller that creates.
      if (!id && create) return this.folder(drive, parent, name, create);
      return id;
    } catch (e) {
      this.folders.delete(key);
      throw e;
    }
  }

  // forget drops what the door remembers of the Drive: a folder someone
  // deleted or trashed is looked up (and made) again.
  forget() {
    this.folders.clear();
    this.files.clear();
  }

  async root(drive, create) { return this.folder(drive, "root", ROOT_NAME, create); }

  async repoFolder(drive, repo, create) {
    const root = await this.root(drive, create);
    return root ? this.folder(drive, root, repo, create) : "";
  }

  async typeFolder(drive, repo, type, create) {
    const r = await this.repoFolder(drive, repo, create);
    return r ? this.folder(drive, r, type, create) : "";
  }

  // file looks an object up by name in a folder; a name stored twice (a
  // retried upload) answers the first copy whose size it shares.
  async file(drive, folder, name) {
    if (!folder) return null;
    const key = folder + "/" + name;
    if (this.files.has(key)) return this.files.get(key);
    const found = (await drive.find(folder, name)).filter((f) => f.mimeType !== FOLDER);
    if (!found.length) return null;
    const f = { id: found[0].id, size: Number(found[0].size) };
    this.files.set(key, f);
    return f;
  }

  async status() {
    let drive;
    try { drive = await this.client(); } catch { return { state: "needs-attention", next: "retry", connections: [] }; }
    if (!drive) return this.refused() ? { state: "needs-attention", next: "sign-in", connections: [] } : { state: "needs-setup", next: "sign-in", connections: [] };
    if (this.cached && this.cached.drive === drive && Date.now() - this.cached.at < (this.cached.value.state === "ready" ? this.statusTTL : 5_000)) return this.cached.value;
    if (!this.inflight) {
      this.inflight = this.probe(drive).then((value) => {
        this.cached = { drive, at: Date.now(), value };
        return value;
      }).finally(() => { this.inflight = null; });
    }
    // COGNIX[WS] waits three seconds for a status: a slow Drive answers what
    // was last known, and the probe goes on to be read next time.
    const late = new Promise((r) => setTimeout(() => r(null), this.statusWaitMs).unref());
    const value = await Promise.race([this.inflight, late]);
    if (value) return value;
    if (this.cached && this.cached.drive === drive) return this.cached.value;
    return { state: "needs-attention", next: "retry", connections: [] };
  }

  async probe(drive) {
    this.forget(); // each look starts from what the Drive holds now
    try {
      const about = await drive.about();
      this.place = connectionOf(about);
      const repositories = [];
      const root = await this.root(drive, false);
      if (root) {
        for await (const f of drive.children(root, { folders: true })) {
          if (!SEGMENT.test(f.name) || repositories.length >= 64) continue;
          if ((await drive.find(f.id, "config")).length) repositories.push(f.name);
        }
      }
      const q = about.storageQuota || {};
      const used = Number(q.usage), total = Number(q.limit);
      return {
        state: "ready",
        connections: [{ ...this.place, ...(Number.isSafeInteger(used) && used >= 0 ? { used } : {}), ...(Number.isSafeInteger(total) && total > 0 ? { total } : {}), deleteAllowed: true, repositories }],
      };
    } catch (e) {
      const code = e instanceof GoogleError ? e.status : 0;
      // A sign-in Google no longer accepts is the person's to renew.
      const signIn = code === 400 || code === 401 || (e instanceof GoogleError && e.reason === "invalid_grant");
      return { state: "needs-attention", next: signIn ? "sign-in" : "retry", connections: [] };
    }
  }

  async handle(req, res, connection, repo, rest) {
    const drive = await this.client();
    if (!drive || !SEGMENT.test(repo)) return send(res, 404, "not found");
    if (!this.place) await this.probe(drive);
    if (!this.place || connection !== this.place.id) return send(res, 404, "not found");
    const url = new URL(req.url, "http://storage");
    if (rest === "/" && req.method === "POST" && url.searchParams.get("create") === "true") {
      for (const t of TYPES) await this.typeFolder(drive, repo, t, true);
      return send(res, 200);
    }
    if (rest === "/config") {
      const folder = await this.repoFolder(drive, repo, req.method === "POST");
      if (req.method === "POST") return this.writeConfig(req, res, drive, folder);
      if (req.method === "GET" || req.method === "HEAD") return this.read(req, res, drive, folder, "config");
      return send(res, 405, "method");
    }
    const parts = rest.split("/").slice(1);
    const type = parts[0];
    if (!TYPES.has(type)) return send(res, 404, "not found");
    if (parts.length === 2 && parts[1] === "" && req.method === "GET") {
      if (!(req.headers.accept || "").includes(V2)) return send(res, 400, "REST version 2 only");
      return this.list(res, drive, await this.typeFolder(drive, repo, type, false));
    }
    if (parts.length !== 2 || !NAME.test(parts[1])) return send(res, 404, "not found");
    const name = parts[1];
    switch (req.method) {
      case "HEAD":
      case "GET":
        return this.read(req, res, drive, await this.typeFolder(drive, repo, type, false), name);
      case "POST":
        return this.write(req, res, drive, await this.typeFolder(drive, repo, type, true), name, repo, type);
      case "DELETE":
        return this.remove(res, drive, await this.typeFolder(drive, repo, type, false), name);
    }
    return send(res, 405, "method");
  }

  async write(req, res, drive, folder, name, repo, type) {
    const size = Number(req.headers["content-length"]);
    if (!(Number.isSafeInteger(size) && size >= 0 && size <= MAX_OBJECT)) return send(res, 400, "size");
    this.files.delete(folder + "/" + name); // a write looks at what is there now
    const have = await this.file(drive, folder, name);
    if (have) {
      req.resume();
      // A name is the hash of its content: the same size is the same object.
      return have.size === size ? send(res, 200) : send(res, 403, "exists");
    }
    let session;
    try {
      session = await drive.startUpload(folder, name, size);
    } catch (e) {
      if (!(e instanceof GoogleError && e.status === 404)) throw e;
      // The folder went (deleted or trashed in Drive): find or make it again.
      this.forget();
      folder = await this.typeFolder(drive, repo, type, true);
      session = await drive.startUpload(folder, name, size);
    }
    let stored;
    try {
      // pipeline passes a cancelled upload on: the session never completes,
      // so Drive keeps no file.
      stored = await drive.upload(session, pipeline(req, hashed(name), () => {}), size);
    } catch (e) {
      return send(res, e instanceof GoogleError && e.status ? 502 : 400, "body");
    }
    // Drive's own checksum, when it gives one, must be the name too.
    if (stored.sha256Checksum && stored.sha256Checksum !== name) {
      await drive.remove(stored.id).catch(() => {});
      return send(res, 502, "storage error");
    }
    this.files.set(folder + "/" + name, { id: stored.id, size });
    return send(res, 200);
  }

  async writeConfig(req, res, drive, folder) {
    const size = Number(req.headers["content-length"]);
    if (!(Number.isSafeInteger(size) && size >= 0 && size <= MAX_CONFIG)) return send(res, 400, "size");
    const chunks = [];
    let got = 0;
    for await (const c of req) { got += c.length; if (got > size) return send(res, 400, "body"); chunks.push(c); }
    if (got !== size) return send(res, 400, "body");
    const body = Buffer.concat(chunks);
    const have = await this.file(drive, folder, "config");
    if (have) return have.size === size ? send(res, 200) : send(res, 403, "exists");
    const stored = await drive.upload(await drive.startUpload(folder, "config", size), body, size);
    this.files.set(folder + "/config", { id: stored.id, size });
    return send(res, 200);
  }

  async read(req, res, drive, folder, name) {
    const head = req.method === "HEAD";
    const range = req.headers.range;
    if (range !== undefined && !/^bytes=\d+-\d*$/.test(range)) return send(res, 416, "range");
    if (head) this.files.delete(folder + "/" + name); // a HEAD looks at what is there now
    const f = await this.file(drive, folder, name);
    if (!f) return send(res, 404, "not found");
    if (head) {
      res.writeHead(200, { "Content-Length": f.size });
      return res.end();
    }
    if (range) {
      const start = Number(/^bytes=(\d+)-/.exec(range)[1]);
      if (start >= f.size) {
        res.writeHead(416, { "Content-Range": "bytes */" + f.size });
        return res.end();
      }
    }
    if (f.size === 0) { res.writeHead(range ? 416 : 200, range ? { "Content-Range": "bytes */0" } : { "Content-Length": 0 }); return res.end(); }
    const r = await drive.download(f.id, range);
    if (r.statusCode === 404) {
      r.resume();
      this.files.delete(folder + "/" + name);
      return send(res, 404, "not found");
    }
    const ranged = /^bytes \d+-\d+\/\d+$/.test(r.headers["content-range"] || "");
    if (r.statusCode !== 200 && r.statusCode !== 206) { r.resume(); return send(res, 502, "storage error"); }
    if (range && r.statusCode === 200 && !ranged) return this.cut(res, r, range, f.size);
    const code = range ? 206 : 200;
    const headers = { "Content-Type": "application/octet-stream" };
    if (/^\d+$/.test(r.headers["content-length"] || "")) headers["Content-Length"] = r.headers["content-length"];
    if (code === 206) {
      if (!ranged) { r.destroy(); return send(res, 502, "storage error"); }
      headers["Content-Range"] = r.headers["content-range"];
    }
    res.writeHead(code, headers);
    // A read the core stops halfway (a capture pauses a copy) ends only that
    // response and Drive's.
    res.on("close", () => { if (!res.writableFinished) r.destroy(); });
    r.on("error", () => res.destroy());
    r.pipe(res);
  }

  cut(res, r, range, total) {
    const [, a, b] = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(a), end = b === "" ? total - 1 : Math.min(Number(b), total - 1);
    if (end < start) {
      r.destroy();
      res.writeHead(416, { "Content-Range": "bytes */" + total });
      return res.end();
    }
    res.writeHead(206, { "Content-Type": "application/octet-stream", "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${total}` });
    let at = 0;
    res.on("close", () => { if (!res.writableFinished) r.destroy(); });
    r.on("error", () => res.destroy());
    r.on("data", (chunk) => {
      const from = Math.max(start - at, 0), to = Math.min(end + 1 - at, chunk.length);
      at += chunk.length;
      if (to > from && !res.write(chunk.subarray(from, to))) { r.pause(); res.once("drain", () => r.resume()); }
      if (at > end) { r.destroy(); res.end(); }
    });
    r.on("end", () => { if (!res.writableEnded) res.destroy(); });
  }

  async remove(res, drive, folder, name) {
    if (!folder) return send(res, 404, "not found");
    const found = (await drive.find(folder, name)).filter((f) => f.mimeType !== FOLDER);
    this.files.delete(folder + "/" + name);
    if (!found.length) return send(res, 404, "not found");
    try {
      for (const f of found) await drive.remove(f.id);
    } catch {
      // Never 403: to the core that means a place that keeps every copy, and
      // a Drive this app made its folder in always lets it delete.
      return send(res, 502, "storage error");
    }
    return send(res, 200);
  }

  async list(res, drive, folder) {
    if (!folder) return send(res, 200, "[]", V2);
    const seen = new Set();
    let open = false;
    try {
      for await (const f of drive.children(folder)) {
        if (res.destroyed) return; // the reader left: stop walking the folder
        if (f.mimeType === FOLDER || !NAME.test(f.name) || seen.has(f.name)) continue;
        seen.add(f.name);
        const entry = JSON.stringify({ name: f.name, size: Number(f.size) || 0 });
        const room = open ? res.write("," + entry) : (res.writeHead(200, { "Content-Type": V2, "Cache-Control": "no-store" }), res.write("[" + entry));
        open = true;
        if (!room && !res.destroyed) await Promise.race([once(res, "drain"), once(res, "close")]);
      }
    } catch {
      return open ? res.destroy() : send(res, 502, "storage error");
    }
    if (!open) return send(res, 200, "[]", V2);
    res.end("]");
  }
}
