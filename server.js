"use strict";
// Dialogue Duel server. No dependencies: needs Node 18+ (built-in fetch).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 10000;
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const UP = path.join(DATA, "uploads");
const DBF = path.join(DATA, "db.json");
const PUBLIC = path.join(__dirname, "public");
const MAX_UPLOAD = 150 * 1024 * 1024;
const EMOJI = ["🔥", "😂", "👏", "😮", "❤️"];
const EXT = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
const MIME = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", jpg: "image/jpeg" };

fs.mkdirSync(UP, { recursive: true });
const METHODS = (process.env.AUTH_METHODS || (process.env.REQUIRE_EMAIL === "1" ? "email" : "")).split(",").map((x) => x.trim()).filter((x) => x === "email" || x === "phone");
let db = { users: {}, clips: {}, takes: {}, uploads: {}, codes: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, "utf8"))); } catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DBF + ".tmp", JSON.stringify(db), () => fs.rename(DBF + ".tmp", DBF, () => {})), 200);
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rid = (p) => p + crypto.randomBytes(6).toString("hex");
const clamp = (x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0)));

/* ---------- tiny rate limiter ---------- */
const hits = new Map();
function limited(ip, n) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 60000);
  h.push(now); hits.set(ip, h); return h.length > n;
}
setInterval(() => {
  const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  for (const [k, v] of Object.entries(db.codes)) if (v.exp < now) delete db.codes[k];
}, 60000).unref();

/* ---------- email sign-in ---------- */
const IP_LIMIT = Number(process.env.AUTH_IP_LIMIT) || 20;
const idHash = (kind, v) => sha(kind + ":" + v);
function validName(name) { return /^[A-Za-z0-9_][A-Za-z0-9_ ]{1,19}$/.test(name); }
function normPhone(raw) {
  const cc = process.env.DEFAULT_COUNTRY_CODE || "91";
  let t = String(raw || "").replace(/[\s\-().]/g, "");
  if (/^\d{10}$/.test(t)) t = "+" + cc + t; else if (/^0\d{10}$/.test(t)) t = "+" + cc + t.slice(1); else if (/^\d{11,15}$/.test(t)) t = "+" + t;
  return /^\+[1-9]\d{7,14}$/.test(t) ? t : null;
}
function normId(b) {
  const kind = b.phone != null ? "phone" : "email";
  if (!METHODS.includes(kind)) throw fail(400, "That sign-in method is not available");
  if (kind === "phone") { const p = normPhone(b.phone); if (!p) throw fail(400, "Enter a valid phone number with country code"); return { kind, value: p }; }
  const e = String(b.email || "").trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw fail(400, "Enter a valid email address");
  return { kind, value: e };
}
const sms = { day: "", n: 0 };
async function sendCode(kind, to, code) {
  if (kind === "email") {
    const key = process.env.RESEND_API_KEY;
    if (!key) { console.log("[dev] email code for " + to + ": " + code); return false; }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15000), headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.MAIL_FROM || "Dialogue Duel <onboarding@resend.dev>", to: [to], subject: "Your Dialogue Duel code: " + code, text: "Your sign-in code is " + code + ". It works for 10 minutes. If you did not ask for it, ignore this email." })
    });
    if (!r.ok) throw fail(502, "Could not send the email. Check the address and try again.");
    return true;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM, svc = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !tok || !(from || svc)) { console.log("[dev] phone code for " + to + ": " + code); return false; }
  const day = new Date().toISOString().slice(0, 10); if (sms.day !== day) { sms.day = day; sms.n = 0; }
  if (++sms.n > (Number(process.env.SMS_DAILY_CAP) || 500)) throw fail(429, "Phone sign-in is busy right now. Try email or come back tomorrow.");
  const params = new URLSearchParams({ To: to, Body: "Your Dialogue Duel code is " + code + ". It works for 10 minutes." });
  if (svc) params.set("MessagingServiceSid", svc); else params.set("From", from);
  const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json", {
    method: "POST", signal: AbortSignal.timeout(15000), body: params,
    headers: { Authorization: "Basic " + Buffer.from(sid + ":" + tok).toString("base64"), "content-type": "application/x-www-form-urlencoded" }
  });
  if (!r.ok) throw fail(502, "Could not send the text message. Check the number and try again.");
  return true;
}

/* ---------- scoring ---------- */
function pearson(a, b) {
  const n = Math.min(a.length, b.length); if (!n) return 0;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; dbb += (b[i] - mb) ** 2; }
  const den = Math.sqrt(da * dbb); return den ? num / den : 0;
}
function deliveryScore(ref, take) {
  if (!ref || !take || !Array.isArray(ref.env) || !Array.isArray(take.env) || !ref.env.length || !take.env.length) return null;
  const corr = Math.max(0, pearson(ref.env, take.env));
  const rd = Number(ref.dur) || 0, td = Number(take.dur) || 0;
  const dur = rd && td ? 1 - Math.min(1, Math.abs(rd - td) / Math.max(rd, td)) : 0.5;
  return clamp(100 * (0.7 * corr + 0.3 * dur));
}
function basicVision(refThumbs, takeThumbs) {
  const k = Math.min((refThumbs || []).length, (takeThumbs || []).length); if (!k) return null;
  let s = 0; for (let i = 0; i < k; i++) s += pearson(refThumbs[i], takeThumbs[i]);
  return clamp(100 * Math.max(0, (s / k - 0.1) / 0.8));
}
async function aiVision(refFrames, takeFrames) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key || !refFrames.length || !takeFrames.length) return null;
  const k = Math.min(4, refFrames.length, takeFrames.length), content = [];
  content.push({ type: "text", text: "ORIGINAL clip frames, in order:" });
  refFrames.slice(0, k).forEach((b) => content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } }));
  content.push({ type: "text", text: "RECREATION frames, in order:" });
  takeFrames.slice(0, k).forEach((b) => content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } }));
  content.push({ type: "text", text: "You judge a movie-scene recreation challenge. Compare camera framing and angle, setting, costume, props, pose, body language and facial expression. Be strict: 100 is near identical, 50 is a similar idea but clearly different, 0 is unrelated. Reply with only JSON: {\"scene\": 0-100 for setting, framing, costume and props, \"acting\": 0-100 for pose, expression and energy, \"tip\": \"one specific sentence of advice for the next take\"}." });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(60000),
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 300, messages: [{ role: "user", content }] })
    });
    if (!r.ok) return null;
    const j = await r.json(), text = (j.content && j.content[0] && j.content[0].text) || "";
    const m = text.match(/\{[\s\S]*\}/); if (!m) return null;
    const o = JSON.parse(m[0]);
    return { scene: clamp(o.scene), acting: clamp(o.acting), tip: String(o.tip || "").slice(0, 200) };
  } catch (e) { return null; }
}
async function scoreTake(clip, f, takeFrames) {
  const delivery = deliveryScore(clip.features, f);
  const refFrames = (clip.frameFiles || []).map((n) => { try { return fs.readFileSync(path.join(UP, n)); } catch (e) { return null; } }).filter(Boolean);
  const ai = await aiVision(refFrames, takeFrames);
  let vision, scene = null, acting = null, tip = "", method;
  if (ai) { scene = ai.scene; acting = ai.acting; vision = (scene + acting) / 2; tip = ai.tip; method = "ai"; }
  else { vision = basicVision(clip.features && clip.features.thumbs, f.thumbs); method = "basic"; tip = "Basic frame matching was used. Match the framing, lighting and position more closely."; }
  if (vision == null && delivery == null) return null;
  const parts = [], w = [];
  if (vision != null) { parts.push(vision); w.push(0.6); }
  if (delivery != null) { parts.push(delivery); w.push(0.4); }
  const tw = w.reduce((a, b) => a + b, 0); let score = 0; parts.forEach((p, i) => (score += (p * w[i]) / tw));
  return { score: clamp(score), vision: vision == null ? null : clamp(vision), scene, acting, delivery, tip, method };
}

/* ---------- derived data ---------- */
function ratingsOf(t) { const v = Object.values(t.ratings || {}); return { n: v.length, avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }; }
function rankScore(t) { const r = ratingsOf(t); return r.n >= 3 ? 0.5 * t.ai.score + 0.5 * r.avg : t.ai.score; }
function visibleClip(c) { return c && !c.hidden; }
function userPublic(id) { const u = db.users[id]; return u ? { id: u.id, name: u.name } : { id, name: "Deleted user" }; }
function takesOf(clipId) { return Object.values(db.takes).filter((t) => t.clipId === clipId).sort((a, b) => rankScore(b) - rankScore(a) || a.at - b.at); }
function userStats() {
  const stats = {};
  const get = (id) => (stats[id] = stats[id] || { points: 0, takes: 0, reactions: 0, week: 0, best: 0 });
  const weekAgo = Date.now() - 7 * 864e5;
  for (const c of Object.values(db.clips)) {
    if (!visibleClip(c)) continue;
    const ts = takesOf(c.id), best = {};
    ts.forEach((t) => { best[t.ownerId] = Math.max(best[t.ownerId] || 0, rankScore(t)); });
    Object.entries(best).forEach(([id, s]) => { get(id).points += Math.round(s); get(id).best = Math.max(get(id).best, Math.round(s)); });
    if (ts.length) get(ts[0].ownerId).points += 25;
    ts.forEach((t) => {
      const u = get(t.ownerId); u.takes++;
      const rx = Object.values(t.reactions || {}).reduce((a, l) => a + l.length, 0) + ratingsOf(t).n;
      u.reactions += rx; u.points += rx; if (t.at > weekAgo) u.week += Math.round(rankScore(t)) + rx;
    });
  }
  return stats;
}
function takeView(t, viewer) {
  const r = ratingsOf(t), reactions = {};
  EMOJI.forEach((e) => { const l = (t.reactions && t.reactions[e]) || []; reactions[e] = { n: l.length, mine: !!(viewer && l.includes(viewer.id)) }; });
  return {
    id: t.id, clipId: t.clipId, owner: userPublic(t.ownerId), at: t.at, video: "/media/" + t.file,
    aiScore: t.ai.score, scene: t.ai.scene, acting: t.ai.acting, delivery: t.ai.delivery, tip: t.ai.tip, method: t.ai.method,
    publicScore: r.avg == null ? null : Math.round(r.avg), publicCount: r.n, rank: Math.round(rankScore(t)),
    myRating: viewer && t.ratings ? t.ratings[viewer.id] ?? null : null, reactions,
    comments: (t.comments || []).map((c) => ({ id: c.id, owner: userPublic(c.uid), text: c.text, at: c.at })), beat: t.beat || null
  };
}
function clipView(c, withTakes, viewer) {
  const ts = takesOf(c.id);
  const v = { id: c.id, title: c.title, owner: userPublic(c.ownerId), at: c.at, duration: c.duration, video: "/media/" + c.file, takesCount: ts.length, topScore: ts[0] ? Math.round(rankScore(ts[0])) : null, hidden: !!c.hidden };
  if (withTakes) v.takes = ts.map((t) => takeView(t, viewer));
  return v;
}

/* ---------- http helpers ---------- */
function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(b); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
  });
}
async function jsonBody(req) { const b = await readBody(req, 4 * 1024 * 1024); try { return JSON.parse(b.toString() || "{}"); } catch (e) { throw Object.assign(new Error("bad json"), { code: 400 }); } }
function authUser(req) {
  const h = req.headers.authorization || ""; if (!h.startsWith("Bearer ")) return null;
  const hash = sha(h.slice(7)); return Object.values(db.users).find((u) => u.tokenHash === hash || (u.tokens || []).includes(hash)) || null;
}
function isAdmin(req) { return !!process.env.ADMIN_TOKEN && req.headers["x-admin-token"] === process.env.ADMIN_TOKEN; }
function serveFile(req, res, fp, mime) {
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("Not found"); }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    const base = { "content-type": mime, "accept-ranges": "bytes", "cache-control": fp.startsWith(UP) ? "public, max-age=31536000, immutable" : "no-cache" };
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10), end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
      if (start < 0) start = 0; if (end >= st.size) end = st.size - 1;
      if (start > end) { res.writeHead(416, { "content-range": "bytes */" + st.size }); return res.end(); }
      res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else { res.writeHead(200, { ...base, "content-length": st.size }); fs.createReadStream(fp).pipe(res); }
  });
}
function saveFrames(prefix, frames) {
  const names = [];
  (Array.isArray(frames) ? frames : []).slice(0, 4).forEach((b64, i) => {
    if (typeof b64 !== "string") return; const buf = Buffer.from(b64.replace(/^data:image\/jpeg;base64,/, ""), "base64");
    if (!buf.length || buf.length > 600000 || buf[0] !== 0xff || buf[1] !== 0xd8) return;
    const n = `${prefix}-f${i}.jpg`; fs.writeFileSync(path.join(UP, n), buf); names.push(n);
  });
  return names;
}
function cleanFeatures(f) {
  f = f || {}; const num = (a, len) => (Array.isArray(a) ? a.slice(0, len).map((x) => Number(x) || 0) : []);
  return { env: num(f.env, 128), dur: Number(f.dur) || 0, thumbs: (Array.isArray(f.thumbs) ? f.thumbs.slice(0, 4) : []).map((t) => num(t, 256)).filter((t) => t.length === 256) };
}
function fail(code, msg) { return Object.assign(new Error(msg), { code }); }

/* ---------- routes ---------- */
async function api(req, res, u) {
  const m = req.method, p = u.pathname, viewer = authUser(req);
  const need = () => { if (!viewer) throw fail(401, "Sign in first"); return viewer; };
  const fwd = process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  const ip = fwd || req.socket.remoteAddress || "x";
  if (m !== "GET" && limited(ip, 90)) throw fail(429, "Slow down a little");

  if (m === "GET" && p === "/api/config") return send(res, 200, { methods: METHODS });
  if (m === "POST" && p === "/api/auth/start") {
    if (!METHODS.length) throw fail(404, "Not found");
    const b = await jsonBody(req), id = normId(b), ih = idHash(id.kind, id.value);
    if (limited("as" + ip, id.kind === "phone" ? Math.ceil(IP_LIMIT / 2) : IP_LIMIT) || limited("ae" + ih, 3)) throw fail(429, "Too many codes requested. Wait a minute.");
    const code = String(crypto.randomInt(100000, 1000000));
    db.codes[ih] = { hash: sha(code + ih), exp: Date.now() + 10 * 60000, tries: 0 }; save();
    const sent = await sendCode(id.kind, id.value, code);
    return send(res, 200, { ok: true, ...(process.env.DEV_SHOW_CODE === "1" && !sent ? { devCode: code } : {}) });
  }
  if (m === "POST" && p === "/api/auth/verify") {
    if (!METHODS.length) throw fail(404, "Not found");
    const b = await jsonBody(req), id = normId(b), ih = idHash(id.kind, id.value), rec = db.codes[ih];
    if (!rec || rec.exp < Date.now()) throw fail(400, "That code expired. Ask for a new one.");
    if (rec.tries >= 5) { delete db.codes[ih]; save(); throw fail(429, "Too many wrong tries. Ask for a new code."); }
    const given = Buffer.from(sha(String(b.code || "").trim() + ih)), want = Buffer.from(rec.hash);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { rec.tries++; save(); throw fail(400, "Wrong code"); }
    let user = Object.values(db.users).find((x) => (x.idHash || x.emailHash) === ih);
    if (!user) {
      const name = String(b.name || "").trim();
      if (!name) return send(res, 200, { needName: true });
      if (!validName(name)) throw fail(400, "Use 2 to 20 letters, numbers or underscores");
      if (Object.values(db.users).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw fail(409, "That name is taken");
      const uid = rid("u"); user = db.users[uid] = { id: uid, name, idHash: ih, tokens: [], at: Date.now() };
    }
    delete db.codes[ih];
    const token = crypto.randomBytes(24).toString("hex"); user.tokens = (user.tokens || []).concat(sha(token)).slice(-10); save();
    return send(res, 200, { token, user: { id: user.id, name: user.name } });
  }
  if (m === "POST" && p === "/api/register") {
    if (METHODS.length) throw fail(403, "Sign in with your email or phone");
    const b = await jsonBody(req), name = String(b.name || "").trim();
    if (!validName(name)) throw fail(400, "Use 2 to 20 letters, numbers or underscores");
    if (Object.values(db.users).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw fail(409, "That name is taken");
    const token = crypto.randomBytes(24).toString("hex"), id = rid("u");
    db.users[id] = { id, name, tokenHash: sha(token), at: Date.now() }; save();
    return send(res, 200, { token, user: { id, name } });
  }
  if (m === "GET" && p === "/api/me") {
    if (!viewer) return send(res, 200, { user: null });
    const s = userStats()[viewer.id] || { points: 0, takes: 0 };
    return send(res, 200, { user: { id: viewer.id, name: viewer.name }, credits: s.points, takes: s.takes });
  }
  if (m === "POST" && p === "/api/upload") {
    need(); if (limited("up" + viewer.id, 12)) throw fail(429, "Too many uploads. Wait a minute.");
    const type = String(req.headers["content-type"] || "").split(";")[0].trim(), ext = EXT[type];
    if (!ext) throw fail(415, "Use an MP4, WebM or MOV video");
    const len = Number(req.headers["content-length"] || 0); if (len > MAX_UPLOAD) throw fail(413, "Video is over 150 MB");
    const name = rid("v") + "." + ext, fp = path.join(UP, name);
    await new Promise((resolve, reject) => {
      let size = 0; const out = fs.createWriteStream(fp);
      req.on("data", (c) => { size += c.length; if (size > MAX_UPLOAD) { out.destroy(); req.destroy(); fs.unlink(fp, () => {}); reject(fail(413, "Video is over 150 MB")); } });
      req.pipe(out); out.on("finish", resolve); out.on("error", reject); req.on("error", reject);
    });
    db.uploads[name] = { ownerId: viewer.id, used: false, at: Date.now() }; save();
    return send(res, 200, { file: name });
  }
  if (m === "GET" && p === "/api/clips") {
    const sort = u.searchParams.get("sort") || "new", weekAgo = Date.now() - 7 * 864e5;
    let list = Object.values(db.clips).filter(visibleClip).map((c) => ({ c, v: clipView(c, false, viewer), hot: Object.values(db.takes).filter((t) => t.clipId === c.id && t.at > weekAgo).length }));
    list.sort((a, b) => (sort === "hot" ? b.hot - a.hot || b.c.at - a.c.at : b.c.at - a.c.at));
    return send(res, 200, { clips: list.map((x) => x.v) });
  }
  if (m === "POST" && p === "/api/clips") {
    need(); const b = await jsonBody(req);
    const up = db.uploads[b.file]; if (!up || up.ownerId !== viewer.id || up.used) throw fail(400, "Upload the video first");
    if (b.rights !== true) throw fail(400, "Confirm you have the right to share this clip");
    const title = String(b.title || "").trim().slice(0, 60) || "Untitled scene", id = rid("c");
    const frameFiles = saveFrames(id, b.features && b.features.frames);
    db.clips[id] = { id, title, file: b.file, ownerId: viewer.id, at: Date.now(), duration: Number(b.duration) || 0, features: cleanFeatures(b.features), frameFiles, reports: [] };
    up.used = true; save();
    return send(res, 200, { clip: clipView(db.clips[id], false, viewer) });
  }
  let mm;
  if ((mm = /^\/api\/clips\/([\w-]+)$/.exec(p))) {
    const c = db.clips[mm[1]]; if (!c || (c.hidden && !(viewer && viewer.id === c.ownerId) && !isAdmin(req))) throw fail(404, "Clip not found");
    if (m === "GET") return send(res, 200, { clip: clipView(c, true, viewer) });
    if (m === "DELETE") {
      if (!((viewer && viewer.id === c.ownerId) || isAdmin(req))) throw fail(403, "Only the owner can remove this clip");
      Object.values(db.takes).filter((t) => t.clipId === c.id).forEach((t) => delete db.takes[t.id]);
      delete db.clips[c.id]; save(); return send(res, 200, { ok: true });
    }
  }
  if ((mm = /^\/api\/clips\/([\w-]+)\/report$/.exec(p)) && m === "POST") {
    need(); const c = db.clips[mm[1]]; if (!c) throw fail(404, "Clip not found");
    c.reports = c.reports || []; if (!c.reports.includes(viewer.id)) c.reports.push(viewer.id);
    if (c.reports.length >= 3) c.hidden = true; save();
    return send(res, 200, { ok: true, hidden: !!c.hidden });
  }
  if (m === "POST" && p === "/api/takes") {
    need(); if (limited("take" + viewer.id, 10)) throw fail(429, "Too many takes. Wait a minute.");
    const b = await jsonBody(req), c = db.clips[b.clipId];
    if (!c || c.hidden) throw fail(404, "Clip not found");
    const up = db.uploads[b.file]; if (!up || up.ownerId !== viewer.id || up.used) throw fail(400, "Upload the video first");
    const f = cleanFeatures(b.features), tid = rid("t");
    const frameFiles = saveFrames(tid, b.features && b.features.frames);
    const frames = frameFiles.map((n) => fs.readFileSync(path.join(UP, n)));
    const ai = await scoreTake(c, f, frames);
    frameFiles.forEach((n) => fs.unlink(path.join(UP, n), () => {}));
    if (!ai) throw fail(422, "Could not read that video. Use the same framing and clear sound.");
    const beat = db.takes[b.beat] && db.takes[b.beat].clipId === c.id ? b.beat : null;
    db.takes[tid] = { id: tid, clipId: c.id, ownerId: viewer.id, file: b.file, at: Date.now(), ai, ratings: {}, reactions: {}, comments: [], beat };
    up.used = true; save();
    return send(res, 200, { take: takeView(db.takes[tid], viewer) });
  }
  if ((mm = /^\/api\/takes\/([\w-]+)(?:\/(rate|react|comment))?$/.exec(p))) {
    const t = db.takes[mm[1]]; if (!t) throw fail(404, "Take not found");
    const act = mm[2];
    if (!act && m === "DELETE") {
      if (!((viewer && viewer.id === t.ownerId) || isAdmin(req))) throw fail(403, "Only the creator can remove this take");
      delete db.takes[t.id]; save(); return send(res, 200, { ok: true });
    }
    if (act && m === "POST") {
      need(); const b = await jsonBody(req);
      if (act === "rate") {
        if (t.ownerId === viewer.id) throw fail(400, "You cannot rate your own take");
        const s = Number(b.score); if (!(s >= 0 && s <= 100)) throw fail(400, "Score must be 0 to 100");
        t.ratings[viewer.id] = Math.round(s);
      } else if (act === "react") {
        if (!EMOJI.includes(b.emoji)) throw fail(400, "Unknown reaction");
        const l = (t.reactions[b.emoji] = t.reactions[b.emoji] || []), i = l.indexOf(viewer.id); if (i >= 0) l.splice(i, 1); else l.push(viewer.id);
      } else {
        const text = String(b.text || "").trim().slice(0, 200); if (!text) throw fail(400, "Write something first");
        if (limited("cm" + viewer.id, 20)) throw fail(429, "Too many comments");
        t.comments.push({ id: rid("m"), uid: viewer.id, text, at: Date.now() });
        if (t.comments.length > 200) t.comments.shift();
      }
      save(); return send(res, 200, { take: takeView(t, viewer) });
    }
  }
  if (m === "GET" && p === "/api/featured") {
    const stats = userStats(), vis = Object.values(db.takes).filter((t) => visibleClip(db.clips[t.clipId]));
    const topTakes = vis.sort((a, b) => rankScore(b) - rankScore(a)).slice(0, 8).map((t) => ({ ...takeView(t, viewer), clipTitle: db.clips[t.clipId].title }));
    const creators = Object.entries(stats).filter(([id]) => db.users[id]).map(([id, s]) => ({ user: userPublic(id), points: s.points, takes: s.takes, best: s.best, week: s.week }));
    const topCreators = creators.slice().sort((a, b) => b.points - a.points).slice(0, 8);
    const cw = creators.filter((x) => x.week > 0).sort((a, b) => b.week - a.week)[0] || null;
    const weekAgo = Date.now() - 7 * 864e5;
    const hot = Object.values(db.clips).filter(visibleClip).map((c) => ({ c, n: Object.values(db.takes).filter((t) => t.clipId === c.id && t.at > weekAgo).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 6).map((x) => clipView(x.c, false, viewer));
    return send(res, 200, { topTakes, topCreators, creatorOfWeek: cw, hotClips: hot });
  }
  if (m === "GET" && (mm = /^\/api\/users\/([\w-]+)$/.exec(p))) {
    const target = Object.values(db.users).find((x) => x.id === mm[1] || x.name.toLowerCase() === decodeURIComponent(mm[1]).toLowerCase());
    if (!target) throw fail(404, "Creator not found");
    const s = userStats()[target.id] || { points: 0, takes: 0, best: 0 };
    const takes = Object.values(db.takes).filter((t) => t.ownerId === target.id && visibleClip(db.clips[t.clipId])).sort((a, b) => b.at - a.at).map((t) => ({ ...takeView(t, viewer), clipTitle: db.clips[t.clipId].title }));
    return send(res, 200, { user: { id: target.id, name: target.name }, points: s.points, best: s.best, takes });
  }
  throw fail(404, "Not found");
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/healthz") return send(res, 200, { ok: true });
    if (u.pathname.startsWith("/api/")) return await api(req, res, u);
    if (u.pathname.startsWith("/media/")) {
      const name = u.pathname.slice(7); if (!/^[\w-]+\.(mp4|webm|mov|jpg)$/.test(name)) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, path.join(UP, name), MIME[name.split(".").pop()]);
    }
    const rel = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
    const fp = path.join(PUBLIC, rel);
    if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    const ext = path.extname(fp).slice(1), types = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", json: "application/json" };
    if (!types[ext]) return serveFile(req, res, path.join(PUBLIC, "index.html"), types.html);
    return serveFile(req, res, fp, types[ext]);
  } catch (e) {
    if (!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.code ? e.message : "Something went wrong" });
    if (!e.code) console.error(e);
  }
});
if (require.main === module) server.listen(PORT, "0.0.0.0", () => {
  console.log("Dialogue Duel running on http://0.0.0.0:" + PORT + (process.env.ANTHROPIC_API_KEY ? " (AI scoring on)" : " (basic scoring: set ANTHROPIC_API_KEY for AI)"));
  if (METHODS.includes("email") && !process.env.RESEND_API_KEY) console.log("WARNING: email sign-in is on but RESEND_API_KEY is not set. Codes only print here, so real users cannot sign in by email.");
  if (METHODS.includes("phone") && !(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID))) console.log("WARNING: phone sign-in is on but Twilio is not configured. Codes only print here, so real users cannot sign in by phone.");
});
module.exports = server;
