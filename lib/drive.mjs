// A small Google Drive v3 client: the calls a backup repository needs, with
// the access token refreshed as it expires. Bodies stream both ways; answers
// come back raw and the door decides what they mean.
import http from "node:http";
import https from "node:https";
import { GoogleError, endpoints, refresh } from "./google.mjs";

const agents = { "http:": new http.Agent({ keepAlive: true, maxSockets: 16 }), "https:": new https.Agent({ keepAlive: true, maxSockets: 16 }) };
export const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,size,mimeType,sha256Checksum";

export class Drive {
  // refreshToken is the person's sign-in; onRefused runs when Google no
  // longer accepts it (the person signs in again).
  constructor({ refreshToken, onRefused = () => {}, ep = endpoints(), timeoutMs = 60_000 }) {
    this.refreshToken = refreshToken;
    this.onRefused = onRefused;
    this.ep = ep;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenAt = 0;
    this.refreshing = null;
  }

  async access(force = false) {
    if (!force && this.token && Date.now() < this.tokenAt - 60_000) return this.token;
    if (!this.refreshing) {
      this.refreshing = refresh(this.refreshToken, this.ep).then((t) => {
        this.token = t.access;
        this.tokenAt = t.expiresAt;
        return t.access;
      }, (e) => {
        if (e instanceof GoogleError && (e.reason === "invalid_grant" || e.status === 400 || e.status === 401)) this.onRefused();
        throw e;
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  // raw sends one request; body is a Buffer or a readable stream (with
  // contentLength). A 401 refreshes the token once for a request without a
  // streamed body.
  async raw(method, url, { headers = {}, body, contentLength } = {}, retried = false) {
    const token = await this.access();
    const u = new URL(url);
    const transport = u.protocol === "https:" ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = transport.request(u, {
        method, agent: agents[u.protocol], timeout: this.timeoutMs,
        headers: { ...headers, authorization: "Bearer " + token, ...(contentLength !== undefined ? { "content-length": contentLength } : {}) },
      }, resolve);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      if (Buffer.isBuffer(body)) req.end(body);
      else if (body) {
        body.on("error", (e) => req.destroy(e));
        req.on("error", () => body.destroy?.());
        body.pipe(req);
      } else req.end();
    });
    if (res.statusCode === 401 && !retried && (!body || Buffer.isBuffer(body))) {
      res.resume();
      await this.access(true);
      return this.raw(method, url, { headers, body, contentLength }, true);
    }
    return res;
  }

  // json sends a request whose answer is JSON, retrying the ones Google asks
  // to slow down for, and throws GoogleError with the status only.
  async json(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      const buf = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      let res;
      try {
        res = await this.raw(method, url, { body: buf, headers: buf ? { "content-type": "application/json; charset=UTF-8" } : {} });
      } catch (e) {
        if (e instanceof GoogleError) throw e;
        if (attempt < 2) { await sleep(500 * 2 ** attempt); continue; }
        throw new GoogleError(0);
      }
      const text = await readText(res);
      if (res.statusCode < 300) return text ? JSON.parse(text) : {};
      if (slowDown(res.statusCode, text) && attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
      throw new GoogleError(res.statusCode, slowDown(res.statusCode, text) ? "rate_limited" : "");
    }
  }

  about() { return this.json("GET", `${this.ep.api}/about?fields=${encodeURIComponent("user(emailAddress,permissionId),storageQuota(limit,usage)")}`); }

  // children yields what a folder holds, a page at a time.
  // children lists the oldest first, so two computers that each made a
  // folder of the same name both settle on the same one.
  async *children(parent, { folders = false, name } = {}) {
    let q = `'${esc(parent)}' in parents and trashed = false`;
    if (folders) q += ` and mimeType = '${FOLDER}'`;
    if (name !== undefined) q += ` and name = '${esc(name)}'`;
    let token = "";
    for (let pages = 0; pages < 100_000; pages++) {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: "1000", spaces: "drive", orderBy: "createdTime" });
      if (token) params.set("pageToken", token);
      const d = await this.json("GET", `${this.ep.api}/files?${params}`);
      for (const f of d.files || []) yield f;
      token = d.nextPageToken || "";
      if (!token) return;
    }
  }

  async find(parent, name, opts = {}) {
    const out = [];
    for await (const f of this.children(parent, { ...opts, name })) out.push(f);
    return out;
  }

  createFolder(parent, name) {
    return this.json("POST", `${this.ep.api}/files?fields=${FIELDS}`, { name, mimeType: FOLDER, parents: [parent] });
  }

  // startUpload opens a resumable upload and answers its session URL.
  async startUpload(parent, name, size) {
    const body = Buffer.from(JSON.stringify({ name, parents: [parent] }));
    const res = await this.raw("POST", `${this.ep.upload}/files?uploadType=resumable&fields=${FIELDS}`, {
      body, headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": "application/octet-stream", "x-upload-content-length": String(size) },
    });
    await readText(res);
    const location = res.headers.location;
    if (res.statusCode !== 200 || !location) throw new GoogleError(res.statusCode);
    const u = new URL(location);
    if (u.origin !== new URL(this.ep.upload).origin) throw new GoogleError(502, "upload_elsewhere");
    return location;
  }

  // upload streams the body to a session; it answers the stored file.
  async upload(session, body, size) {
    const res = await this.raw("PUT", session, { body, contentLength: size, headers: { "content-type": "application/octet-stream" } });
    const text = await readText(res);
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new GoogleError(res.statusCode);
    return JSON.parse(text);
  }

  download(id, range) {
    return this.raw("GET", `${this.ep.api}/files/${encodeURIComponent(id)}?alt=media`, { headers: range ? { range } : {} });
  }

  // remove deletes a file for good, waiting out Google's rate limits.
  async remove(id) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.raw("DELETE", `${this.ep.api}/files/${encodeURIComponent(id)}`);
      const text = await readText(res);
      if (res.statusCode === 204 || res.statusCode === 200 || res.statusCode === 404) return res.statusCode !== 404;
      if (slowDown(res.statusCode, text) && attempt < 4) { await sleep(800 * 2 ** attempt); continue; }
      throw new GoogleError(res.statusCode, slowDown(res.statusCode, text) ? "rate_limited" : "");
    }
  }
}

// slowDown reads Google asking to come back later: 429, a 5xx, or a 403
// whose reason is a rate limit (userRateLimitExceeded, rateLimitExceeded).
function slowDown(status, text) {
  return status === 429 || status >= 500 || (status === 403 && /ratelimitexceeded/i.test(text));
}

// A Drive query's string: backslash and quote escaped.
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readText(res, limit = 8 << 20) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    res.on("data", (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", () => resolve(""));
  });
}
