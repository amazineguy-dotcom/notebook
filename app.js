(function () {
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), listEl = $("note-list"), tagBar = $("tag-bar");
  var each = function (sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); };
  var editor = $("editor"), blank = $("blank"), statusEl = $("status");
  var titleEl = $("note-title"), tagsEl = $("note-tags"), bodyEl = $("note-body");
  var pinEl = $("pin"), lockEl = $("lock"), confirmEl = $("confirm"), relockEl = $("relock");

  var LS_KEY = "notebook.notes.v1", LOCK_KEY = "notebook.lock.v1", THEME_KEY = "notebook.theme", FOLDER_KEY = "notebook.folder.v1";
  var ITER = 210000, CHECK = "notebook-lock-check", RELOCK_MS = 60000;
  var notes = new Map();   // id -> {id,title,body,updated,pinned,tags,locked,enc,ok,dirty}
  var currentId = null, query = "", activeTag = "", timer = null;
  var lockCfg = null, sessionPw = null, keys = {}, hiddenAt = 0;
  // A note that has sub-notes acts as a folder; folderId is the folder the list is showing (null = top level).
  var folderId = lsGet(FOLDER_KEY) || null;
  function saveFolder() { if (folderId) lsSet(FOLDER_KEY, folderId); else try { localStorage.removeItem(FOLDER_KEY); } catch (e) {} }

  function newId() { return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function normTags(s) {
    var out = [];
    String(s).split(/[\s,，、#＃]+/).forEach(function (t) {
      t = t.trim().slice(0, 20);
      if (t && out.indexOf(t) === -1 && out.length < 20) out.push(t);
    });
    return out;
  }
  function validEnc(e) {
    return !!e && typeof e.salt === "string" && typeof e.iv === "string" && typeof e.ct === "string";
  }
  function validCfg(c) {
    return !!c && typeof c.salt === "string" && validEnc({ salt: c.salt, iv: c.check && c.check.iv, ct: c.check && c.check.ct });
  }
  function clean(id, r) {
    r = r || {};
    var locked = !!r.locked && validEnc(r.enc);
    return {
      // parent/created are kept (not shown) so notes made while sub-notes existed keep their structure
      id: id, parent: typeof r.parent === "string" ? r.parent : null, created: Number(r.created) || 0,
      updated: Number(r.updated) || 0, pinned: !!r.pinned,
      tags: Array.isArray(r.tags) ? normTags(r.tags.join(" ")) : [],
      locked: locked, enc: locked ? { salt: r.enc.salt, iv: r.enc.iv, ct: r.enc.ct } : null,
      title: locked ? "" : String(r.title || ""), body: locked ? "" : String(r.body || ""),
      ok: !locked, dirty: false
    };
  }
  function fmtDate(ms) {
    if (!ms) return "";
    var d = new Date(ms), n = new Date();
    var p = function (x) { return String(x).padStart(2, "0"); };
    if (d.toDateString() === n.toDateString()) return p(d.getHours()) + ":" + p(d.getMinutes());
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + "/" + d.getDate();
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }

  /* ---- crypto (PBKDF2 + AES-GCM) ---- */
  var te = new TextEncoder(), td = new TextDecoder();
  function b64(buf) { var s = "", a = new Uint8Array(buf); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  async function deriveKey(pw, salt) {
    var base = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: unb64(salt), iterations: ITER, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encryptObj(key, obj) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, te.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function decryptObj(key, e) {
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv) }, key, unb64(e.ct));
    return JSON.parse(td.decode(pt));
  }
  function isUnlocked() { return sessionPw !== null; }
  async function keyFor(salt) {
    if (!keys[salt]) keys[salt] = await deriveKey(sessionPw, salt);
    return keys[salt];
  }
  async function makeLockCfg(pw) {
    var salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    var key = await deriveKey(pw, salt);
    return { cfg: { salt: salt, check: await encryptObj(key, CHECK) }, key: key };
  }
  async function verify(pw, cfg) {
    try {
      var k = await deriveKey(pw, cfg.salt);
      return (await decryptObj(k, cfg.check)) === CHECK ? k : null;
    } catch (e) { return null; }
  }
  function startSession(pw, salt, key) { sessionPw = pw; keys = {}; keys[salt] = key; }
  async function decryptAll() {
    for (var n of notes.values()) {
      if (!n.locked || n.ok) continue;
      try {
        var v = await decryptObj(await keyFor(n.enc.salt), n.enc);
        n.title = String(v.title || ""); n.body = String(v.body || ""); n.ok = true;
      } catch (e) { /* encrypted with a different password */ }
    }
  }
  async function unlockWith(pw) {
    var k = await verify(pw, lockCfg);
    if (!k) return false;
    startSession(pw, lockCfg.salt, k);
    await decryptAll(); renderAll();
    return true;
  }
  async function relock() {
    if (!isUnlocked()) return;
    await persist();
    sessionPw = null; keys = {};
    notes.forEach(function (n) { if (n.locked) { n.title = ""; n.body = ""; n.ok = false; n.dirty = false; } });
    var cur = notes.get(currentId);
    if (cur && cur.locked) currentId = null;
    renderAll(); note("已鎖上。");
  }

  /* ---- storage ---- */
  function dump() {
    var out = {};
    notes.forEach(function (n) {
      var o = { updated: n.updated, pinned: n.pinned, tags: n.tags };
      if (n.parent) o.parent = n.parent;
      if (n.created) o.created = n.created;
      if (n.locked && n.enc) { o.locked = true; o.enc = n.enc; o.title = ""; o.body = ""; }
      else { o.title = n.title; o.body = n.body; }
      out[n.id] = o;
    });
    return out;
  }
  async function doPersist() {
    try {
      if (isUnlocked() && lockCfg) {
        var key = await keyFor(lockCfg.salt);
        for (var n of notes.values()) {
          if (!(n.locked && n.ok && n.dirty)) continue;
          n.dirty = false;
          var e = await encryptObj(key, { title: n.title, body: n.body });
          n.enc = { salt: lockCfg.salt, iv: e.iv, ct: e.ct };
        }
      }
      localStorage.setItem(LS_KEY, JSON.stringify(dump()));
      return true;
    } catch (e) { return false; }
  }
  var saving = Promise.resolve(true);
  function persist() {
    clearTimeout(timer); timer = null;
    saving = saving.then(doPersist, doPersist);
    return saving;
  }
  function load() {
    try {
      var raw = JSON.parse(lsGet(LS_KEY) || "{}");
      Object.keys(raw).forEach(function (id) { notes.set(id, clean(id, raw[id])); });
    } catch (e) {}
    try {
      var c = JSON.parse(lsGet(LOCK_KEY) || "null");
      if (validCfg(c)) lockCfg = { salt: c.salt, check: { iv: c.check.iv, ct: c.check.ct } };
    } catch (e) {}
  }
  function setStatus(text, isErr) { statusEl.textContent = text || ""; statusEl.classList.toggle("err", !!isErr); }
  async function saveNow() {
    var ok = await persist();
    var n = notes.get(currentId);
    if (ok) setStatus(n ? "已儲存 " + fmtDate(n.updated) : "");
    else setStatus("儲存失敗，手機空間可能不足。請先匯出備份。", true);
  }
  function saveSoon() { setStatus("儲存中…"); clearTimeout(timer); timer = setTimeout(saveNow, 400); }
  function markEdited(n) { n.updated = Date.now(); if (n.locked) n.dirty = true; saveSoon(); }

  /* ---- theme ---- */
  var themeMetas = Array.prototype.slice.call(document.querySelectorAll('meta[name="theme-color"]'));
  var themeOrig = themeMetas.map(function (m) { return m.content; });
  var THEME_COLOR = { light: "#E6EBEA", dark: "#141B22" };
  function applyTheme(pref) {
    if (pref !== "light" && pref !== "dark") pref = "auto";
    if (pref === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", pref);
    themeMetas.forEach(function (m, i) { m.content = pref === "auto" ? themeOrig[i] : THEME_COLOR[pref]; });
    document.querySelectorAll("[data-theme-opt]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-theme-opt") === pref ? "true" : "false");
    });
  }
  document.querySelectorAll("[data-theme-opt]").forEach(function (b) {
    b.addEventListener("click", function () {
      var pref = b.getAttribute("data-theme-opt");
      lsSet(THEME_KEY, pref); applyTheme(pref);
    });
  });

  /* ---- render ---- */
  function hidden(n) { return n.locked && !n.ok; }
  function noteName(n) { return hidden(n) ? "上鎖的筆記" : (n.title.trim() || "未命名筆記"); }
  function parentOf(n) { return n.parent && n.parent !== n.id && notes.has(n.parent) ? notes.get(n.parent) : null; }
  function ancestors(n) {
    var out = [], seen = {}, p = parentOf(n);
    seen[n.id] = true;
    while (p && !seen[p.id]) { seen[p.id] = true; out.unshift(p); p = parentOf(p); }
    return out;
  }
  function isRoot(n) {
    var seen = {}, p = parentOf(n);
    seen[n.id] = true;
    while (p) { if (seen[p.id]) return true; seen[p.id] = true; p = parentOf(p); }
    return !parentOf(n);
  }
  function levelOf(n) { return isRoot(n) ? null : n.parent; }
  function childrenOf(id) {
    var arr = [];
    notes.forEach(function (c) { if (c.parent === id && c.id !== id && !isRoot(c)) arr.push(c); });
    return arr;
  }
  function descendants(id) {
    var out = [], seen = {}, stack = [id];
    seen[id] = true;
    while (stack.length) {
      childrenOf(stack.pop()).forEach(function (c) {
        if (seen[c.id]) return;
        seen[c.id] = true; out.push(c); stack.push(c.id);
      });
    }
    return out;
  }
  function flatMode() { return !!(query.trim() || activeTag); }
  function visibleNotes() {
    var q = query.trim().toLowerCase(), arr = [], flat = flatMode();
    notes.forEach(function (n) {
      if (!flat && levelOf(n) !== folderId) return;
      if (activeTag && n.tags.indexOf(activeTag) === -1) return;
      if (q) {
        var hay = n.tags.join(" ") + (hidden(n) ? "" : "\n" + n.title + "\n" + n.body);
        if (hay.toLowerCase().indexOf(q) === -1) return;
      }
      arr.push(n);
    });
    arr.sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updated - a.updated;
    });
    return arr;
  }
  function renderTags() {
    var counts = {};
    notes.forEach(function (n) { n.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
    var all = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b, "zh-Hant"); });
    if (activeTag && !counts[activeTag]) activeTag = "";
    tagBar.textContent = "";
    tagBar.hidden = !all.length;
    [""].concat(all).forEach(function (t) {
      if (!all.length) return;
      var b = document.createElement("button");
      b.type = "button"; b.className = "chip";
      b.textContent = t ? "#" + t : "全部";
      b.setAttribute("aria-pressed", t === activeTag ? "true" : "false");
      b.addEventListener("click", function () { activeTag = t; renderTags(); renderList(); });
      tagBar.appendChild(b);
    });
  }
  function badge(text) { var s = document.createElement("span"); s.className = "item-badge"; s.textContent = text; return s; }
  function renderFolderBar() {
    var f = folderId && notes.get(folderId), show = !!f && !flatMode();
    $("folder-bar").hidden = !show;
    if (!show) return;
    var path = ancestors(f);
    $("folder-path").textContent = ["筆記"].concat(path.map(noteName)).join(" › ") + " ›";
    $("folder-title").textContent = noteName(f);
  }
  function previewOf(n) {
    return hidden(n) ? "輸入密碼後才會顯示內容" : (n.body.replace(/\s+/g, " ").trim().slice(0, 80) || "（沒有內容）");
  }
  function itemFor(n, withPath) {
    var li = document.createElement("li"), b = document.createElement("button");
    var kids = childrenOf(n.id);
    b.type = "button"; b.className = "item";
    if (n.id === currentId) b.setAttribute("aria-current", "true");
    var path = withPath ? ancestors(n) : [];
    if (path.length) {
      var pp = document.createElement("div"); pp.className = "item-path";
      pp.textContent = path.map(noteName).join(" › ") + " ›";
      b.appendChild(pp);
    }
    var top = document.createElement("div"); top.className = "item-top";
    var t = document.createElement("span"); t.className = "item-title"; t.textContent = noteName(n);
    top.appendChild(t);
    if (n.locked) top.appendChild(badge(n.ok ? "已解鎖" : "上鎖"));
    if (n.pinned) top.appendChild(badge("釘選"));
    if (kids.length) {
      var c = document.createElement("span"); c.className = "item-count"; c.textContent = kids.length + " 則 ›"; top.appendChild(c);
    } else {
      var d = document.createElement("span"); d.className = "item-date"; d.textContent = fmtDate(n.updated); top.appendChild(d);
    }
    var pv = document.createElement("div"); pv.className = "item-preview";
    pv.textContent = kids.length ? kids.map(noteName).slice(0, 4).join("、") + (kids.length > 4 ? "…" : "") : previewOf(n);
    b.appendChild(top); b.appendChild(pv);
    if (n.tags.length) {
      var tg = document.createElement("div"); tg.className = "item-tags";
      tg.textContent = n.tags.map(function (x) { return "#" + x; }).join(" ");
      b.appendChild(tg);
    }
    b.addEventListener("click", function () { openItem(n); });
    li.appendChild(b);
    return li;
  }
  function renderList() {
    if (folderId && (!notes.has(folderId) || !childrenOf(folderId).length)) { folderId = folderId && notes.has(folderId) ? levelOf(notes.get(folderId)) : null; saveFolder(); }
    renderFolderBar();
    var flat = flatMode(), arr = visibleNotes(), f = folderId && notes.get(folderId);
    listEl.textContent = "";
    if (!flat && f) {
      // the folder's own page, always first so its text is never lost and its title can be edited
      var li = document.createElement("li"), b = document.createElement("button");
      li.className = "self-row"; b.type = "button"; b.className = "item";
      if (f.id === currentId) b.setAttribute("aria-current", "true");
      var top = document.createElement("div"); top.className = "item-top";
      var t = document.createElement("span"); t.className = "item-title"; t.textContent = noteName(f) + " 的內容";
      top.appendChild(t);
      var d = document.createElement("span"); d.className = "item-date"; d.textContent = "›"; top.appendChild(d);
      var pv = document.createElement("div"); pv.className = "item-preview";
      pv.textContent = hidden(f) ? "輸入密碼後才會顯示內容" : (f.body.replace(/\s+/g, " ").trim().slice(0, 80) || "還沒有內容，點一下可以寫");
      b.appendChild(top); b.appendChild(pv);
      b.addEventListener("click", function () { openNote(f.id, true); });
      li.appendChild(b); listEl.appendChild(li);
    }
    if (!arr.length) {
      var e = document.createElement("li"); e.className = "empty";
      e.textContent = query.trim() ? "找不到符合「" + query.trim() + "」的筆記。"
        : activeTag ? "「#" + activeTag + "」標籤下沒有筆記。"
        : "還沒有筆記。按「＋ 新筆記」寫下第一則，內容會自動儲存。";
      listEl.appendChild(e); return;
    }
    arr.forEach(function (n) { listEl.appendChild(itemFor(n, flat)); });
  }
  function renderEditor() {
    var n = currentId && notes.get(currentId);
    if (n && hidden(n)) { currentId = null; n = null; }
    var open = !!n;
    editor.hidden = !open; blank.hidden = open;
    app.classList.toggle("editing", open);
    confirmEl.hidden = true;
    if (!open) return;
    if (titleEl.value !== n.title) titleEl.value = n.title;
    if (bodyEl.value !== n.body) bodyEl.value = n.body;
    var tv = n.tags.join(" ");
    if (document.activeElement !== tagsEl && tagsEl.value !== tv) tagsEl.value = tv;
    pinEl.setAttribute("aria-pressed", n.pinned ? "true" : "false");
    pinEl.textContent = n.pinned ? "已釘選" : "釘選";
    lockEl.setAttribute("aria-pressed", n.locked ? "true" : "false");
    lockEl.textContent = n.locked ? "解除上鎖" : "上鎖";
    pinEl.textContent = n.pinned ? "取消釘選" : "釘選";
    renderCrumbs(n);
    if (!timer) setStatus(n.updated ? "已儲存 " + fmtDate(n.updated) : "");
  }
  function renderCrumbs(n) {
    var box = $("crumbs"), path = ancestors(n);
    box.textContent = ""; box.hidden = !path.length;
    path.forEach(function (p) {
      var b = document.createElement("button");
      b.type = "button"; b.textContent = noteName(p);
      b.addEventListener("click", function () { enterFolder(p.id).then(function (ok) { if (ok) closeNote(); }); });
      box.appendChild(b);
      var sep = document.createElement("span"); sep.textContent = "›"; sep.setAttribute("aria-hidden", "true");
      box.appendChild(sep);
    });
  }
  function renderLockUi() {
    var unlocked = isUnlocked(), anyLocked = false;
    notes.forEach(function (n) { if (n.locked) anyLocked = true; });
    relockEl.hidden = !(unlocked && anyLocked);
    $("lock-state").textContent = !lockCfg ? "還沒設定。第一次在筆記裡按「上鎖」時會請你設定。"
      : unlocked ? "已設定，目前已解鎖。離開 App 超過 1 分鐘會自動鎖上。"
      : "已設定，上鎖的筆記目前是鎖住的。";
    $("lock-set").hidden = !!lockCfg;
    $("lock-change").hidden = !lockCfg;
    $("lock-now").hidden = !unlocked;
  }
  function renderAll() { renderTags(); renderList(); renderEditor(); renderLockUi(); }

  /* ---- dialogs ---- */
  var modal = $("modal"), modalOpts = null, modalBusy = false;
  function ask(opts) {
    modalOpts = opts;
    $("modal-title").textContent = opts.title;
    $("modal-msg").textContent = opts.msg || ""; $("modal-msg").hidden = !opts.msg;
    $("modal-err").textContent = "";
    $("modal-ok").textContent = opts.ok || "確定";
    var box = $("modal-fields"); box.textContent = "";
    opts.fields.forEach(function (f) {
      var l = document.createElement("label"); l.className = "field";
      var s = document.createElement("span"); s.textContent = f.label;
      var inp = document.createElement("input");
      inp.type = "password"; inp.autocomplete = f.ac || "current-password";
      l.appendChild(s); l.appendChild(inp); box.appendChild(l);
    });
    modal.hidden = false;
    var first = box.querySelector("input"); if (first) first.focus();
  }
  function closeModal(cancelled) {
    var o = modalOpts;
    modal.hidden = true; modalOpts = null; $("modal-fields").textContent = "";
    if (cancelled && o && o.onCancel) o.onCancel();
  }
  $("modal-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!modalOpts || modalBusy) return;
    var vals = Array.prototype.map.call($("modal-fields").querySelectorAll("input"), function (i) { return i.value; });
    modalBusy = true; $("modal-ok").disabled = true; $("modal-err").textContent = "處理中…";
    var err;
    try { err = await modalOpts.onOk(vals); } catch (x) { err = "發生錯誤：" + ((x && x.message) || x); }
    modalBusy = false; $("modal-ok").disabled = false;
    if (err) { $("modal-err").textContent = err; return; }
    closeModal(false);
  });
  $("modal-cancel").addEventListener("click", function () { if (!modalBusy) closeModal(true); });

  function setPasswordDialog(resolve) {
    ask({
      title: "設定上鎖密碼", ok: "設定",
      msg: "上鎖的筆記會用這組密碼加密。忘記密碼就再也打不開，沒有任何方法救回，請務必記住。",
      fields: [{ label: "密碼（至少 4 個字）", ac: "new-password" }, { label: "再輸入一次", ac: "new-password" }],
      onOk: async function (v) {
        if (v[0].length < 4) return "密碼至少要 4 個字。";
        if (v[0] !== v[1]) return "兩次輸入的密碼不一樣。";
        var m = await makeLockCfg(v[0]);
        if (!lsSet(LOCK_KEY, JSON.stringify(m.cfg))) return "儲存失敗，手機空間可能不足。";
        lockCfg = m.cfg; startSession(v[0], m.cfg.salt, m.key);
        await decryptAll(); renderAll(); resolve(true);
      },
      onCancel: function () { resolve(false); }
    });
  }
  function ensureUnlocked() {
    if (isUnlocked()) return Promise.resolve(true);
    return new Promise(function (resolve) {
      if (!lockCfg) { setPasswordDialog(resolve); return; }
      ask({
        title: "輸入密碼", ok: "解鎖", msg: "輸入上鎖密碼，打開上鎖的筆記。",
        fields: [{ label: "密碼" }],
        onOk: async function (v) {
          if (!(await unlockWith(v[0]))) return "密碼不對。";
          resolve(true);
        },
        onCancel: function () { resolve(false); }
      });
    });
  }
  function changePasswordDialog() {
    ask({
      title: "更改密碼", ok: "更改",
      msg: "所有上鎖的筆記會改用新密碼加密。之前匯出的備份檔仍然要用舊密碼打開。",
      fields: [{ label: "目前密碼" }, { label: "新密碼（至少 4 個字）", ac: "new-password" }, { label: "再輸入一次新密碼", ac: "new-password" }],
      onOk: async function (v) {
        if (v[1].length < 4) return "新密碼至少要 4 個字。";
        if (v[1] !== v[2]) return "兩次輸入的新密碼不一樣。";
        if (!(await unlockWith(v[0]))) return "目前密碼不對。";
        var stuck = 0;
        notes.forEach(function (n) { if (hidden(n)) stuck++; });
        if (stuck) return "有 " + stuck + " 則上鎖筆記是用別的密碼加密的（來自其他備份），請先用那組密碼解除上鎖再改。";
        await persist();
        var m = await makeLockCfg(v[1]);
        if (!lsSet(LOCK_KEY, JSON.stringify(m.cfg))) return "儲存失敗，手機空間可能不足。";
        lockCfg = m.cfg; startSession(v[1], m.cfg.salt, m.key);
        notes.forEach(function (n) { if (n.locked) n.dirty = true; });
        if (!(await persist())) return "儲存失敗，手機空間可能不足。";
        renderAll(); note("密碼已更改。");
      }
    });
  }

  /* ---- settings ---- */
  var settings = $("settings");
  each(".open-settings", function (b) {
    b.addEventListener("click", function () { renderLockUi(); settings.hidden = false; $("settings-close").focus(); });
  });
  $("settings-close").addEventListener("click", function () { settings.hidden = true; });
  $("lock-set").addEventListener("click", function () { ensureUnlocked(); });
  $("lock-change").addEventListener("click", changePasswordDialog);
  $("lock-now").addEventListener("click", function () { relock(); });
  relockEl.addEventListener("click", function () { relock(); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!modal.hidden) { if (!modalBusy) closeModal(true); }
    else if (!noteMenu.hidden) noteMenu.hidden = true;
    else if (!settings.hidden) settings.hidden = true;
  });

  /* ---- actions ---- */
  async function unlockFor(n) {
    if (!(await ensureUnlocked())) return false;
    if (hidden(n)) { note("這則筆記是用別的密碼加密的（可能來自其他備份），目前打不開。"); return false; }
    return true;
  }
  // keepFolder: open a folder's own page without leaving that folder in the list
  async function openNote(id, keepFolder) {
    var n = notes.get(id); if (!n) return;
    if (hidden(n) && !(await unlockFor(n))) return;   // stays synchronous when no password is needed
    if (!keepFolder) { folderId = levelOf(n); saveFolder(); }
    currentId = id; renderList(); renderEditor();
  }
  async function enterFolder(id) {
    var n = id && notes.get(id);
    if (n && hidden(n) && !(await unlockFor(n))) return false;
    folderId = n ? id : null; saveFolder();
    if (flatMode()) { query = ""; $("search").value = ""; activeTag = ""; renderTags(); }
    renderList(); listEl.scrollTop = 0;
    return true;
  }
  function openItem(n) { if (childrenOf(n.id).length) enterFolder(n.id); else openNote(n.id); }
  function createNote(parent, tags) {
    var now = Date.now(), n = clean(newId(), { updated: now, created: now, parent: parent, tags: tags });
    notes.set(n.id, n);
    openNote(n.id); saveSoon(); titleEl.focus();
  }
  $("folder-up").addEventListener("click", function () {
    var f = notes.get(folderId);
    enterFolder(f ? levelOf(f) : null);
  });
  function closeNote() { if (timer) saveNow(); currentId = null; renderList(); renderEditor(); }

  $("new-note").addEventListener("click", function () {
    var tags = activeTag ? [activeTag] : [];
    if (flatMode()) { query = ""; $("search").value = ""; }
    createNote(folderId && notes.has(folderId) ? folderId : null, tags);
  });
  // "+ New note" inside a note's page: adds a sub-note, which turns that note into a folder
  $("new-child").addEventListener("click", function () {
    if (!notes.get(currentId)) return;
    if (timer) saveNow();
    createNote(currentId, []);
  });
  var noteMenu = $("note-menu");
  $("more").addEventListener("click", function () { if (notes.get(currentId)) { noteMenu.hidden = false; pinEl.focus(); } });
  $("menu-cancel").addEventListener("click", function () { noteMenu.hidden = true; });
  noteMenu.addEventListener("click", function (e) { if (e.target === noteMenu || e.target.tagName === "BUTTON") noteMenu.hidden = true; });
  function onEdit() {
    var n = notes.get(currentId); if (!n) return;
    n.title = titleEl.value; n.body = bodyEl.value;
    markEdited(n); renderList();
  }
  function onTags(e) {
    if (e && e.isComposing) return;
    var n = notes.get(currentId); if (!n) return;
    n.tags = normTags(tagsEl.value);
    markEdited(n); renderTags(); renderList();
  }
  titleEl.addEventListener("input", onEdit);
  bodyEl.addEventListener("input", onEdit);
  tagsEl.addEventListener("input", onTags);
  tagsEl.addEventListener("compositionend", function () { onTags(); });
  tagsEl.addEventListener("blur", function () {
    var n = notes.get(currentId); if (n) tagsEl.value = n.tags.join(" ");
  });
  titleEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); tagsEl.focus(); } });
  tagsEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); bodyEl.focus(); } });
  pinEl.addEventListener("click", function () {
    var n = notes.get(currentId); if (!n) return;
    n.pinned = !n.pinned; saveNow(); renderList(); renderEditor();
  });
  lockEl.addEventListener("click", async function () {
    var n = notes.get(currentId); if (!n) return;
    if (n.locked) {
      n.locked = false; n.enc = null; n.dirty = false;
      await saveNow(); renderAll(); setStatus("已解除上鎖，這則筆記不再加密");
      return;
    }
    if (!(await ensureUnlocked())) return;
    n = notes.get(currentId); if (!n) return;
    n.locked = true; n.ok = true; n.dirty = true;
    await saveNow(); renderAll(); setStatus("已上鎖");
  });
  $("del").addEventListener("click", function () {
    var k = currentId ? descendants(currentId).length : 0;
    $("confirm-text").textContent = k ? "刪除這則筆記和底下 " + k + " 則筆記？刪除後無法復原。" : "刪除這則筆記？刪除後無法復原。";
    confirmEl.hidden = false;
  });
  $("del-no").addEventListener("click", function () { confirmEl.hidden = true; });
  $("del-yes").addEventListener("click", function () {
    var n = notes.get(currentId); if (!n) return;
    var gone = {};
    gone[n.id] = true;
    descendants(n.id).forEach(function (c) { gone[c.id] = true; notes.delete(c.id); });
    notes.delete(n.id);
    if (folderId && gone[folderId]) { folderId = levelOf(n); saveFolder(); }
    currentId = null; persist(); renderAll();
  });
  $("back").addEventListener("click", closeNote);
  $("search").addEventListener("input", function (e) { query = e.target.value; renderList(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); if (timer) persist(); }
    else if (isUnlocked() && hiddenAt && Date.now() - hiddenAt > RELOCK_MS) relock();
  });
  window.addEventListener("pagehide", function () { if (timer) persist(); });

  /* ---- backup ---- */
  function note(text) { each(".js-store-note", function (el) { el.textContent = text; }); }
  async function exportBackup() {
    await persist();
    note("準備備份中…");
    var d = new Date(), p = function (x) { return String(x).padStart(2, "0"); };
    var name = "notebook-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + ".json";
    var payload = { app: "notebook", version: 5, exported: d.toISOString(), notes: dump() };
    if (lockCfg) payload.lock = lockCfg;
    if (window.Diary) {
      try { payload.diary = await window.Diary.exportData(); }
      catch (e) { note("匯出失敗：讀取日記照片時出錯。"); return; }
    }
    if (window.Books) payload.books = window.Books.exportData();
    if (window.Movies) payload.movies = window.Movies.exportData();
    var locked = 0;
    notes.forEach(function (n) { if (n.locked) locked++; });
    var summary = notes.size + " 則筆記" + (payload.diary ? "、" + Object.keys(payload.diary.entries).length + " 天日記（" + payload.diary.photos.length + " 張照片）" : "") +
      (payload.books ? "、" + Object.keys(payload.books.books).length + " 本書" : "") +
      (payload.movies ? "、" + Object.keys(payload.movies.movies).length + " 部電影" : "");
    var tail = locked ? "上鎖的 " + locked + " 則在備份裡仍是加密的，還原時要用同一組密碼。" : "";
    var file = new File([JSON.stringify(payload)], name, { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        note("已匯出 " + summary + "。" + tail); return;
      }
    } catch (e) { if (e && e.name === "AbortError") { note(""); return; } }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    note("已匯出 " + summary + "：" + name + "。" + tail);
  }
  each(".js-export", function (b) { b.addEventListener("click", exportBackup); });
  each(".js-import", function (b) { b.addEventListener("click", function () { $("import-file").click(); }); });
  $("import-file").addEventListener("change", async function (e) {
    var f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    note("匯入中…");
    try {
      var data = JSON.parse(await f.text());
      var hasDiary = !!(data && data.diary && typeof data.diary === "object");
      var hasBooks = !!(data && data.books && typeof data.books === "object");
      var hasMovies = !!(data && data.movies && typeof data.movies === "object");
      var src = data && data.notes && typeof data.notes === "object" ? data.notes : (hasDiary || hasBooks || hasMovies ? {} : null);
      if (!src) throw new Error("format");
      if (!lockCfg && validCfg(data.lock)) {
        var c = { salt: data.lock.salt, check: { iv: data.lock.check.iv, ct: data.lock.check.ct } };
        if (!lsSet(LOCK_KEY, JSON.stringify(c))) throw new Error("save");
        lockCfg = c;
      }
      var added = 0, updated = 0;
      Object.keys(src).forEach(function (id) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
        var n = clean(id, src[id]), old = notes.get(id);
        if (!old) { notes.set(id, n); added++; }
        else if (n.updated > old.updated) { notes.set(id, n); updated++; }
      });
      if (isUnlocked()) await decryptAll();
      if (!(await persist())) throw new Error("save");
      renderAll();
      var msg = "匯入完成：筆記新增 " + added + " 則，更新 " + updated + " 則";
      if (hasDiary && window.Diary) {
        var r = await window.Diary.importData(data.diary);
        if (r) msg += "；日記新增 " + r.added + " 天，更新 " + r.updated + " 天，照片 " + r.photos + " 張";
      }
      if (hasBooks && window.Books) {
        var rb = window.Books.importData(data.books);
        if (rb) msg += "；書籍新增 " + rb.added + " 本，更新 " + rb.updated + " 本";
      }
      if (hasMovies && window.Movies) {
        var rm = window.Movies.importData(data.movies);
        if (rm) msg += "；電影新增 " + rm.added + " 部，更新 " + rm.updated + " 部";
      }
      note(msg + "。");
    } catch (err) {
      note(err.message === "save" ? "匯入失敗：手機空間不足。" : "匯入失敗：這不是筆記本的備份檔。");
    }
  });

  load();
  applyTheme(lsGet(THEME_KEY));
  renderAll();
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () {}); }
  if ("serviceWorker" in navigator) { navigator.serviceWorker.register("sw.js").catch(function () {}); }
})();
