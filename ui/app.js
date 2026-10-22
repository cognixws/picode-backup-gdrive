// The extension's page: whether COGNIX[WS] is signed in to Google Drive,
// and the one action that changes it. Tokens and Google calls stay in the
// process; the page talks to it through the host bridge and opens Google's
// sign-in through the links door.
(async function () {
  const root = document.getElementById("root");
  const processDoor = await picode.use("process"), links = await picode.use("links");
  let state = null, busy = "", error = "", confirmOut = false, poll = 0;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const button = (label, action, cls = "") => `<button type="button" class="${cls}" data-action="${action}" ${busy ? "disabled" : ""}>${label}</button>`;
  const gb = (n) => n >= 1e12 ? (n / 1e12).toFixed(1) + " TB" : (n / 1e9).toFixed(1) + " GB";
  async function request(path, method = "GET") {
    if (!processDoor) throw new Error("The extension is off or its process is not running.");
    const r = await processDoor.request(path, { method, body: method === "POST" ? {} : undefined });
    let d; try { d = JSON.parse(r.body); } catch { throw new Error("The extension returned an unreadable answer."); }
    if (r.status >= 400) throw new Error("That did not work. Try again.");
    return d;
  }
  async function load() {
    try { state = await request("/state"); error = ""; } catch (e) { error = e.message; }
    root.setAttribute("aria-busy", "false");
    render();
    clearTimeout(poll);
    if (state?.signingIn) poll = setTimeout(load, 2500); // the sign-in finishes in the browser
  }
  function body() {
    if (!state) return error ? `<div class="notice error" role="alert"><span>${esc(error)}</span>${button("Try again", "reload")}</div>` : "";
    if (state.signingIn || (busy === "connect" && !state.signedIn)) return `<div class="notice is-busy" role="status"><span>Finish signing in to Google in your browser…</span>${button("Open the sign-in again", "connect")}</div>`;
    if (state.needsSignIn) return `<div class="notice warn" role="alert"><span>Google no longer accepts this sign-in. Copies wait until you sign in again.</span>${button("Sign in again", "connect", "primary")}</div>`;
    if (!state.signedIn) return `<div class="notice"><span>Sign in with Google to keep encrypted copies of your backups in your Drive.</span>${button("Sign in with Google", "connect", "primary")}</div>`;
    const space = state.total ? `${gb(state.used || 0)} used of ${gb(state.total)}` : state.used ? `${gb(state.used)} used` : "";
    return `<section class="panel" aria-label="Google Drive">
      <p class="ok">Signed in${state.account ? " · " + esc(state.account.replace(/^My Drive · /, "")) : ""}</p>
      <dl class="facts">
        <dt>Folder</dt><dd>COGNIX[WS] backups, in My Drive</dd>
        ${space ? `<dt>Space</dt><dd>${esc(space)}</dd>` : ""}
      </dl>
      ${state.problem === "retry" ? `<div class="notice warn" role="status"><span>Google Drive did not answer just now; copies retry on their own.</span></div>` : ""}
      <div class="row">${confirmOut ? `<span>Sign out? Copies stop; what is in your Drive stays.</span>${button("Sign out", "out-yes", "danger")}${button("Cancel", "out-no")}` : button("Sign out", "out")}</div>
      <p class="muted">Add a destination in Backups → Destinations to start copying. COGNIX[WS] sees only the files it created in your Drive.</p>
    </section>`;
  }
  function render() {
    root.innerHTML = `<header><h1>Google Drive</h1><p class="muted">Encrypted copies of your backups, in your own Drive.</p></header>${body()}${error && state ? `<p class="notice error" role="alert">${esc(error)}</p>` : ""}`;
  }
  async function act(name) {
    error = "";
    try {
      if (name === "reload") return load();
      if (name === "out") { confirmOut = true; return render(); }
      if (name === "out-no") { confirmOut = false; return render(); }
      busy = name; render();
      // Opening the browser is fire-and-forget: the sign-in finishes there,
      // and /state polling follows it.
      if (name === "connect") { const r = await request("/connect", "POST"); void Promise.resolve(links.open(r.url)).catch(() => {}); }
      else if (name === "out-yes") { confirmOut = false; await request("/disconnect", "POST"); }
    } catch (e) { error = e.message; }
    busy = "";
    await load();
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("button[data-action]"); if (b) { e.preventDefault(); void act(b.dataset.action); } });
  await load();
})();
