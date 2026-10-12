(function () {
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), statusEl = $("d-status"), bodyEl = $("d-body");

  var DIARY_KEY = "notebook.diary.v1", VIEW_KEY = "notebook.view";
  var WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var entries = {};   // "YYYY-MM-DD" -> {text, updated, photos:[id]}
  var viewY, viewM, selected = null, query = "", timer = null;
  var thumbCache = {}, viewerId = null, viewerUrl = null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function pad(x) { return String(x).padStart(2, "0"); }
  function keyOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseKey(k) { var p = k.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function validKey(k) { return /^\d{4}-\d{2}-\d{2}$/.test(k); }
  function longDate(k) {
    var d = parseKey(k), y = d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + "年";
    return y + (d.getMonth() + 1) + "月" + d.getDate() + "日 星期" + WEEK[d.getDay()];
  }
  function shortDate(k) {
    var d = parseKey(k), y = d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + "/";
    return y + (d.getMonth() + 1) + "/" + d.getDate() + "（" + WEEK[d.getDay()] + "）";
  }
  function newId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function cleanEntry(r) {
    r = r || {};
    return {
      text: String(r.text || ""), updated: Number(r.updated) || 0,
      photos: Array.isArray(r.photos) ? r.photos.filter(function (x) { return typeof x === "string" && ID_RE.test(x); }) : []
    };
  }

  /* ---- text storage (localStorage) ---- */
  function load() {
    try {
      var raw = JSON.parse(lsGet(DIARY_KEY) || "{}");
      Object.keys(raw).forEach(function (k) { if (validKey(k)) entries[k] = cleanEntry(raw[k]); });
    } catch (e) {}
  }
  function save() {
    clearTimeout(timer); timer = null;
    Object.keys(entries).forEach(function (k) {
      var e = entries[k];
      if (!e.text.trim() && !e.photos.length) delete entries[k];
    });
    return lsSet(DIARY_KEY, JSON.stringify(entries));
  }
  function getEntry(k) { return entries[k] || (entries[k] = { text: "", updated: Date.now(), photos: [] }); }
  function setStatus(text, isErr) { statusEl.textContent = text || ""; statusEl.classList.toggle("err", !!isErr); }
  function saveNow() {
    var ok = save();
    if (ok) setStatus(entries[selected] ? "已儲存" : "");
    else setStatus("儲存失敗，手機空間可能不足。", true);
    $("d-del").hidden = !entries[selected];
    renderCal(); renderList();
  }
  function saveSoon() { setStatus("儲存中…"); clearTimeout(timer); timer = setTimeout(saveNow, 400); }

  /* ---- photo storage (IndexedDB) ---- */
  var dbp = null;
  function db() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      var r = indexedDB.open("notebook", 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos", { keyPath: "id" }).createIndex("date", "date");
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { dbp = null; rej(r.error); };
    });
    return dbp;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction("photos", mode), r = fn(t.objectStore("photos"));
        t.oncomplete = function () { res(r ? r.result : undefined); };
        t.onerror = t.onabort = function () { rej(t.error || new Error("idb")); };
      });
    });
  }
  function putPhoto(rec) { return idb("readwrite", function (s) { return s.put(rec); }); }
  function getPhoto(id) { return idb("readonly", function (s) { return s.get(id); }); }
  function deletePhoto(id) {
    if (thumbCache[id]) { URL.revokeObjectURL(thumbCache[id]); delete thumbCache[id]; }
    return idb("readwrite", function (s) { return s.delete(id); }).catch(function () {});
  }
  function allPhotos() { return idb("readonly", function (s) { return s.getAll(); }); }
  function allPhotoIds() { return idb("readonly", function (s) { return s.getAllKeys(); }); }
  function usedIds() {
    var used = {};
    Object.keys(entries).forEach(function (k) { entries[k].photos.forEach(function (id) { used[id] = true; }); });
    return used;
  }
  async function gc() {
    var used = usedIds(), ids = await allPhotoIds();
    for (var i = 0; i < ids.length; i++) if (!used[ids[i]]) await deletePhoto(ids[i]);
  }
  async function thumbUrl(id) {
    if (thumbCache[id]) return thumbCache[id];
    var r = await getPhoto(id).catch(function () { return null; });
    if (!r) return null;
    if (!thumbCache[id]) thumbCache[id] = URL.createObjectURL(new Blob([r.thumb], { type: "image/jpeg" }));
    return thumbCache[id];
  }
  function setBg(el, id) {
    thumbUrl(id).then(function (u) {
      if (u) el.style.backgroundImage = 'url("' + u + '")'; else el.classList.add("missing");
    });
  }

  /* ---- image processing ---- */
  function loadImage(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () { res(im); setTimeout(function () { URL.revokeObjectURL(u); }, 0); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error("decode")); };
      im.src = u;
    });
  }
  function toJpeg(img, max, q) {
    var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    var g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return new Promise(function (res, rej) {
      c.toBlob(function (b) { if (b) res(b); else rej(new Error("encode")); }, "image/jpeg", q);
    });
  }
  function bufToDataUrl(buf, type) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(new Blob([buf], { type: type }));
    });
  }
  function dataUrlToBuf(s) {
    var b = atob(s.slice(s.indexOf(",") + 1)), a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a.buffer;
  }
  function isImageDataUrl(s) { return typeof s === "string" && /^data:image\/[a-z+.-]+;base64,/.test(s); }

  /* ---- render ---- */
  function matchSet() {
    var q = query.trim().toLowerCase();
    if (!q) return null;
    var hits = {};
    Object.keys(entries).forEach(function (k) { if (entries[k].text.toLowerCase().indexOf(q) !== -1) hits[k] = true; });
    return hits;
  }
  function renderCal() {
    $("d-month").textContent = viewY + "年" + (viewM + 1) + "月";
    var grid = $("d-grid"); grid.textContent = "";
    var first = new Date(viewY, viewM, 1).getDay(), days = new Date(viewY, viewM + 1, 0).getDate();
    var today = keyOf(new Date()), hits = matchSet();
    for (var i = 0; i < first; i++) { var s = document.createElement("span"); s.className = "day pad"; grid.appendChild(s); }
    for (var d = 1; d <= days; d++) {
      var k = viewY + "-" + pad(viewM + 1) + "-" + pad(d), e = entries[k];
      var b = document.createElement("button");
      b.type = "button"; b.className = "day"; b.setAttribute("data-key", k);
      var n = document.createElement("span"); n.className = "day-num"; n.textContent = d; b.appendChild(n);
      b.setAttribute("aria-label", longDate(k) + (e ? "，有日記" : ""));
      if (k === today) b.classList.add("today");
      if (k === selected) b.setAttribute("aria-current", "date");
      if (e && e.text.trim()) b.classList.add("has-text");
      if (hits && hits[k]) b.classList.add("match");
      if (e && e.photos.length) { b.classList.add("has-photo"); setBg(b, e.photos[0]); }
      b.addEventListener("click", function () { openDay(this.getAttribute("data-key")); });
      grid.appendChild(b);
    }
  }
  function snippet(text, q) {
    var flat = text.replace(/\s+/g, " ").trim();
    if (!q || flat.length <= 60) return flat.slice(0, 80);
    var i = flat.toLowerCase().indexOf(q), start = Math.max(0, i - 12);
    return (start ? "…" : "") + flat.slice(start, start + 80);
  }
  function renderList() {
    var q = query.trim().toLowerCase(), keys, title;
    if (q) {
      keys = Object.keys(entries).filter(function (k) { return entries[k].text.toLowerCase().indexOf(q) !== -1; });
      title = keys.length ? "找到 " + keys.length + " 天" : "找不到「" + query.trim() + "」的日記。";
    } else {
      var pre = viewY + "-" + pad(viewM + 1) + "-";
      keys = Object.keys(entries).filter(function (k) { return k.indexOf(pre) === 0; });
      title = keys.length ? "這個月寫了 " + keys.length + " 天" : "這個月還沒有日記。點日曆上的日期開始寫。";
    }
    keys.sort().reverse();
    $("d-list-title").textContent = title;
    var list = $("d-list"); list.textContent = "";
    keys.forEach(function (k) {
      var e = entries[k], li = document.createElement("li"), b = document.createElement("button");
      b.type = "button"; b.className = "item";
      if (k === selected) b.setAttribute("aria-current", "true");
      var top = document.createElement("div"); top.className = "item-top";
      var t = document.createElement("span"); t.className = "item-title"; t.textContent = shortDate(k); top.appendChild(t);
      if (e.photos.length) { var p = document.createElement("span"); p.className = "item-badge"; p.textContent = e.photos.length + " 張照片"; top.appendChild(p); }
      var pv = document.createElement("div"); pv.className = "item-preview";
      pv.textContent = snippet(e.text, q) || "（只有照片）";
      b.appendChild(top); b.appendChild(pv);
      b.addEventListener("click", function () { openDay(k); });
      li.appendChild(b); list.appendChild(li);
    });
  }
  function renderPhotos() {
    var box = $("d-photos"), add = $("d-add-photo");
    Array.prototype.slice.call(box.querySelectorAll(".photo")).forEach(function (x) { x.remove(); });
    var e = entries[selected];
    (e ? e.photos : []).forEach(function (id, i) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "photo"; b.setAttribute("aria-label", "查看第 " + (i + 1) + " 張照片");
      setBg(b, id);
      b.addEventListener("click", function () { openViewer(id); });
      box.insertBefore(b, add);
    });
  }
  function renderEditor() {
    var open = !!selected;
    $("d-editor").hidden = !open; $("d-blank").hidden = open;
    if (!open) return;
    var e = entries[selected], t = e ? e.text : "";
    $("d-date").textContent = longDate(selected);
    if (bodyEl.value !== t) bodyEl.value = t;
    $("d-confirm").hidden = true;
    $("d-del").hidden = !e;
    renderPhotos();
    if (!timer) setStatus(e ? "已儲存" : "");
  }
  function renderAll() { renderCal(); renderList(); renderEditor(); }

  /* ---- navigation ---- */
  function setView(v) {
    if (v !== "diary") v = "notes";
    app.setAttribute("data-view", v);
    lsSet(VIEW_KEY, v);
    document.querySelectorAll("[data-view-opt]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-view-opt") === v ? "true" : "false");
    });
    if (v === "diary") { renderCal(); renderList(); }
  }
  function openDay(k) {
    if (timer) saveNow();
    selected = k;
    var d = parseKey(k); viewY = d.getFullYear(); viewM = d.getMonth();
    renderAll();
    app.classList.add("diary-editing");
  }
  function closeDay() { if (timer) saveNow(); app.classList.remove("diary-editing"); renderCal(); renderList(); }
  function shiftMonth(n) {
    var d = new Date(viewY, viewM + n, 1); viewY = d.getFullYear(); viewM = d.getMonth();
    renderCal(); renderList();
  }

  document.querySelectorAll("[data-view-opt]").forEach(function (b) {
    b.addEventListener("click", function () { setView(b.getAttribute("data-view-opt")); });
  });
  $("d-prev").addEventListener("click", function () { shiftMonth(-1); });
  $("d-next").addEventListener("click", function () { shiftMonth(1); });
  $("d-today").addEventListener("click", function () { openDay(keyOf(new Date())); bodyEl.focus(); });
  $("d-back").addEventListener("click", closeDay);
  $("d-search").addEventListener("input", function (e) { query = e.target.value; renderCal(); renderList(); });
  bodyEl.addEventListener("input", function () {
    if (!selected) return;
    var e = getEntry(selected); e.text = bodyEl.value; e.updated = Date.now();
    saveSoon();
  });
  $("d-del").addEventListener("click", function () { $("d-confirm").hidden = false; });
  $("d-del-no").addEventListener("click", function () { $("d-confirm").hidden = true; });
  $("d-del-yes").addEventListener("click", function () {
    var e = entries[selected]; if (!e) return;
    var ids = e.photos.slice();
    delete entries[selected]; save();
    ids.forEach(deletePhoto);
    closeDay(); renderEditor();
  });

  /* ---- photos ---- */
  $("d-add-photo").addEventListener("click", function () { $("d-photo-file").click(); });
  $("d-photo-file").addEventListener("change", async function (ev) {
    var files = Array.prototype.slice.call(ev.target.files || []); ev.target.value = "";
    if (!files.length || !selected) return;
    var k = selected, done = 0, failed = 0;
    for (var i = 0; i < files.length; i++) {
      setStatus("處理照片 " + (i + 1) + "/" + files.length + "…");
      try {
        var img = await loadImage(files[i]);
        var full = await toJpeg(img, 1600, 0.82), thumb = await toJpeg(img, 360, 0.72);
        var id = newId();
        await putPhoto({
          id: id, date: k, type: "image/jpeg", w: img.naturalWidth, h: img.naturalHeight, added: Date.now(),
          full: await full.arrayBuffer(), thumb: await thumb.arrayBuffer()
        });
        var e = getEntry(k); e.photos.push(id); e.updated = Date.now();
        if (!save()) throw new Error("save");
        done++;
        if (selected === k) renderPhotos();
      } catch (err) { failed++; }
    }
    renderAll();
    if (failed) setStatus(failed + " 張照片加入失敗，可能是格式不支援或空間不足" + (done ? "（成功 " + done + " 張）" : ""), true);
    else setStatus("已加入 " + done + " 張照片");
  });

  async function openViewer(id) {
    var r = await getPhoto(id).catch(function () { return null; });
    if (!r) return;
    viewerId = id;
    viewerUrl = URL.createObjectURL(new Blob([r.full], { type: r.type || "image/jpeg" }));
    $("viewer-img").src = viewerUrl;
    $("viewer-del").textContent = "刪除這張"; $("viewer-del").removeAttribute("data-armed");
    $("viewer").hidden = false;
  }
  function closeViewer() {
    $("viewer").hidden = true;
    $("viewer-img").removeAttribute("src");
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null; viewerId = null;
  }
  $("viewer-close").addEventListener("click", closeViewer);
  $("viewer").addEventListener("click", function (e) { if (e.target === this) closeViewer(); });
  $("viewer-del").addEventListener("click", async function () {
    var btn = this;
    if (!btn.hasAttribute("data-armed")) { btn.setAttribute("data-armed", ""); btn.textContent = "確定刪除？"; return; }
    var id = viewerId;
    Object.keys(entries).forEach(function (k) {
      var e = entries[k], i = e.photos.indexOf(id);
      if (i > -1) { e.photos.splice(i, 1); e.updated = Date.now(); }
    });
    save();
    await deletePhoto(id);
    closeViewer(); renderAll();
    if (!entries[selected]) closeDay();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("viewer").hidden) closeViewer(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden" && timer) save(); });
  window.addEventListener("pagehide", function () { if (timer) save(); });

  /* ---- backup hooks used by app.js ---- */
  window.Diary = {
    count: function () { return Object.keys(entries).length; },
    exportData: async function () {
      if (timer) save();
      var used = usedIds(), all = await allPhotos(), photos = [];
      for (var i = 0; i < all.length; i++) {
        var r = all[i];
        if (!used[r.id]) continue;
        photos.push({
          id: r.id, date: r.date, type: r.type, w: r.w, h: r.h, added: r.added,
          full: await bufToDataUrl(r.full, r.type || "image/jpeg"), thumb: await bufToDataUrl(r.thumb, "image/jpeg")
        });
      }
      return { entries: JSON.parse(JSON.stringify(entries)), photos: photos };
    },
    importData: async function (d) {
      if (!d || typeof d !== "object") return null;
      var src = d.entries && typeof d.entries === "object" ? d.entries : {};
      var byId = {};
      (Array.isArray(d.photos) ? d.photos : []).forEach(function (p) {
        if (p && typeof p.id === "string" && ID_RE.test(p.id) && isImageDataUrl(p.full)) byId[p.id] = p;
      });
      var added = 0, updated = 0, photoCount = 0, keys = Object.keys(src);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!validKey(k)) continue;
        var n = cleanEntry(src[k]), old = entries[k];
        if (old && !(n.updated > old.updated)) continue;
        var kept = [];
        for (var j = 0; j < n.photos.length; j++) {
          var id = n.photos[j], p = byId[id];
          if (!p) { if (await getPhoto(id).catch(function () { return null; })) kept.push(id); continue; }
          await putPhoto({
            id: id, date: k, type: "image/jpeg", w: Number(p.w) || 0, h: Number(p.h) || 0, added: Number(p.added) || Date.now(),
            full: dataUrlToBuf(p.full), thumb: dataUrlToBuf(isImageDataUrl(p.thumb) ? p.thumb : p.full)
          });
          kept.push(id); photoCount++;
        }
        n.photos = kept;
        entries[k] = n;
        if (old) updated++; else added++;
      }
      if (!save()) throw new Error("save");
      await gc();
      renderAll();
      return { added: added, updated: updated, photos: photoCount };
    }
  };

  load();
  var now = new Date(); viewY = now.getFullYear(); viewM = now.getMonth();
  setView(lsGet(VIEW_KEY));
  renderAll();
})();
