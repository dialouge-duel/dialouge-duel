"use strict";
(function () {
  var app = document.getElementById("app");
  var TOKEN_KEY = "dd-token";
  var token = localStorage.getItem(TOKEN_KEY) || null;
  var me = null, teardown = null, routeId = 0;
  var openComments = {};

  /* ---------- helpers ---------- */
  function h(tag, attrs) {
    var e = document.createElement(tag), kids = Array.prototype.slice.call(arguments, 2);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === "class") e.className = v;
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    });
    (function add(list) { list.forEach(function (c) { if (c == null || c === false) return; if (Array.isArray(c)) return add(c); e.append(c.nodeType ? c : document.createTextNode(String(c))); }); })(kids);
    return e;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function mount(node) { app.textContent = ""; app.append(node); }
  function wrap() { return h.apply(null, ["div", { class: "wrap-inner", style: "display:flex;flex-direction:column;gap:16px" }].concat(Array.prototype.slice.call(arguments))); }
  function loading(msg) { return h("p", { class: "status" }, h("span", { class: "spinner" }), msg || "Loading..."); }
  async function api(path, opts) {
    opts = opts || {};
    var headers = {}; if (token) headers.Authorization = "Bearer " + token; if (opts.body) headers["Content-Type"] = "application/json";
    var r = await fetch("/api" + path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) { var err = new Error(j.error || "Request failed"); err.status = r.status; if (r.status === 401) { token = null; localStorage.removeItem(TOKEN_KEY); me = null; } throw err; }
    return j;
  }
  async function loadMe() {
    try { var j = await api("/me"); me = j.user; document.getElementById("credits").textContent = String(j.credits || 0); } catch (e) { me = null; }
  }
  var authMethods = null;
  async function ensureAuth() {
    if (token && me) return me;
    if (authMethods === null) { try { authMethods = (await api("/config")).methods || []; } catch (e) { authMethods = []; } }
    return new Promise(function (resolve, reject) {
      var $ = function (id) { return document.getElementById(id); };
      var dlg = $("auth"), form = $("auth-form"), err = $("auth-err"), go = $("auth-go"), tabs = $("auth-methods"), done = false;
      var fEmail = $("f-email"), fPhone = $("f-phone"), fCode = $("f-code"), fName = $("f-name");
      var step = authMethods.length ? "id" : "name", method = authMethods[0] || "email";
      function ident() { return method === "phone" ? { phone: $("auth-phone").value.trim() } : { email: $("auth-email").value.trim() }; }
      function where() { return method === "phone" ? $("auth-phone").value.trim() : $("auth-email").value.trim(); }
      function show(s) {
        step = s; err.hidden = true;
        fEmail.hidden = !(s === "id" && method === "email"); fPhone.hidden = !(s === "id" && method === "phone");
        fCode.hidden = s !== "code"; fName.hidden = s !== "name" && s !== "name2";
        tabs.hidden = !(s === "id" && authMethods.length > 1);
        tabs.querySelectorAll("button").forEach(function (b) { b.hidden = authMethods.indexOf(b.getAttribute("data-m")) < 0; b.classList.toggle("on", b.getAttribute("data-m") === method); });
        $("auth-title").textContent = s === "id" ? "Sign in" : s === "code" ? "Enter your code" : "Pick a creator name";
        $("auth-hint").textContent = s === "id" ? (method === "phone" ? "We text you a 6-digit code. No password needed. Your number is never shown to other people." : "We email you a 6-digit code. No password needed. Your email is never shown to other people.")
          : s === "code" ? "We sent a code to " + where() + ". It works for 10 minutes."
          : s === "name2" ? "New here. This is how you appear on takes, comments and the leaderboard." : "This is how you appear on takes, comments and the leaderboard.";
        go.textContent = s === "id" ? "Send code" : "Continue";
        var f = s === "id" ? (method === "phone" ? $("auth-phone") : $("auth-email")) : s === "code" ? $("auth-code") : $("auth-name"); if (f) f.focus();
      }
      tabs.querySelectorAll("button").forEach(function (b) { b.onclick = function () { method = b.getAttribute("data-m"); show("id"); }; });
      function finish(j) { token = j.token; localStorage.setItem(TOKEN_KEY, token); done = true; dlg.close(); return loadMe().then(function () { resolve(me); }); }
      form.onsubmit = async function (ev) {
        ev.preventDefault(); err.hidden = true; go.disabled = true;
        try {
          if (step === "name") { await finish(await api("/register", { method: "POST", body: { name: $("auth-name").value.trim() } })); }
          else if (step === "id") { await api("/auth/start", { method: "POST", body: ident() }); $("auth-code").value = ""; show("code"); }
          else {
            var body = Object.assign(ident(), { code: $("auth-code").value.trim() });
            if (step === "name2") body.name = $("auth-name").value.trim();
            var j = await api("/auth/verify", { method: "POST", body: body });
            if (j.needName) show("name2"); else await finish(j);
          }
        } catch (e) { err.textContent = e.message; err.hidden = false; }
        go.disabled = false;
      };
      $("auth-cancel").onclick = function () { dlg.close(); };
      dlg.onclose = function () { if (!done) reject(new Error("cancelled")); };
      dlg.showModal(); show(step);
    });
  }
  function baseType(blob) {
    var t = (blob.type || "").split(";")[0].trim();
    if (t === "video/mp4" || t === "video/webm" || t === "video/quicktime") return t;
    var n = (blob.name || "").toLowerCase();
    if (/\.webm$/.test(n)) return "video/webm"; if (/\.mov$/.test(n)) return "video/quicktime"; return "video/mp4";
  }
  function extOf(blob) { var t = baseType(blob); return t === "video/webm" ? "webm" : t === "video/quicktime" ? "mov" : "mp4"; }
  function toast(msg) { var t = h("div", { role: "status", style: "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(90px + env(safe-area-inset-bottom));background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:10px;z-index:20;max-width:90vw;font-weight:600" }, msg); document.body.append(t); setTimeout(function () { t.remove(); }, 2600); }
  async function copy(text) { try { await navigator.clipboard.writeText(text); toast("Link copied"); } catch (e) { window.prompt("Copy this link", text); } }
  function userLink(u) { return h("a", { href: "#/u/" + encodeURIComponent(u.name) }, u.name); }
  function setNav(k) { document.querySelectorAll("[data-nav]").forEach(function (a) { a.classList.toggle("on", a.getAttribute("data-nav") === k); }); }

  /* ---------- video analysis (runs in the browser, scored on the server) ---------- */
  function loadVideo(url) { return new Promise(function (res, rej) { var v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; v.onloadedmetadata = function () { res(v); }; v.onerror = function () { rej(new Error("video")); }; v.src = url; }); }
  function seek(v, t) { return new Promise(function (res) { var d = false; function f() { if (d) return; d = true; v.removeEventListener("seeked", f); res(); } v.addEventListener("seeked", f); v.currentTime = t; setTimeout(f, 3000); }); }
  async function envelope(blob) {
    if (blob.size > 80 * 1024 * 1024) return null;
    try {
      var AC = window.AudioContext || window.webkitAudioContext, ctx = new AC();
      var buf = await ctx.decodeAudioData(await blob.arrayBuffer()); try { ctx.close(); } catch (e) {}
      var ch = buf.getChannelData(0), bins = 64, step = Math.max(1, Math.floor(ch.length / bins)), env = [], mx = 0, i, j;
      for (i = 0; i < bins; i++) { var s = 0, c = 0; for (j = i * step; j < Math.min(ch.length, (i + 1) * step); j += 8) { s += ch[j] * ch[j]; c++; } var r = Math.sqrt(s / Math.max(1, c)); env.push(r); if (r > mx) mx = r; }
      if (mx < 1e-4) return null;
      return { env: env.map(function (x) { return +(x / mx).toFixed(4); }), dur: buf.duration };
    } catch (e) { return null; }
  }
  async function extractFeatures(blob, knownDur) {
    var out = { frames: [], thumbs: [], env: [], dur: knownDur || 0 };
    var url = URL.createObjectURL(blob);
    try {
      var v = await loadVideo(url), d = v.duration;
      if (!isFinite(d)) { // MediaRecorder files often lack a duration until the end is read
        v.currentTime = 1e101; await new Promise(function (r) { v.ontimeupdate = function () { v.ontimeupdate = null; r(); }; setTimeout(r, 2500); });
        d = v.duration; v.currentTime = 0; await sleep(60);
      }
      if (!isFinite(d) || d <= 0) d = knownDur || 0;
      if (d > 0 && v.videoWidth) {
        var w = Math.min(480, v.videoWidth), hh = Math.round(w * v.videoHeight / v.videoWidth);
        var c = document.createElement("canvas"); c.width = w; c.height = hh; var g = c.getContext("2d");
        var c2 = document.createElement("canvas"); c2.width = 16; c2.height = 16; var g2 = c2.getContext("2d", { willReadFrequently: true });
        for (var i = 0; i < 4; i++) {
          await seek(v, d * (i + 0.5) / 4); g.drawImage(v, 0, 0, w, hh);
          out.frames.push(c.toDataURL("image/jpeg", 0.8));
          g2.drawImage(v, 0, 0, 16, 16); var px = g2.getImageData(0, 0, 16, 16).data, t = [];
          for (var k = 0; k < 256; k++) t.push(+(((0.299 * px[k * 4] + 0.587 * px[k * 4 + 1] + 0.114 * px[k * 4 + 2]) / 255)).toFixed(3));
          out.thumbs.push(t);
        }
      }
      out.dur = d || knownDur || 0;
    } catch (e) {}
    URL.revokeObjectURL(url);
    var env = await envelope(blob);
    if (env) { out.env = env.env; if (!out.dur) out.dur = env.dur; }
    return out;
  }
  function xhrUpload(blob, onProg) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest(); x.open("POST", "/api/upload");
      x.setRequestHeader("Authorization", "Bearer " + token); x.setRequestHeader("Content-Type", baseType(blob));
      x.upload.onprogress = function (e) { if (e.lengthComputable) onProg(e.loaded / e.total); };
      x.onload = function () { var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} if (x.status === 200) res(j); else rej(new Error(j.error || "Upload failed")); };
      x.onerror = function () { rej(new Error("Network error. Try again.")); };
      x.send(blob);
    });
  }
  function progressBox() {
    var label = h("p", { class: "status" }), bar = h("i"), wrapBar = h("div", { class: "bar", style: "display:none" }, bar), box = h("div", null, label, wrapBar);
    return { box: box, say: function (m) { label.textContent = ""; if (m) { label.append(h("span", { class: "spinner" }), m); } wrapBar.style.display = "none"; },
      prog: function (m, f) { label.textContent = ""; label.append(h("span", { class: "spinner" }), m + " " + Math.round(f * 100) + "%"); wrapBar.style.display = "block"; bar.style.width = Math.round(f * 100) + "%"; }, clear: function () { label.textContent = ""; wrapBar.style.display = "none"; } };
  }

  /* ---------- shared UI ---------- */
  function scoreChips(t) {
    var c = h("div", { class: "chips" });
    if (t.scene != null) { c.append(h("span", { class: "chip" }, "Scene " + t.scene), h("span", { class: "chip" }, "Acting " + t.acting)); }
    if (t.delivery != null) c.append(h("span", { class: "chip" }, "Delivery " + t.delivery));
    return c;
  }
  async function shareTake(t, clipTitle) {
    var link = location.origin + "/#/recreate/" + t.clipId + "?beat=" + t.id;
    var text = "I scored " + t.rank + "% recreating \"" + clipTitle + "\" on Dialogue Duel. Can you beat it?";
    try {
      var r = await fetch(t.video), b = await r.blob(), ext = /webm/.test(b.type) ? "webm" : "mp4";
      var file = new File([b], "dialogue-duel-" + t.rank + "pct." + ext, { type: b.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Dialogue Duel", text: text + " " + link }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    if (navigator.share) { try { await navigator.share({ title: "Dialogue Duel", text: text, url: link }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    copy(link);
  }
  function takeCard(t, opts) {
    opts = opts || {};
    var card = h("article", { class: "take" + (opts.first ? " first-in-list" : "") });
    var head = h("div", { class: "thead" });
    if (opts.rank) head.append(h("span", { class: "rank" + (opts.rank === 1 ? " gold" : "") }, String(opts.rank)));
    var who = h("span", { class: "who" }, userLink(t.owner));
    if (me && me.id === t.owner.id) who.append(h("span", { class: "sub" }, " (you)"));
    head.append(who, h("span", { class: "pts" }, t.rank + "%"));
    card.append(head);
    if (opts.clipTitle) card.append(h("a", { class: "sub", href: "#/clip/" + t.clipId }, "on " + opts.clipTitle));
    card.append(h("video", { class: "player", src: t.video, controls: true, playsinline: true, preload: "metadata" }));
    var chips = scoreChips(t); chips.append(h("span", { class: "chip gold" }, "AI " + t.aiScore), h("span", { class: "chip gold" }, t.publicCount ? "Public " + t.publicScore + " (" + t.publicCount + ")" : "No public score yet"));
    card.append(chips);
    if (t.tip) card.append(h("p", { class: "hint" }, t.tip));
    if (t.beat) card.append(h("p", { class: "hint" }, "Answered a challenge."));
    function refresh(nt) { card.replaceWith(takeCard(nt, opts)); }
    async function act(path, body) { try { await ensureAuth(); var j = await api("/takes/" + t.id + "/" + path, { method: "POST", body: body }); await loadMe(); refresh(j.take); } catch (e) { if (e.message !== "cancelled") toast(e.message); } }
    var react = h("div", { class: "react" });
    Object.keys(t.reactions).forEach(function (em) { var r = t.reactions[em]; react.append(h("button", { type: "button", class: r.mine ? "on" : "", "aria-label": "React " + em, onclick: function () { act("react", { emoji: em }); } }, em + " " + r.n)); });
    card.append(react);
    if (!me || me.id !== t.owner.id) {
      var rate = h("div", { class: "rate" }, h("span", { class: "sub" }, "Your score"));
      for (var i = 1; i <= 10; i++) (function (n) { rate.append(h("button", { type: "button", class: t.myRating === n * 10 ? "on" : "", "aria-label": "Rate " + n + " out of 10", onclick: function () { act("rate", { score: n * 10 }); } }, String(n))); })(i);
      card.append(rate);
    }
    var actions = h("div", { class: "row" },
      h("a", { class: "btn small", href: t.video, download: "dialogue-duel-" + t.rank + "pct." + (/\.webm$/.test(t.video) ? "webm" : "mp4") }, "Download"),
      h("button", { class: "btn small", type: "button", onclick: function () { shareTake(t, opts.clipTitle || "this scene"); } }, "Share"),
      h("button", { class: "btn small", type: "button", onclick: function () { copy(location.origin + "/#/recreate/" + t.clipId + "?beat=" + t.id); } }, "Challenge"),
      h("button", { class: "btn small", type: "button", onclick: function () { openComments[t.id] = !openComments[t.id]; refresh(t); } }, "Comments " + t.comments.length));
    card.append(actions);
    if (openComments[t.id]) {
      var box = h("div", { class: "cmts" });
      t.comments.forEach(function (c) { box.append(h("div", null, h("b", null, c.owner.name), ": " + c.text)); });
      var inp = h("input", { type: "text", maxlength: "200", placeholder: "Say something to the creator", "aria-label": "Comment", style: "flex:1" });
      var form = h("form", { class: "row", onsubmit: function (ev) { ev.preventDefault(); if (inp.value.trim()) act("comment", { text: inp.value }); } }, inp, h("button", { class: "btn small primary", type: "submit" }, "Post"));
      box.append(form); card.append(box);
    }
    return card;
  }
  function clipCard(c) {
    return h("a", { class: "card", href: "#/clip/" + c.id },
      h("video", { src: c.video + "#t=0.1", muted: true, playsinline: true, preload: "metadata" }),
      h("div", { class: "body" }, h("div", { class: "ttl" }, c.title), h("div", { class: "sub" }, c.takesCount + (c.takesCount === 1 ? " take" : " takes") + (c.topScore != null ? " · top " + c.topScore + "%" : ""))));
  }

  /* ---------- views ---------- */
  async function viewHome() {
    setNav("home"); mount(loading());
    var f = await api("/featured"), root = wrap();
    if (f.creatorOfWeek) {
      var c = f.creatorOfWeek;
      root.append(h("section", { class: "panel feature" }, h("div", { class: "meta" }, "Creator of the week"), h("h3", null, userLink(c.user)), h("p", { class: "hint" }, c.week + " points this week · best take " + c.best + "%")));
    }
    root.append(h("div", { class: "row between" }, h("h2", null, "Top takes"), h("a", { class: "btn small", href: "#/clips" }, "Browse clips")));
    if (!f.topTakes.length) root.append(h("div", { class: "panel empty" }, h("h3", null, "Nothing featured yet"), h("p", null, "Add a clip, record your recreation and you could be the first on this board.")));
    else { var tp = h("section", { class: "panel" }); f.topTakes.forEach(function (t, i) { tp.append(takeCard(t, { rank: i + 1, first: i === 0, clipTitle: t.clipTitle })); }); root.append(tp); }
    if (f.topCreators.length) {
      var ol = h("ol", { class: "list" });
      f.topCreators.forEach(function (c, i) { ol.append(h("li", null, h("span", { class: "rank" + (i === 0 ? " gold" : "") }, String(i + 1)), h("span", { class: "who" }, userLink(c.user), h("span", { class: "sub" }, "  " + c.takes + (c.takes === 1 ? " take" : " takes") + " · best " + c.best + "%")), h("span", { class: "pts" }, String(c.points)))); });
      root.append(h("section", { class: "panel" }, h("h2", null, "Top creators"), ol));
    }
    if (f.hotClips.length) { var g = h("div", { class: "grid" }); f.hotClips.forEach(function (c) { g.append(clipCard(c)); }); root.append(h("h2", null, "Hot challenges"), g); }
    mount(root);
  }
  async function viewClips() {
    setNav("clips"); mount(loading());
    var sort = "new";
    var root = wrap(), grid = h("div"), tabs = h("div", { class: "row" });
    async function load() {
      grid.textContent = ""; grid.append(loading());
      var j = await api("/clips?sort=" + sort); grid.textContent = "";
      if (!j.clips.length) { grid.append(h("div", { class: "panel empty" }, h("h3", null, "No clips yet"), h("p", null, "Add the first scene for people to recreate."), h("a", { class: "btn primary", href: "#/new" }, "Add a clip"))); return; }
      var g = h("div", { class: "grid" }); j.clips.forEach(function (c) { g.append(clipCard(c)); }); grid.append(g);
    }
    ["new", "hot"].forEach(function (k) { var b = h("button", { class: "btn small" + (k === sort ? " on" : ""), type: "button", onclick: function () { sort = k; tabs.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); }); load(); } }, k === "new" ? "Newest" : "Hot this week"); tabs.append(b); });
    root.append(h("h2", null, "Clips"), tabs, grid); mount(root); await load();
  }
  async function viewClip(id) {
    setNav("clips"); mount(loading());
    var c = (await api("/clips/" + id)).clip, root = wrap();
    root.append(h("a", { class: "btn small", href: "#/clips", style: "align-self:flex-start" }, "All clips"));
    var slate = h("section", { class: "slate" }, h("div", { class: "clap" }), h("div", { class: "panel" },
      h("div", { class: "meta" }, "Scene · " + c.takesCount + (c.takesCount === 1 ? " take" : " takes")), h("h2", null, c.title),
      h("video", { class: "player", src: c.video, controls: true, playsinline: true, preload: "metadata" }),
      h("p", { class: "hint" }, "Posted by ", userLink(c.owner)),
      h("div", { class: "row" }, h("a", { class: "btn primary", href: "#/recreate/" + c.id }, "Recreate this scene"),
        h("a", { class: "btn", href: c.video, download: c.title + "." + (/\.webm$/.test(c.video) ? "webm" : "mp4") }, "Download original"),
        h("button", { class: "btn", type: "button", onclick: async function () { try { await ensureAuth(); await api("/clips/" + c.id + "/report", { method: "POST" }); toast("Reported. Thank you."); } catch (e) { if (e.message !== "cancelled") toast(e.message); } } }, "Report"),
        me && me.id === c.owner.id ? h("button", { class: "btn", type: "button", onclick: async function () { if (!confirm("Remove this clip and all its takes?")) return; await api("/clips/" + c.id, { method: "DELETE" }); location.hash = "#/clips"; } }, "Remove") : null)));
    root.append(slate);
    var list = h("section", { class: "panel" }, h("h2", null, "Takes"));
    if (!c.takes.length) list.append(h("p", { class: "hint" }, "No takes yet. Be the first to recreate this scene."));
    c.takes.forEach(function (t, i) { list.append(takeCard(t, { rank: i + 1, first: i === 0, clipTitle: c.title })); });
    root.append(list); mount(root);
  }
  async function viewNew() {
    setNav("new");
    var root = wrap(), title = h("input", { type: "text", maxlength: "60", placeholder: "e.g. The rooftop confession" }), file = h("input", { type: "file", accept: "video/*" });
    var rights = h("input", { type: "checkbox" }), err = h("p", { class: "err", hidden: true }), pr = progressBox();
    var go = h("button", { class: "btn primary", type: "button" }, "Add clip");
    go.onclick = async function () {
      err.hidden = true; var f = file.files && file.files[0];
      if (!f) { err.textContent = "Choose a video first."; err.hidden = false; return; }
      if (!rights.checked) { err.textContent = "Confirm you have the right to share this clip."; err.hidden = false; return; }
      try {
        await ensureAuth(); go.disabled = true; pr.say("Reading the clip");
        var feats = await extractFeatures(f, 0); if (!feats.frames.length && !feats.env.length) throw new Error("Could not read that video. Try an MP4.");
        var up = await xhrUpload(f, function (p) { pr.prog("Uploading", p); }); pr.say("Saving");
        var j = await api("/clips", { method: "POST", body: { title: title.value.trim() || f.name.replace(/\.[^.]+$/, ""), file: up.file, duration: feats.dur, rights: true, features: feats } });
        location.hash = "#/clip/" + j.clip.id;
      } catch (e) { if (e.message !== "cancelled") { err.textContent = e.message; err.hidden = false; } pr.clear(); go.disabled = false; }
    };
    root.append(h("h2", null, "Add a clip"), h("section", { class: "panel" },
      h("p", { class: "hint" }, "Pick the scene people will recreate. Keep it under about a minute."),
      h("label", { class: "field" }, "Title", title), h("label", { class: "field" }, "Video", file),
      h("label", { class: "check" }, rights, h("span", null, "I own this clip or have permission to share it. Rights holders can have it removed on request.")),
      err, pr.box, h("div", { class: "row" }, go)));
    mount(root);
  }
  async function viewMe() {
    if (!me) { try { await ensureAuth(); } catch (e) { location.hash = "#/"; return; } }
    location.replace("#/u/" + encodeURIComponent(me.name));
  }
  async function viewUser(name) {
    setNav("me"); mount(loading());
    var j = await api("/users/" + encodeURIComponent(name)), root = wrap();
    root.append(h("section", { class: "panel" }, h("div", { class: "meta" }, "Creator"), h("h2", null, j.user.name), h("div", { class: "chips" }, h("span", { class: "chip gold" }, j.points + " points"), h("span", { class: "chip" }, "Best " + j.best + "%"), h("span", { class: "chip" }, j.takes.length + " takes"))));
    if (me && me.id === j.user.id) root.append(h("button", { class: "btn", type: "button", onclick: function () { token = null; me = null; localStorage.removeItem(TOKEN_KEY); document.getElementById("credits").textContent = "0"; location.hash = "#/"; } }, "Sign out"));
    var list = h("section", { class: "panel" }, h("h2", null, "Takes"));
    if (!j.takes.length) list.append(h("p", { class: "hint" }, "No takes yet."));
    j.takes.forEach(function (t, i) { list.append(takeCard(t, { first: i === 0, clipTitle: t.clipTitle })); });
    root.append(list); mount(root);
  }

  /* ---------- recreate: record in the app, or upload ---------- */
  async function viewRecreate(clipId, beatId, myRoute) {
    setNav("clips"); mount(loading());
    var clip = (await api("/clips/" + clipId)).clip; if (myRoute !== routeId) return;
    var beat = beatId ? clip.takes.filter(function (t) { return t.id === beatId; })[0] : null;
    var root = wrap();
    root.append(h("a", { class: "btn small", href: "#/clip/" + clip.id, style: "align-self:flex-start" }, "Back to clip"), h("h2", null, clip.title));
    if (beat) root.append(h("div", { class: "banner" }, "Challenge: beat " + beat.owner.name + "'s " + beat.rank + "%"));

    var stream = null, recorder = null, chunks = [], blob = null, recDur = 0, startedAt = 0, timer = null, mode = "idle";
    var stage = h("div", { class: "stage" }), cam = h("video", { class: "cam", muted: true, playsinline: true, autoplay: true });
    var ghost = h("video", { class: "ghost", src: clip.video, playsinline: true, preload: "auto" }); ghost.style.opacity = "0.35";
    var overlay = h("div"); stage.append(cam, ghost, overlay);
    var opacity = h("input", { type: "range", min: "0", max: "70", value: "35", "aria-label": "Overlay strength" });
    opacity.oninput = function () { ghost.style.opacity = String(opacity.value / 100); };
    var sound = h("input", { type: "checkbox" }), split = h("input", { type: "checkbox" });
    split.onchange = function () { stage.classList.toggle("split", split.checked); };
    var msg = h("p", { class: "err", hidden: true }), pr = progressBox();
    var btnCam = h("button", { class: "btn", type: "button" }, "Start camera"), btnRec = h("button", { class: "btn primary", type: "button", disabled: true }, "Record");
    var fileIn = h("input", { type: "file", accept: "video/*", hidden: true }), btnUp = h("label", { class: "btn" }, "Upload a video", fileIn);
    function showErr(m) { msg.textContent = m || ""; msg.hidden = !m; }

    btnCam.onclick = async function () {
      showErr("");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showErr("Camera needs a secure (https) page. Upload a video instead."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 1280 } }, audio: { echoCancellation: true } });
        cam.srcObject = stream; mode = "live"; btnRec.disabled = false; btnCam.textContent = "Camera on"; btnCam.disabled = true;
      } catch (e) { showErr("Could not open the camera or microphone. Allow access in your browser, or upload a video instead."); }
    };
    function pickMime() { var c = ["video/mp4;codecs=avc1,mp4a.40.2", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]; return c.filter(function (t) { return window.MediaRecorder && MediaRecorder.isTypeSupported(t); })[0] || ""; }
    function stopRec() { if (recorder && recorder.state === "recording") recorder.stop(); ghost.pause(); clearInterval(timer); }
    btnRec.onclick = async function () {
      if (mode === "recording") { stopRec(); return; }
      if (!stream || !window.MediaRecorder) { showErr("Recording is not supported in this browser. Upload a video instead."); return; }
      btnRec.disabled = true;
      for (var n = 3; n >= 1; n--) { overlay.className = "count"; overlay.textContent = String(n); await sleep(900); }
      overlay.className = ""; overlay.textContent = "";
      chunks = []; var mt = pickMime(); recorder = new MediaRecorder(stream, mt ? { mimeType: mt, videoBitsPerSecond: 2500000 } : undefined);
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = function () { mode = "review"; recDur = (Date.now() - startedAt) / 1000; blob = new Blob(chunks, { type: (recorder.mimeType || mt || "video/webm").split(";")[0] }); showReview(); };
      mode = "recording"; startedAt = Date.now(); recorder.start(250);
      ghost.muted = !sound.checked; ghost.currentTime = 0; try { await ghost.play(); } catch (e) {}
      ghost.onended = function () { setTimeout(stopRec, 400); };
      var dot = h("div", { class: "recdot" }, "REC 0:00"); stage.append(dot);
      timer = setInterval(function () { var s = Math.floor((Date.now() - startedAt) / 1000); dot.textContent = "REC " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); if (s >= 90) stopRec(); }, 500);
      btnRec.textContent = "Stop"; btnRec.disabled = false;
      recorder.addEventListener("stop", function () { dot.remove(); btnRec.textContent = "Record"; });
    };
    fileIn.onchange = function () { var f = fileIn.files && fileIn.files[0]; fileIn.value = ""; if (!f) return; blob = f; recDur = 0; mode = "review"; showReview(); };

    var review = h("section", { class: "panel", hidden: true }), result = h("section", { class: "panel", hidden: true });
    function showReview() {
      review.hidden = false; result.hidden = true; review.textContent = "";
      var url = URL.createObjectURL(blob);
      var again = h("button", { class: "btn", type: "button", onclick: function () { review.hidden = true; blob = null; btnRec.textContent = "Record"; btnRec.disabled = !stream; } }, "Retake");
      var post = h("button", { class: "btn primary", type: "button" }, "Score and post");
      post.onclick = async function () {
        try {
          await ensureAuth(); post.disabled = again.disabled = true; showErr("");
          pr.say("Analysing your video"); var feats = await extractFeatures(blob, recDur);
          if (!feats.frames.length && !feats.env.length) throw new Error("Could not read that video. Try an MP4 or WebM with clear sound.");
          var up = await xhrUpload(blob, function (p) { pr.prog("Uploading", p); }); pr.say("Comparing with the original");
          var j = await api("/takes", { method: "POST", body: { clipId: clip.id, file: up.file, beat: beatId || undefined, features: feats } });
          pr.clear(); await loadMe(); showResult(j.take);
        } catch (e) { if (e.message !== "cancelled") showErr(e.message); pr.clear(); post.disabled = again.disabled = false; }
      };
      review.append(h("h3", null, "Review your take"), h("video", { class: "player", src: url, controls: true, playsinline: true }), h("div", { class: "row" }, post, again), pr.box);
    }
    function showResult(t) {
      review.hidden = true; result.hidden = false; result.textContent = "";
      var verdict = t.rank >= 90 ? "Nearly frame for frame." : t.rank >= 70 ? "Strong recreation." : t.rank >= 45 ? "Good start. Tighten it up." : "Keep trying. Match the framing first.";
      var row = h("div", { class: "row" }, h("span", { class: "pct" }, t.aiScore + "%"), h("strong", null, verdict));
      var parts = [row, scoreChips(t)];
      if (t.tip) parts.push(h("p", null, t.tip));
      parts.push(h("p", { class: "hint" }, t.method === "basic" ? "Scored with basic frame matching. The server owner can switch on AI scene analysis." : "AI estimate from sampled frames and the rhythm of your voice. Others can add a public score."));
      if (beat) parts.push(h("p", { class: "banner" }, t.aiScore > beat.aiScore ? "You beat " + beat.owner.name + "'s " + beat.aiScore + "%!" : "Not yet. " + beat.owner.name + " scored " + beat.aiScore + "%."));
      parts.push(h("div", { class: "row" },
        h("a", { class: "btn primary", href: t.video, download: "dialogue-duel-" + t.aiScore + "pct." + extOf(blob) }, "Download video"),
        h("button", { class: "btn", type: "button", onclick: function () { shareTake(t, clip.title); } }, "Share"),
        h("button", { class: "btn", type: "button", onclick: function () { copy(location.origin + "/#/recreate/" + clip.id + "?beat=" + t.id); } }, "Challenge a friend"),
        h("a", { class: "btn", href: "#/clip/" + clip.id }, "See the leaderboard")));
      parts.forEach(function (n) { result.append(n); });
      result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    root.append(stage,
      h("section", { class: "panel" },
        h("div", { class: "row" }, btnCam, btnRec, btnUp),
        h("label", { class: "field" }, "Ghost overlay of the original", opacity),
        h("label", { class: "check" }, sound, h("span", null, "Play the original's sound while I record (use headphones)")),
        h("label", { class: "check" }, split, h("span", null, "Side by side instead of overlay")),
        h("p", { class: "hint" }, "Line up with the ghost, tap Record, and the original plays silently as your cue. Or record elsewhere and upload."), msg),
      review, result);
    mount(root);
    teardown = function () { clearInterval(timer); try { if (recorder && recorder.state === "recording") recorder.stop(); } catch (e) {} if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); };
  }

  /* ---------- router ---------- */
  async function route() {
    var my = ++routeId; if (teardown) { teardown(); teardown = null; }
    var raw = location.hash.replace(/^#/, "") || "/", qi = raw.indexOf("?"), path = qi >= 0 ? raw.slice(0, qi) : raw, q = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
    var p = path.split("/").filter(Boolean);
    try {
      if (!p.length) await viewHome();
      else if (p[0] === "clips") await viewClips();
      else if (p[0] === "clip" && p[1]) await viewClip(p[1]);
      else if (p[0] === "new") await viewNew();
      else if (p[0] === "me") await viewMe();
      else if (p[0] === "u" && p[1]) await viewUser(decodeURIComponent(p[1]));
      else if (p[0] === "recreate" && p[1]) await viewRecreate(p[1], q.get("beat"), my);
      else await viewHome();
    } catch (e) { if (my === routeId) mount(h("div", { class: "panel empty" }, h("h3", null, "Something went wrong"), h("p", null, e.message || "Try again."), h("a", { class: "btn", href: "#/" }, "Go home"))); }
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  loadMe().then(route);
})();
