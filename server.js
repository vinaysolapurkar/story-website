// Stories of the Masters — auth + bookmarks backend
// Runs on port 3030, serves the static site and exposes /api endpoints.

import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3030;
const DB_PATH = path.join(__dirname, "data.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id INTEGER NOT NULL,
    story_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, story_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// Periodic session cleanup
setInterval(() => {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}, 60 * 60 * 1000).unref();

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());

const SESSION_DAYS = 30;
const SESSION_TTL = SESSION_DAYS * 24 * 60 * 60 * 1000;

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function setSessionCookie(res, token) {
  res.cookie("sid", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // Tailscale-served HTTPS terminates upstream — keep false so cookie works on http://localhost too
    maxAge: SESSION_TTL,
    path: "/",
  });
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.sid;
  req.user = null;
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.email FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(token, Date.now());
    if (row) req.user = { id: row.id, email: row.email };
  }
  next();
}
app.use(authMiddleware);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "not signed in" });
  next();
}

function isValidEmail(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
}

// ---------- AUTH ----------
app.post("/api/auth/register", (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: "Invalid email." });
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "An account with that email already exists." });
  const hash = bcrypt.hashSync(password, 11);
  const result = db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)").run(email, hash, Date.now());
  const token = newToken();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, result.lastInsertRowid, Date.now(), Date.now() + SESSION_TTL);
  setSessionCookie(res, token);
  res.json({ user: { id: result.lastInsertRowid, email } });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== "string") {
    return res.status(400).json({ error: "Invalid email or password." });
  }
  const user = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const token = newToken();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, user.id, Date.now(), Date.now() + SESSION_TTL);
  setSessionCookie(res, token);
  res.json({ user: { id: user.id, email: user.email } });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies?.sid;
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.user });
});

// ---------- BOOKMARKS ----------
app.get("/api/bookmarks", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT story_id, created_at FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.user.id);
  res.json({ bookmarks: rows.map(r => r.story_id) });
});

app.post("/api/bookmarks/:storyId", requireAuth, (req, res) => {
  const id = parseInt(req.params.storyId, 10);
  if (!Number.isInteger(id) || id < 1 || id > 100000) return res.status(400).json({ error: "bad id" });
  db.prepare("INSERT OR IGNORE INTO bookmarks (user_id, story_id, created_at) VALUES (?, ?, ?)")
    .run(req.user.id, id, Date.now());
  res.json({ ok: true });
});

app.delete("/api/bookmarks/:storyId", requireAuth, (req, res) => {
  const id = parseInt(req.params.storyId, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });
  db.prepare("DELETE FROM bookmarks WHERE user_id = ? AND story_id = ?").run(req.user.id, id);
  res.json({ ok: true });
});

app.post("/api/bookmarks/sync", requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(n => Number.isInteger(n) && n >= 1 && n <= 100000) : [];
  const stmt = db.prepare("INSERT OR IGNORE INTO bookmarks (user_id, story_id, created_at) VALUES (?, ?, ?)");
  const tx = db.transaction(() => {
    for (const id of ids) stmt.run(req.user.id, id, Date.now());
  });
  tx();
  const rows = db.prepare("SELECT story_id FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json({ bookmarks: rows.map(r => r.story_id) });
});

// ---------- STATIC ----------
app.use(express.static(__dirname, {
  index: "index.html",
  setHeaders: (res, p) => {
    if (p.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
  },
}));

app.listen(PORT, () => {
  console.log(`Stories server running on http://localhost:${PORT}`);
});
