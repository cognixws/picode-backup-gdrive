// A stand-in for Google's OAuth token endpoint and the subset of Drive v3
// this storage calls: folders, queries by parent/name/type with pages,
// resumable uploads (an interrupted one keeps nothing), ranged downloads,
// deletes, and about. Opts make it misbehave the ways real servers do.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

export function fakeGoogle({ pageSize = 1000, checksum = true, ignoreRange = false, expireTokens = false, rateLimitDeletes = 0 } = {}) {
  const files = new Map(); // id → { id, name, parent, mimeType, body }
  const sessions = new Map();
  const tokens = new Set();
  const seen = { tokenRequests: 0, requests: 0, rateLimited: 0, refreshTokens: ["good"] };
  const json = (res, code, v) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
  const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, ...(f.mimeType === "folder" ? {} : { size: String(f.body.length), ...(checksum ? { sha256Checksum: createHash("sha256").update(f.body).digest("hex") } : {}) }) });
  const readBody = (req) => new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); req.on("aborted", () => resolve(null)); req.on("error", () => resolve(null)); });
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      seen.requests++;
      const url = new URL(req.url, "http://g");
      const base = `http://127.0.0.1:${server.address().port}`;
      if (url.pathname === "/token" && req.method === "POST") {
        seen.tokenRequests++;
        const f = new URLSearchParams((await readBody(req)).toString());
        if (f.get("grant_type") === "authorization_code") {
          if (f.get("code") !== "the-code") return json(res, 400, { error: "invalid_grant" });
          const t = "acc-" + randomBytes(6).toString("hex"); tokens.add(t);
          return json(res, 200, { access_token: t, refresh_token: "good", expires_in: 3600, scope: "https://www.googleapis.com/auth/drive.file" });
        }
        if (!seen.refreshTokens.includes(f.get("refresh_token"))) return json(res, 400, { error: "invalid_grant", error_description: "SECRET-GOOGLE-WORDS" });
        const t = "acc-" + randomBytes(6).toString("hex"); tokens.add(t);
        return json(res, 200, { access_token: t, expires_in: 3600 });
      }
      if (url.pathname === "/revoke") return json(res, 200, {});
      // A resumable session's URL is its own credential, as at Google.
      if (url.pathname === "/upload/drive/v3/files" && req.method === "PUT") {
        const s = sessions.get(url.searchParams.get("upload_id"));
        if (!s) return json(res, 404, {});
        const body = await readBody(req);
        if (!body || body.length !== s.size) return; // an interrupted upload keeps nothing
        sessions.delete(url.searchParams.get("upload_id"));
        const f = { id: "f" + randomBytes(6).toString("hex"), name: s.name, parent: s.parent, mimeType: "file", body };
        files.set(f.id, f);
        return json(res, 200, meta(f));
      }
      const tok = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
      if (!tokens.has(tok)) return json(res, 401, { error: { message: "SECRET-GOOGLE-WORDS" } });
      if (expireTokens) tokens.delete(tok); // every token works once: the client must refresh on 401
      if (url.pathname === "/drive/v3/about") return json(res, 200, { user: { emailAddress: "person@example.com", permissionId: "perm-1" }, storageQuota: { limit: "16106127360", usage: "1073741824" } });
      if (url.pathname === "/drive/v3/files" && req.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const parent = /'([^']*)' in parents/.exec(q)?.[1];
        const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
        const folders = q.includes("mimeType = 'application/vnd.google-apps.folder'");
        const all = [...files.values()].filter((f) => f.parent === parent && (name === undefined || f.name === name) && (!folders || f.mimeType === "folder"));
        const at = Number(url.searchParams.get("pageToken") || 0);
        const page = all.slice(at, at + pageSize).map((f) => ({ ...meta(f), mimeType: f.mimeType === "folder" ? "application/vnd.google-apps.folder" : "application/octet-stream" }));
        return json(res, 200, { files: page, ...(at + pageSize < all.length ? { nextPageToken: String(at + pageSize) } : {}) });
      }
      if (url.pathname === "/drive/v3/files" && req.method === "POST") {
        const m = JSON.parse((await readBody(req)).toString());
        const f = { id: "f" + randomBytes(6).toString("hex"), name: m.name, parent: m.parents[0], mimeType: "folder", body: Buffer.alloc(0) };
        files.set(f.id, f);
        return json(res, 200, { ...meta(f), mimeType: "application/vnd.google-apps.folder" });
      }
      if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
        const m = JSON.parse((await readBody(req)).toString());
        if (!files.has(m.parents[0])) return json(res, 404, { error: { message: "SECRET-GOOGLE-WORDS" } });
        const id = randomBytes(8).toString("hex");
        sessions.set(id, { name: m.name, parent: m.parents[0], size: Number(req.headers["x-upload-content-length"]) });
        res.writeHead(200, { Location: `${base}/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` });
        return res.end();
      }
      const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (fm) {
        const f = files.get(decodeURIComponent(fm[1]));
        if (!f) return json(res, 404, { error: { message: "SECRET-GOOGLE-WORDS" } });
        if (req.method === "DELETE") {
          if (seen.rateLimited < rateLimitDeletes) { seen.rateLimited++; return json(res, 403, { error: { errors: [{ reason: "userRateLimitExceeded" }], message: "SECRET-GOOGLE-WORDS" } }); }
          files.delete(f.id); res.writeHead(204); return res.end();
        }
        if (req.method === "GET" && url.searchParams.get("alt") === "media") {
          const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
          if (!r || ignoreRange) { res.writeHead(200, { "Content-Length": f.body.length }); return res.end(f.body); }
          const start = Number(r[1]), end = r[2] === "" ? f.body.length - 1 : Math.min(Number(r[2]), f.body.length - 1);
          if (start >= f.body.length) { res.writeHead(416, { "Content-Range": "bytes */" + f.body.length }); return res.end(); }
          res.writeHead(206, { "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${f.body.length}` });
          return res.end(f.body.subarray(start, end + 1));
        }
      }
      json(res, 404, {});
    }).listen(0, "127.0.0.1", () => { server.seen = seen; server.files = files; server.base = `http://127.0.0.1:${server.address().port}`; resolve(server); });
  });
}
