"use strict";
/*
 * China PO approval and FA tracker: web server.
 * Serves the tracker page, signs people in with their Work Sharp Microsoft account,
 * stores shared data in Postgres, and pushes live updates to every open browser.
 */
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const { Pool } = require("pg");
const msal = require("@azure/msal-node");

/* ---------- configuration ---------- */
const env = (k, fallback) => {
  const v = process.env[k];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    console.error("Missing required environment variable: " + k);
    process.exit(1);
  }
  return v;
};
const PORT = process.env.PORT || 3000;
const BASE_URL = env("BASE_URL").replace(/\/+$/, "");
const TENANT_ID = env("AZURE_TENANT_ID");
const CLIENT_ID = env("AZURE_CLIENT_ID");
const CLIENT_SECRET = env("AZURE_CLIENT_SECRET");
const SESSION_SECRET = env("SESSION_SECRET");
const DATABASE_URL = env("DATABASE_URL");
const ADMIN_EMAILS = env("ADMIN_EMAILS", "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const REDIRECT_URI = BASE_URL + "/auth/callback";
const SCOPES = ["openid", "profile", "email"];

/* ---------- database ---------- */
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Render's internal database address has no dots (for example "dpg-abc123-a") and needs no TLS.
  ssl: (() => { const h = new URL(DATABASE_URL).hostname; return (h === "localhost" || h === "127.0.0.1" || !h.includes(".")) ? false : { rejectUnauthorized: false }; })(),
  max: 10
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs (
      collection text NOT NULL,
      id         text NOT NULL,
      data       jsonb NOT NULL,
      version    integer NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      PRIMARY KEY (collection, id)
    );
    CREATE TABLE IF NOT EXISTS users (
      id        text PRIMARY KEY,
      name      text,
      email     text,
      last_seen timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/* Only these collections exist in the tracker. Paths are always "collection/docId". */
const COLLECTIONS = new Set(["config", "plan", "approvals", "fa", "comments", "chat"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC_BYTES = 400 * 1024;

function parseDocPath(p) {
  const parts = String(p || "").split("/");
  if (parts.length !== 2) return null;
  const [collection, id] = parts;
  if (!COLLECTIONS.has(collection) || !ID_RE.test(id)) return null;
  return { collection, id };
}
function isPlainObject(v) { return v && typeof v === "object" && !Array.isArray(v); }
function newId() { return crypto.randomBytes(15).toString("base64url").replace(/[-_]/g, "").slice(0, 20).toLowerCase(); }

/* ---------- live updates (Server-Sent Events) ---------- */
const clients = new Set();
function broadcast(evt) {
  const line = "data: " + JSON.stringify(evt) + "\n\n";
  for (const res of clients) { try { res.write(line); } catch (e) { /* closed */ } }
}
setInterval(() => { for (const res of clients) { try { res.write(": ping\n\n"); } catch (e) {} } }, 25000);

/* ---------- auth ---------- */
const cca = new msal.ConfidentialClientApplication({
  auth: { clientId: CLIENT_ID, authority: "https://login.microsoftonline.com/" + TENANT_ID, clientSecret: CLIENT_SECRET }
});

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(session({
  store: new PgSession({ pool, tableName: "sessions", createTableIfMissing: true }),
  name: "cpt.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, secure: BASE_URL.startsWith("https://"), sameSite: "lax", maxAge: 14 * 24 * 3600 * 1000 }
}));

app.get("/healthz", (req, res) => res.type("text").send("ok"));

/* Always use the main web address (BASE_URL), so sign-in and saving work the same for everyone. */
const BASE_HOST = new URL(BASE_URL).host;
app.use((req, res, next) => {
  if (req.get("host") === BASE_HOST || /^localhost(:\d+)?$/.test(req.get("host") || "")) return next();
  res.redirect(301, BASE_URL + req.originalUrl);
});

app.get("/auth/login", async (req, res, next) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    req.session.authState = state;
    const url = await cca.getAuthCodeUrl({ scopes: SCOPES, redirectUri: REDIRECT_URI, state, prompt: "select_account" });
    req.session.save(() => res.redirect(url));
  } catch (e) { next(e); }
});

app.get("/auth/callback", async (req, res, next) => {
  try {
    if (req.query.error) return res.status(400).type("text").send("Sign-in was cancelled or failed: " + String(req.query.error_description || req.query.error).slice(0, 300) + "\n\nGo back to " + BASE_URL + " to try again.");
    if (!req.query.state || req.query.state !== req.session.authState) return res.redirect("/auth/login");
    const result = await cca.acquireTokenByCode({ code: String(req.query.code || ""), scopes: SCOPES, redirectUri: REDIRECT_URI });
    const c = result.idTokenClaims || {};
    if (c.tid !== TENANT_ID) return res.status(403).type("text").send("This account is not part of the Work Sharp organization.");
    const user = { id: c.oid, name: c.name || c.preferred_username || "Team member", email: (c.preferred_username || c.email || "").toLowerCase() };
    await pool.query(
      `INSERT INTO users (id, name, email, last_seen) VALUES ($1,$2,$3,now())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, last_seen=now()`,
      [user.id, user.name, user.email]
    );
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.user = user;
      req.session.save(() => res.redirect("/"));
    });
  } catch (e) { next(e); }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("cpt.sid");
    res.redirect("https://login.microsoftonline.com/" + TENANT_ID + "/oauth2/v2.0/logout?post_logout_redirect_uri=" + encodeURIComponent(BASE_URL));
  });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/admin/")) return res.status(401).json({ error: "Sign in required", code: "unauthenticated" });
  return res.redirect("/auth/login");
}
function isAdmin(req) { return ADMIN_EMAILS.includes(String(req.session.user.email || "").toLowerCase()); }

/* Block cross-site writes: state-changing requests must come from our own pages. */
function sameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin") || req.get("referer") || "";
  if (origin && !origin.startsWith(BASE_URL)) return res.status(403).json({ error: "Cross-site request blocked", code: "permission_denied" });
  next();
}

app.use(requireAuth);
app.use(sameOrigin);

/* ---------- static files ---------- */
app.get("/vendor/xlsx.full.min.js", (req, res) => {
  res.set("Cache-Control", "public, max-age=604800");
  res.sendFile(require.resolve("xlsx/dist/xlsx.full.min.js"));
});
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "5m" }));

/* ---------- API ---------- */
const api = express.Router();
api.use(express.json({ limit: "2mb" }));

api.get("/me", (req, res) => res.json({ ...req.session.user, admin: isAdmin(req) }));

api.get("/users", async (req, res, next) => {
  try {
    const ids = String(req.query.ids || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json({});
    const { rows } = await pool.query("SELECT id, name FROM users WHERE id = ANY($1)", [ids]);
    const out = {}; rows.forEach(r => { out[r.id] = { name: r.name || "" }; });
    res.json(out);
  } catch (e) { next(e); }
});

api.get("/users/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 60);
    if (!q) return res.json([]);
    const { rows } = await pool.query(
      "SELECT id, name FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 8",
      ["%" + q.replace(/[%_\\]/g, "\\$&") + "%"]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

api.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

api.get("/doc", async (req, res, next) => {
  try {
    const p = parseDocPath(req.query.path);
    if (!p) return res.status(400).json({ error: "Bad path", code: "invalid_argument" });
    const { rows } = await pool.query("SELECT data, version FROM docs WHERE collection=$1 AND id=$2", [p.collection, p.id]);
    res.json(rows.length ? { exists: true, data: rows[0].data, version: rows[0].version } : { exists: false });
  } catch (e) { next(e); }
});

api.get("/collection", async (req, res, next) => {
  try {
    const collection = String(req.query.path || "");
    if (!COLLECTIONS.has(collection)) return res.status(400).json({ error: "Bad collection", code: "invalid_argument" });
    const field = String(req.query.order || "");
    const dir = req.query.dir === "desc" ? "DESC" : "ASC";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5000, 1), 5000);
    let sql = "SELECT id, data FROM docs WHERE collection=$1";
    const args = [collection];
    if (field && /^[A-Za-z0-9_]{1,40}$/.test(field)) { sql += " ORDER BY data->$2 " + dir + " NULLS LAST, id"; args.push(field); }
    else sql += " ORDER BY id";
    sql += " LIMIT " + limit;
    const { rows } = await pool.query(sql, args);
    res.json(rows.map(r => ({ id: r.id, data: r.data })));
  } catch (e) { next(e); }
});

/* Server-side rules so the tracker can't be bypassed from the browser. */
async function checkWrite(req, p, data, existing) {
  const me = req.session.user;
  if (p.collection === "approvals") {
    const { rows } = await pool.query("SELECT data FROM docs WHERE collection='config' AND id='settings'");
    const st = rows.length ? rows[0].data : {};
    for (const slot of ["a", "b"]) {
      if (data[slot] === undefined) continue;
      const assigned = slot === "a" ? st.idA : st.idB;
      if (assigned && assigned !== me.id) {
        const label = slot === "a" ? (st.nameA || "Approver 1") : (st.nameB || "Approver 2");
        return "Only " + label + " can approve or reject in that column.";
      }
      if (isPlainObject(data[slot]) && data[slot].s) data[slot].by = me.id;
    }
    if (isPlainObject(data.ordered) && data.ordered.at) data.ordered.by = me.id;
  }
  if (p.collection === "comments" || p.collection === "chat") {
    if (existing && existing.by && existing.by !== me.id && !isAdmin(req)) return "You can only change your own messages.";
    data.by = me.id;
  }
  if (p.collection === "fa" || p.collection === "config") data.by = me.id;
  return null;
}

async function writeDoc(req, res, mode) {
  const p = parseDocPath(req.body && req.body.path);
  const data = req.body && req.body.data;
  if (!p || !isPlainObject(data)) return res.status(400).json({ error: "Bad request", code: "invalid_argument" });
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_DOC_BYTES) return res.status(413).json({ error: "Document too large", code: "quota_exceeded" });
  const { rows } = await pool.query("SELECT data FROM docs WHERE collection=$1 AND id=$2", [p.collection, p.id]);
  const existing = rows.length ? rows[0].data : null;
  if (mode === "update" && !existing) return res.status(404).json({ error: "Not found", code: "not_found" });
  const problem = await checkWrite(req, p, data, existing);
  if (problem) return res.status(403).json({ error: problem, code: "permission_denied" });
  const merged = mode === "update" ? { ...existing, ...data } : data;
  const r = await pool.query(
    `INSERT INTO docs (collection, id, data, version, updated_at, updated_by) VALUES ($1,$2,$3,1,now(),$4)
     ON CONFLICT (collection, id) DO UPDATE SET data=EXCLUDED.data, version=docs.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING version`,
    [p.collection, p.id, merged, req.session.user.id]
  );
  broadcast({ path: p.collection + "/" + p.id, collection: p.collection });
  res.json({ ok: true, version: r.rows[0].version });
}

api.put("/doc", (req, res, next) => writeDoc(req, res, "set").catch(next));
api.patch("/doc", (req, res, next) => writeDoc(req, res, "update").catch(next));

api.post("/collection", async (req, res, next) => {
  try {
    const collection = String(req.body && req.body.path || "");
    const data = req.body && req.body.data;
    if (!COLLECTIONS.has(collection) || !isPlainObject(data)) return res.status(400).json({ error: "Bad request", code: "invalid_argument" });
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_DOC_BYTES) return res.status(413).json({ error: "Document too large", code: "quota_exceeded" });
    const id = newId();
    const problem = await checkWrite(req, { collection, id }, data, null);
    if (problem) return res.status(403).json({ error: problem, code: "permission_denied" });
    await pool.query("INSERT INTO docs (collection, id, data, updated_by) VALUES ($1,$2,$3,$4)", [collection, id, data, req.session.user.id]);
    broadcast({ path: collection + "/" + id, collection });
    res.json({ ok: true, id });
  } catch (e) { next(e); }
});

api.delete("/doc", async (req, res, next) => {
  try {
    const p = parseDocPath(req.query.path);
    if (!p) return res.status(400).json({ error: "Bad path", code: "invalid_argument" });
    const { rows } = await pool.query("SELECT data FROM docs WHERE collection=$1 AND id=$2", [p.collection, p.id]);
    if (!rows.length) return res.json({ ok: true });
    const d = rows[0].data;
    if ((p.collection === "comments" || p.collection === "chat") && d.by && d.by !== req.session.user.id && !isAdmin(req)) {
      return res.status(403).json({ error: "You can only delete your own messages.", code: "permission_denied" });
    }
    await pool.query("DELETE FROM docs WHERE collection=$1 AND id=$2", [p.collection, p.id]);
    broadcast({ path: p.collection + "/" + p.id, collection: p.collection });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use("/api", api);

/* ---------- one-time data import (admins only) ---------- */
app.get("/admin/import", (req, res) => {
  if (!isAdmin(req)) return res.status(403).type("text").send("Admins only. Add your email to ADMIN_EMAILS in Render.");
  res.sendFile(path.join(__dirname, "public", "admin-import.html"));
});
app.post("/admin/import", express.json({ limit: "20mb" }), async (req, res, next) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Admins only", code: "permission_denied" });
  const docs = req.body && Array.isArray(req.body.docs) ? req.body.docs : null;
  if (!docs) return res.status(400).json({ error: "File has no docs list", code: "invalid_argument" });
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query("BEGIN");
    for (const d of docs) {
      if (!d || !COLLECTIONS.has(d.collection) || !ID_RE.test(String(d.id)) || !isPlainObject(d.data)) continue;
      await client.query(
        `INSERT INTO docs (collection, id, data, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (collection, id) DO UPDATE SET data=EXCLUDED.data, version=docs.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [d.collection, String(d.id), d.data, req.session.user.id]
      );
      n++;
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); client.release(); return next(e); }
  client.release();
  for (const c of COLLECTIONS) broadcast({ path: c + "/*", collection: c });
  res.json({ ok: true, imported: n });
});

/* ---------- errors ---------- */
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  if (req.path.startsWith("/api/") || req.path.startsWith("/admin/")) return res.status(500).json({ error: "Server error", code: "internal" });
  res.status(500).type("text").send("Something went wrong. Please reload the page.");
});

migrate()
  .then(() => app.listen(PORT, () => console.log("China PO tracker listening on " + PORT)))
  .catch(e => { console.error("Database setup failed", e); process.exit(1); });
