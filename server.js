"use strict";
/*
 * China PO approval and FA tracker: web server.
 * Serves the tracker page, signs people in with their own username and password,
 * stores shared data in Postgres, and pushes live updates to every open browser.
 */
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const { Pool } = require("pg");

const scrypt = promisify(crypto.scrypt);

/* ---------- configuration ---------- */
const PORT = process.env.PORT || 3000;
function originOf(u) { try { const x = new URL(String(u || "").trim()); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch (e) { return null; } }
/* BASE_URL is the address people use. If it is missing or not a web address yet,
   fall back to the address Render gives the service, so the site still starts. */
const BASE_URL = originOf(process.env.BASE_URL) || originOf(process.env.RENDER_EXTERNAL_URL) || ("http://localhost:" + PORT);
if (!originOf(process.env.BASE_URL)) console.warn("BASE_URL is missing or not a web address. Using " + BASE_URL + " for now.");
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!SESSION_SECRET || !DATABASE_URL) { console.error("SESSION_SECRET and DATABASE_URL must be set."); process.exit(1); }
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "").replace(/^[\s"']+|[\s"']+$/g, "").toLowerCase();
// Trim: values pasted into Render's settings boxes can pick up a stray space or line break.
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").replace(/^[\s"']+|[\s"']+$/g, "");
const MIN_PASSWORD = 10;

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
      last_seen timestamptz
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS username      text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change   boolean NOT NULL DEFAULT true;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS active        boolean NOT NULL DEFAULT true;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin      boolean NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_count  integer NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until  timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at    timestamptz NOT NULL DEFAULT now();
    ALTER TABLE users ALTER COLUMN last_seen DROP DEFAULT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username);
  `);
  await bootstrapAdmin();
}

/* ---------- passwords ---------- */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return "scrypt$16384$8$1$" + salt.toString("base64") + "$" + key.toString("base64");
}
const DUMMY_HASH = "scrypt$16384$8$1$" + Buffer.alloc(16).toString("base64") + "$" + Buffer.alloc(64).toString("base64");
async function checkPassword(pw, stored) {
  const parts = String(stored || DUMMY_HASH).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const got = await scrypt(String(pw), Buffer.from(saltB64, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got) && !!stored;
}
function tempPassword() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i++) out += abc[bytes[i] % abc.length];
  return out.slice(0, 4) + "-" + out.slice(4, 9) + "-" + out.slice(9);
}
function passwordProblem(pw, username) {
  pw = String(pw || "");
  if (pw.length < MIN_PASSWORD) return "Use at least " + MIN_PASSWORD + " characters.";
  if (pw.length > 200) return "That password is too long.";
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return "Don't include your username in your password.";
  if (/^(.)\1+$/.test(pw) || /^(password|worksharp|12345)/i.test(pw)) return "That password is too easy to guess.";
  return null;
}
const USERNAME_RE = /^[a-z0-9._-]{2,40}$/;

async function bootstrapAdmin() {
  const forceReset = /^\W*yes\W*$/i.test(String(process.env.ADMIN_RESET || ""));
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE is_admin AND active AND password_hash IS NOT NULL");
  const { rows: admins } = await pool.query("SELECT username FROM users WHERE is_admin AND active ORDER BY created_at");
  console.log("Admin check: existing admin usernames = [" + admins.map(a => a.username).join(", ") + "]; ADMIN_USERNAME = '" + ADMIN_USERNAME + "'; ADMIN_PASSWORD length = " + ADMIN_PASSWORD.length + "; ADMIN_RESET = " + (forceReset ? "yes" : "no"));
  if (rows[0].n > 0 && !forceReset) return;
  if (forceReset) console.warn("ADMIN_RESET=yes: resetting the admin account from ADMIN_USERNAME and ADMIN_PASSWORD. Remove ADMIN_RESET afterwards.");
  if (!USERNAME_RE.test(ADMIN_USERNAME) || ADMIN_PASSWORD.length < MIN_PASSWORD) {
    console.warn("No admin account yet. Set ADMIN_USERNAME and ADMIN_PASSWORD (at least " + MIN_PASSWORD + " characters) in Render, then redeploy.");
    return;
  }
  const hash = await hashPassword(ADMIN_PASSWORD);
  await pool.query(
    `INSERT INTO users (id, name, username, password_hash, must_change, active, is_admin)
     VALUES ($1,$2,$3,$4,true,true,true)
     ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, must_change=true, active=true, is_admin=true, failed_count=0, locked_until=NULL`,
    [crypto.randomUUID(), ADMIN_USERNAME, ADMIN_USERNAME, hash]
  );
  console.log("Created admin account '" + ADMIN_USERNAME + "'. Sign in and change the password.");
}

/* ---------- page helpers ---------- */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function page(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(title) + '</title><link rel="stylesheet" href="/auth.css"></head><body><main class="auth">' + body + '</main></body></html>';
}
function loginPage(msg, username) {
  return page("Sign in | China PO tracker",
    '<h1>China PO tracker</h1><p class="sub">Sign in with the username and password you were given.</p>' +
    (msg ? '<p class="msg">' + esc(msg) + '</p>' : '') +
    '<form method="post" action="/login" autocomplete="on">' +
    '<label for="u">Username</label><input id="u" name="username" autocomplete="username" required maxlength="40" value="' + esc(username || "") + '" autofocus>' +
    '<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required maxlength="200">' +
    '<button type="submit">Sign in</button></form>' +
    '<p class="foot">Forgot your password? Ask the tracker admin to reset it.</p>');
}
function changePage(msg, forced) {
  return page("Change password | China PO tracker",
    '<h1>' + (forced ? "Choose your own password" : "Change password") + '</h1>' +
    '<p class="sub">' + (forced ? "Before you start, replace the temporary password with one only you know. " : "") + 'Use at least ' + MIN_PASSWORD + ' characters. A short phrase works well.</p>' +
    (msg ? '<p class="msg">' + esc(msg) + '</p>' : '') +
    '<form method="post" action="/account/password">' +
    '<label for="c">Current password</label><input id="c" name="current" type="password" autocomplete="current-password" required maxlength="200">' +
    '<label for="n">New password</label><input id="n" name="next" type="password" autocomplete="new-password" required minlength="' + MIN_PASSWORD + '" maxlength="200">' +
    '<label for="n2">New password again</label><input id="n2" name="next2" type="password" autocomplete="new-password" required minlength="' + MIN_PASSWORD + '" maxlength="200">' +
    '<button type="submit">Save password</button></form>' +
    (forced ? '' : '<p class="foot"><a href="/">Back to the tracker</a></p>'));
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

/* ---------- app and sessions ---------- */
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
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  // "same-origin" lets browsers tell our own forms apart from other sites when signing in.
  referrerPolicy: { policy: "same-origin" }
}));

app.get("/healthz", (req, res) => res.type("text").send("ok"));

/* Always use the main web address (BASE_URL), so sign-in and saving work the same for everyone. */
const BASE_HOST = new URL(BASE_URL).host;
app.use((req, res, next) => {
  if (req.get("host") === BASE_HOST || /^localhost(:\d+)?$/.test(req.get("host") || "")) return next();
  res.redirect(301, BASE_URL + req.originalUrl);
});

app.use(session({
  store: new PgSession({ pool, tableName: "sessions", createTableIfMissing: true }),
  name: "cpt.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, secure: BASE_URL.startsWith("https://"), sameSite: "lax", maxAge: 14 * 24 * 3600 * 1000 }
}));

/* Block cross-site form posts and API writes: they must come from our own pages. */
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const site = req.get("sec-fetch-site");
  if (site) {
    if (site === "same-origin" || site === "none") return next();
    return blocked(req, res);
  }
  const origin = req.get("origin");
  const referer = req.get("referer");
  if (origin && origin !== "null") return origin === BASE_URL || origin === "https://" + req.get("host") ? next() : blocked(req, res);
  if (referer) return referer.startsWith(BASE_URL + "/") || referer === BASE_URL ? next() : blocked(req, res);
  next();
});
function blocked(req, res) {
  if (req.path === "/login" || req.path === "/account/password") return res.status(403).type("text").send("This form was sent from another website, so it was blocked. Open " + BASE_URL + " and try again.");
  return res.status(403).json({ error: "Cross-site request blocked", code: "permission_denied" });
}

app.get("/auth.css", (req, res) => res.sendFile(path.join(__dirname, "public", "auth.css")));

/* ---------- sign in ---------- */
const ipHits = new Map();
function tooManyFromIp(ip) {
  const now = Date.now(), rec = ipHits.get(ip);
  if (!rec || rec.reset < now) { ipHits.set(ip, { n: 1, reset: now + 15 * 60 * 1000 }); return false; }
  rec.n++;
  return rec.n > 20;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of ipHits) if (v.reset < now) ipHits.delete(k); }, 10 * 60 * 1000);

const form = express.urlencoded({ extended: false, limit: "10kb" });

app.get("/login", (req, res) => {
  if (req.session.uid) return res.redirect("/");
  res.type("html").send(loginPage(""));
});

app.post("/login", form, async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase().slice(0, 40);
    const password = String(req.body.password || "").slice(0, 200);
    const generic = "That username and password don't match. Check them and try again.";
    if (tooManyFromIp(req.ip)) return res.status(429).type("html").send(loginPage("Too many sign-in attempts. Wait 15 minutes and try again.", username));
    const { rows } = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    const u = rows[0];
    if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
      await checkPassword(password, null);
      return res.status(429).type("html").send(loginPage("This account is paused for 15 minutes after several wrong passwords. Try again later or ask the admin to reset it.", username));
    }
    const ok = await checkPassword(password, u && u.active ? u.password_hash : null);
    if (!u || !u.active || !ok) {
      console.warn("Sign-in failed for '" + username + "': " + (!u ? "no such username" : !u.active ? "account is turned off" : "wrong password"));
      if (u) {
        const n = (u.failed_count || 0) + 1;
        await pool.query("UPDATE users SET failed_count=$2, locked_until=$3 WHERE id=$1",
          [u.id, n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null]);
      }
      return res.status(401).type("html").send(loginPage(generic, username));
    }
    await pool.query("UPDATE users SET failed_count=0, locked_until=NULL, last_seen=now() WHERE id=$1", [u.id]);
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.uid = u.id;
      req.session.save(() => res.redirect(u.must_change ? "/account/password" : "/"));
    });
  } catch (e) { next(e); }
});

function signOut(req, res) {
  req.session.destroy(() => { res.clearCookie("cpt.sid"); res.redirect("/login"); });
}
app.get("/logout", signOut);
app.post("/logout", signOut);

/* ---------- every other page needs a signed-in, active person ---------- */
const userCache = new Map();
async function loadUser(id) {
  const hit = userCache.get(id);
  if (hit && hit.t > Date.now() - 20000) return hit.u;
  const { rows } = await pool.query("SELECT id, name, username, active, is_admin, must_change, password_hash FROM users WHERE id=$1", [id]);
  const u = rows[0] || null;
  userCache.set(id, { u, t: Date.now() });
  return u;
}
function forgetUser(id) { userCache.delete(id); }

app.use(async (req, res, next) => {
  try {
    const wantsJson = req.path.startsWith("/api/") || req.path.startsWith("/admin/api/");
    const u = req.session.uid ? await loadUser(req.session.uid) : null;
    if (!u || !u.active) {
      if (req.session.uid) req.session.uid = null;
      return wantsJson ? res.status(401).json({ error: "Sign in required", code: "unauthenticated" }) : res.redirect("/login");
    }
    req.user = u;
    const allowed = req.path === "/account/password";
    if (u.must_change && !allowed) {
      return wantsJson ? res.status(403).json({ error: "Choose a new password first", code: "password_change_required" }) : res.redirect("/account/password");
    }
    next();
  } catch (e) { next(e); }
});
function isAdmin(req) { return !!(req.user && req.user.is_admin); }

app.get("/account/password", (req, res) => res.type("html").send(changePage("", req.user.must_change)));
app.post("/account/password", form, async (req, res, next) => {
  try {
    const forced = req.user.must_change;
    const ok = await checkPassword(String(req.body.current || ""), req.user.password_hash);
    if (!ok) return res.status(400).type("html").send(changePage("Your current password isn't right.", forced));
    if (String(req.body.next) !== String(req.body.next2)) return res.status(400).type("html").send(changePage("The two new passwords don't match.", forced));
    const problem = passwordProblem(req.body.next, req.user.username);
    if (problem) return res.status(400).type("html").send(changePage(problem, forced));
    if (await checkPassword(String(req.body.next), req.user.password_hash)) return res.status(400).type("html").send(changePage("Pick a password different from the current one.", forced));
    await pool.query("UPDATE users SET password_hash=$2, must_change=false WHERE id=$1", [req.user.id, await hashPassword(String(req.body.next))]);
    forgetUser(req.user.id);
    res.redirect("/");
  } catch (e) { next(e); }
});

/* ---------- admin: manage people ---------- */
app.get("/admin/users", (req, res) => {
  if (!isAdmin(req)) return res.status(403).type("text").send("Admins only.");
  res.sendFile(path.join(__dirname, "views", "admin-users.html"));
});
app.get("/admin/users.js", (req, res) => {
  if (!isAdmin(req)) return res.status(403).type("text").send("Admins only.");
  res.sendFile(path.join(__dirname, "views", "admin-users.js"));
});
const adminApi = express.Router();
adminApi.use(express.json({ limit: "20kb" }));
adminApi.use((req, res, next) => isAdmin(req) ? next() : res.status(403).json({ error: "Admins only", code: "permission_denied" }));

adminApi.get("/users", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT id, name, username, active, is_admin, must_change, last_seen, created_at, (locked_until > now()) AS locked FROM users WHERE username IS NOT NULL ORDER BY active DESC, lower(name)");
    res.json({ me: req.user.id, users: rows });
  } catch (e) { next(e); }
});
adminApi.post("/users", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 80);
    const username = String(req.body.username || "").trim().toLowerCase();
    if (!name) return res.status(400).json({ error: "Enter the person's name." });
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Usernames use 2 to 40 lowercase letters, numbers, dots, dashes or underscores." });
    const temp = tempPassword();
    try {
      await pool.query("INSERT INTO users (id, name, username, password_hash, must_change, active, is_admin) VALUES ($1,$2,$3,$4,true,true,$5)",
        [crypto.randomUUID(), name, username, await hashPassword(temp), !!req.body.admin]);
    } catch (e) {
      if (e.code === "23505") return res.status(400).json({ error: "That username is already taken." });
      throw e;
    }
    res.json({ ok: true, username, tempPassword: temp });
  } catch (e) { next(e); }
});
adminApi.post("/users/:id/reset", async (req, res, next) => {
  try {
    const temp = tempPassword();
    const r = await pool.query("UPDATE users SET password_hash=$2, must_change=true, failed_count=0, locked_until=NULL WHERE id=$1 RETURNING username", [req.params.id, await hashPassword(temp)]);
    if (!r.rowCount) return res.status(404).json({ error: "Not found" });
    forgetUser(req.params.id);
    await pool.query("DELETE FROM sessions WHERE sess->>'uid' = $1", [req.params.id]).catch(() => {});
    res.json({ ok: true, username: r.rows[0].username, tempPassword: temp });
  } catch (e) { next(e); }
});
adminApi.post("/users/:id/update", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (id === req.user.id && (req.body.active === false || req.body.admin === false)) return res.status(400).json({ error: "You can't turn off your own access or admin rights." });
    const sets = [], args = [id];
    if (typeof req.body.active === "boolean") { args.push(req.body.active); sets.push("active=$" + args.length); }
    if (typeof req.body.admin === "boolean") { args.push(req.body.admin); sets.push("is_admin=$" + args.length); }
    if (typeof req.body.name === "string" && req.body.name.trim()) { args.push(req.body.name.trim().slice(0, 80)); sets.push("name=$" + args.length); }
    if (!sets.length) return res.status(400).json({ error: "Nothing to change." });
    const r = await pool.query("UPDATE users SET " + sets.join(", ") + " WHERE id=$1", args);
    if (!r.rowCount) return res.status(404).json({ error: "Not found" });
    forgetUser(id);
    if (req.body.active === false) await pool.query("DELETE FROM sessions WHERE sess->>'uid' = $1", [id]).catch(() => {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.use("/admin/api", adminApi);

/* ---------- static files ---------- */
app.get("/vendor/xlsx.full.min.js", (req, res) => {
  res.set("Cache-Control", "public, max-age=604800");
  res.sendFile(require.resolve("xlsx/dist/xlsx.full.min.js"));
});
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "5m" }));

/* ---------- API ---------- */
const api = express.Router();
api.use(express.json({ limit: "2mb" }));

api.get("/me", (req, res) => res.json({ id: req.user.id, name: req.user.name, username: req.user.username, admin: !!req.user.is_admin }));

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
      "SELECT id, name FROM users WHERE active AND (name ILIKE $1 OR username ILIKE $1) ORDER BY name LIMIT 8",
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
  const me = req.user;
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
    [p.collection, p.id, merged, req.user.id]
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
    await pool.query("INSERT INTO docs (collection, id, data, updated_by) VALUES ($1,$2,$3,$4)", [collection, id, data, req.user.id]);
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
    if ((p.collection === "comments" || p.collection === "chat") && d.by && d.by !== req.user.id && !isAdmin(req)) {
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
  if (!isAdmin(req)) return res.status(403).type("text").send("Admins only.");
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
        [d.collection, String(d.id), d.data, req.user.id]
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
  .then(() => app.listen(PORT, () => console.log("China PO tracker listening on " + PORT + " at " + BASE_URL)))
  .catch(e => { console.error("Database setup failed", e); process.exit(1); });
