(function () {
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), listEl = $("note-list"), storeNote = $("store-note");
  var editor = $("editor"), blank = $("blank"), statusEl = $("status");
  var titleEl = $("note-title"), bodyEl = $("note-body"), pinEl = $("pin"), confirmEl = $("confirm");

  var LS_KEY = "notebook.notes.v1";
  var notes = new Map();   // id -> {id,title,body,updated,pinned}
  var currentId = null, query = "", timer = null;

  function newId() { return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function clean(id, r) {
    r = r || {};
    return { id: id, title: String(r.title || ""), body: String(r.body || ""), updated: Number(r.updated) || 0, pinned: !!r.pinned };
  }
  function fmtDate(ms) {
    if (!ms) return "";
    var d = new Date(ms), n = new Date();
    var p = function (x) { return String(x).padStart(2, "0"); };
    if (d.toDateString() === n.toDateString()) return p(d.getHours()) + ":" + p(d.getMinutes());
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + "/" + d.getDate();
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }

  /* ---- storage ---- */
  function dump() {
    var out = {};
    notes.forEach(function (n) { out[n.id] = { title: n.title, body: n.body, updated: n.updated, pinned: n.pinned }; });
    return out;
  }
  function save() {
    clearTimeout(timer); timer = null;
    try { localStorage.setItem(LS_KEY, JSON.stringify(dump())); return true; }
    catch (e) { return false; }
  }
  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      Object.keys(raw).forEach(function (id) { notes.set(id, clean(id, raw[id])); });
    } catch (e) {}
  }
  function setStatus(text, isErr) { statusEl.textContent = text || ""; statusEl.classList.toggle("err", !!isErr); }
  function saveNow() {
    var ok = save();
    var n = notes.get(currentId);
    if (ok) setStatus(n ? "已儲存 " + fmtDate(n.updated) : "");
    else setStatus("儲存失敗，手機空間可能不足。請先匯出備份。", true);
  }
  function saveSoon() { setStatus("儲存中…"); clearTimeout(timer); timer = setTimeout(saveNow, 400); }

  /* ---- render ---- */
  function visibleNotes() {
    var q = query.trim().toLowerCase(), arr = [];
    notes.forEach(function (n) {
      if (q && (n.title + "\n" + n.body).toLowerCase().indexOf(q) === -1) return;
      arr.push(n);
    });
    arr.sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updated - a.updated;
    });
    return arr;
  }
  function renderList() {
    var arr = visibleNotes();
    listEl.textContent = "";
    if (!arr.length) {
      var e = document.createElement("li"); e.className = "empty";
      e.textContent = query.trim() ? "找不到符合「" + query.trim() + "」的筆記。" : "還沒有筆記。按「＋ 新筆記」寫下第一則，內容會自動儲存。";
      listEl.appendChild(e); return;
    }
    arr.forEach(function (n) {
      var li = document.createElement("li"), b = document.createElement("button");
      b.type = "button"; b.className = "item";
      if (n.id === currentId) b.setAttribute("aria-current", "true");
      var top = document.createElement("div"); top.className = "item-top";
      var t = document.createElement("span"); t.className = "item-title"; t.textContent = n.title.trim() || "未命名筆記";
      top.appendChild(t);
      if (n.pinned) { var pin = document.createElement("span"); pin.className = "item-pin"; pin.textContent = "釘選"; top.appendChild(pin); }
      var d = document.createElement("span"); d.className = "item-date"; d.textContent = fmtDate(n.updated); top.appendChild(d);
      var pv = document.createElement("div"); pv.className = "item-preview";
      pv.textContent = n.body.replace(/\s+/g, " ").trim().slice(0, 80) || "（沒有內容）";
      b.appendChild(top); b.appendChild(pv);
      b.addEventListener("click", function () { openNote(n.id); });
      li.appendChild(b); listEl.appendChild(li);
    });
  }
  function renderEditor() {
    var n = currentId && notes.get(currentId), open = !!n;
    editor.hidden = !open; blank.hidden = open;
    app.classList.toggle("editing", open);
    confirmEl.hidden = true;
    if (!open) return;
    if (titleEl.value !== n.title) titleEl.value = n.title;
    if (bodyEl.value !== n.body) bodyEl.value = n.body;
    pinEl.setAttribute("aria-pressed", n.pinned ? "true" : "false");
    pinEl.textContent = n.pinned ? "已釘選" : "釘選";
    if (!timer) setStatus(n.updated ? "已儲存 " + fmtDate(n.updated) : "");
  }
  function openNote(id) { currentId = id; renderList(); renderEditor(); }
  function closeNote() { if (timer) saveNow(); currentId = null; renderList(); renderEditor(); }

  /* ---- actions ---- */
  $("new-note").addEventListener("click", function () {
    var n = clean(newId(), { updated: Date.now() });
    notes.set(n.id, n);
    query = ""; $("search").value = "";
    openNote(n.id); saveSoon(); titleEl.focus();
  });
  function onEdit() {
    var n = notes.get(currentId); if (!n) return;
    n.title = titleEl.value; n.body = bodyEl.value; n.updated = Date.now();
    saveSoon(); renderList();
  }
  titleEl.addEventListener("input", onEdit);
  bodyEl.addEventListener("input", onEdit);
  titleEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); bodyEl.focus(); } });
  pinEl.addEventListener("click", function () {
    var n = notes.get(currentId); if (!n) return;
    n.pinned = !n.pinned; saveNow(); renderList(); renderEditor();
  });
  $("del").addEventListener("click", function () { confirmEl.hidden = false; });
  $("del-no").addEventListener("click", function () { confirmEl.hidden = true; });
  $("del-yes").addEventListener("click", function () {
    notes.delete(currentId); currentId = null; save(); renderList(); renderEditor();
  });
  $("back").addEventListener("click", closeNote);
  $("search").addEventListener("input", function (e) { query = e.target.value; renderList(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden" && timer) save(); });
  window.addEventListener("pagehide", function () { if (timer) save(); });

  /* ---- backup ---- */
  function note(text) { storeNote.textContent = text; }
  $("export").addEventListener("click", async function () {
    if (timer) saveNow();
    var d = new Date(), p = function (x) { return String(x).padStart(2, "0"); };
    var name = "notebook-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + ".json";
    var text = JSON.stringify({ app: "notebook", version: 1, exported: d.toISOString(), notes: dump() }, null, 2);
    var file = new File([text], name, { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        note("已匯出 " + notes.size + " 則筆記。"); return;
      }
    } catch (e) { if (e && e.name === "AbortError") return; }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    note("已匯出 " + notes.size + " 則筆記：" + name);
  });
  $("import").addEventListener("click", function () { $("import-file").click(); });
  $("import-file").addEventListener("change", async function (e) {
    var f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      var data = JSON.parse(await f.text());
      var src = data && data.notes && typeof data.notes === "object" ? data.notes : null;
      if (!src) throw new Error("format");
      var added = 0, updated = 0;
      Object.keys(src).forEach(function (id) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
        var n = clean(id, src[id]), old = notes.get(id);
        if (!old) { notes.set(id, n); added++; }
        else if (n.updated > old.updated) { notes.set(id, n); updated++; }
      });
      if (!save()) throw new Error("save");
      renderList(); renderEditor();
      note("匯入完成：新增 " + added + " 則，更新 " + updated + " 則。");
    } catch (err) {
      note(err.message === "save" ? "匯入失敗：手機空間不足。" : "匯入失敗：這不是筆記本的備份檔。");
    }
  });

  load(); renderList(); renderEditor();
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () {}); }
  if ("serviceWorker" in navigator) { navigator.serviceWorker.register("sw.js").catch(function () {}); }
})();
