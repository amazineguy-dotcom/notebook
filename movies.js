(function () {
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), listEl = $("m-list"), entriesEl = $("m-entries"), statusEl = $("m-status");
  var titleEl = $("m-title"), peopleEl = $("m-people"), dateEl = $("m-date");
  var newTextEl = $("m-new-text"), newMarkEl = $("m-new-mark");

  var MOVIES_KEY = "notebook.movies.v1";
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var STATUS = { watched: "看過", want: "想看" };
  // id -> {id,title,people,watched,status,rating,created,updated,entries:[{id,type,text,mark,created,updated}]}
  // "mark" is the character or timestamp a line belongs to.
  var movies = new Map();
  var currentId = null, query = "", filter = "all", newType = "quote", timer = null, editingId = null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function newId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad(x) { return String(x).padStart(2, "0"); }
  function today() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fmtDate(ms) {
    if (!ms) return "";
    var d = new Date(ms), n = new Date();
    return (d.getFullYear() === n.getFullYear() ? "" : d.getFullYear() + "/") + (d.getMonth() + 1) + "/" + d.getDate();
  }
  function fmtWatched(s) {
    if (!DATE_RE.test(s)) return "";
    var p = s.split("-"), n = new Date();
    return (Number(p[0]) === n.getFullYear() ? "" : p[0] + "/") + Number(p[1]) + "/" + Number(p[2]);
  }
  function cleanEntry(r) {
    r = r || {};
    if (typeof r.id !== "string" || !ID_RE.test(r.id)) return null;
    return {
      id: r.id, type: r.type === "thought" ? "thought" : "quote", text: String(r.text || ""),
      mark: String(r.mark || "").slice(0, 30), created: Number(r.created) || 0, updated: Number(r.updated) || 0
    };
  }
  function cleanMovie(id, r) {
    r = r || {};
    return {
      id: id, title: String(r.title || ""), people: String(r.people || ""),
      watched: DATE_RE.test(r.watched) ? r.watched : "",
      status: STATUS[r.status] ? r.status : "watched",
      rating: Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0))),
      created: Number(r.created) || 0, updated: Number(r.updated) || 0,
      entries: (Array.isArray(r.entries) ? r.entries : []).map(cleanEntry).filter(Boolean)
    };
  }

  /* ---- storage ---- */
  function load() {
    try {
      var raw = JSON.parse(lsGet(MOVIES_KEY) || "{}");
      Object.keys(raw).forEach(function (id) { if (ID_RE.test(id)) movies.set(id, cleanMovie(id, raw[id])); });
    } catch (e) {}
  }
  function isEmpty(m) { return !m.title.trim() && !m.people.trim() && !m.entries.length; }
  function save() {
    clearTimeout(timer); timer = null;
    var out = {};
    movies.forEach(function (m) {
      if (isEmpty(m) && m.id !== currentId) return;
      out[m.id] = { title: m.title, people: m.people, watched: m.watched, status: m.status, rating: m.rating, created: m.created, updated: m.updated, entries: m.entries };
    });
    return lsSet(MOVIES_KEY, JSON.stringify(out));
  }
  function setStatus(text, isErr) { statusEl.textContent = text || ""; statusEl.classList.toggle("err", !!isErr); }
  function saveNow() {
    if (save()) setStatus("已儲存"); else setStatus("儲存失敗，手機空間可能不足。", true);
    renderList();
  }
  function saveSoon() { setStatus("儲存中…"); clearTimeout(timer); timer = setTimeout(saveNow, 400); }
  function touch(m) { m.updated = Date.now(); }

  /* ---- render: rail ---- */
  function movieName(m) { return m.title.trim() || "未命名的電影"; }
  function stars(n) { return n ? "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n) : ""; }
  function snippet(text, q) {
    var flat = text.replace(/\s+/g, " ").trim();
    if (!q || flat.length <= 60) return flat.slice(0, 80);
    var i = flat.toLowerCase().indexOf(q), start = Math.max(0, i - 12);
    return (start ? "…" : "") + flat.slice(start, start + 80);
  }
  function hit(text, q) { return text.toLowerCase().indexOf(q) !== -1; }
  function counts(m) {
    var q = 0, t = 0;
    m.entries.forEach(function (e) { if (e.type === "quote") q++; else t++; });
    return q + " 句金句 · " + t + " 則感想";
  }
  function sortKey(m) { return m.watched || ""; }
  function el(tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  }
  function renderChips() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-movie-filter]"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-movie-filter") === filter ? "true" : "false");
    });
  }
  function renderList() {
    var q = query.trim().toLowerCase();
    listEl.textContent = "";
    if (filter === "quotes") { renderQuoteList(q); return; }
    var arr = [];
    movies.forEach(function (m) {
      if (isEmpty(m) && m.id !== currentId) return;
      if (filter !== "all" && m.status !== filter) return;
      var match = null;
      if (q && !hit(m.title + "\n" + m.people, q)) {
        match = m.entries.filter(function (e) { return hit(e.text + "\n" + e.mark, q); })[0];
        if (!match) return;
      }
      arr.push({ m: m, match: match });
    });
    // Most recently watched first; undated ones by last edit.
    arr.sort(function (x, y) {
      var a = sortKey(x.m), b = sortKey(y.m);
      if (a !== b) return a < b ? 1 : -1;
      return y.m.updated - x.m.updated;
    });
    if (!arr.length) {
      listEl.appendChild(el("li", "empty", q ? "找不到符合「" + query.trim() + "」的電影或筆記。"
        : filter !== "all" ? "沒有「" + STATUS[filter] + "」的電影。"
        : "還沒有電影。按「＋ 新電影」記下看過的片，收集台詞金句和觀後感。"));
      return;
    }
    arr.forEach(function (it) {
      var m = it.m, li = el("li"), btn = el("button", "item");
      btn.type = "button";
      if (m.id === currentId) btn.setAttribute("aria-current", "true");
      var top = el("div", "item-top");
      top.appendChild(el("span", "item-title", movieName(m)));
      if (m.status === "want") top.appendChild(el("span", "item-badge", STATUS.want));
      if (m.rating) top.appendChild(el("span", "item-stars", stars(m.rating)));
      if (m.watched && m.status === "watched") top.appendChild(el("span", "item-date", fmtWatched(m.watched)));
      btn.appendChild(top);
      var sub = (m.people.trim() ? m.people.trim() + " · " : "") + counts(m);
      btn.appendChild(el("div", "item-preview", it.match ? (it.match.type === "quote" ? "金句：" : "感想：") + snippet(it.match.text, q) : sub));
      btn.addEventListener("click", function () { openMovie(m.id); });
      li.appendChild(btn); listEl.appendChild(li);
    });
  }
  function source(m, e) {
    return "——《" + movieName(m) + "》" + (e.mark ? e.mark : "");
  }
  function renderQuoteList(q) {
    var arr = [];
    movies.forEach(function (m) {
      m.entries.forEach(function (e) {
        if (e.type !== "quote" || !e.text.trim()) return;
        if (q && !hit(e.text + "\n" + e.mark + "\n" + m.title + "\n" + m.people, q)) return;
        arr.push({ m: m, e: e });
      });
    });
    arr.sort(function (x, y) { return y.e.created - x.e.created; });
    if (!arr.length) {
      listEl.appendChild(el("li", "empty", q ? "找不到符合「" + query.trim() + "」的金句。" : "還沒有金句。打開一部電影，選「金句」記下台詞，這裡會集中列出。"));
      return;
    }
    arr.forEach(function (it) {
      var li = el("li"), btn = el("button", "item quote-item");
      btn.type = "button";
      btn.appendChild(el("div", "quote-text", it.e.text.trim()));
      btn.appendChild(el("div", "quote-src", source(it.m, it.e)));
      btn.addEventListener("click", function () { openMovie(it.m.id); });
      li.appendChild(btn); listEl.appendChild(li);
    });
  }

  /* ---- render: movie page ---- */
  function renderMovie() {
    var m = currentId && movies.get(currentId), open = !!m;
    $("m-editor").hidden = !open; $("m-blank").hidden = open;
    app.classList.toggle("movies-editing", open);
    $("m-confirm").hidden = true;
    if (!open) return;
    if (titleEl.value !== m.title) titleEl.value = m.title;
    if (peopleEl.value !== m.people) peopleEl.value = m.people;
    if (dateEl.value !== m.watched) dateEl.value = m.watched;
    $("m-date-row").hidden = m.status !== "watched";
    Array.prototype.forEach.call(document.querySelectorAll("[data-movie-status]"), function (x) {
      x.setAttribute("aria-pressed", x.getAttribute("data-movie-status") === m.status ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-movie-star]"), function (x) {
      x.setAttribute("aria-pressed", Number(x.getAttribute("data-movie-star")) <= m.rating ? "true" : "false");
    });
    renderComposer();
    renderEntries();
  }
  function renderComposer() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-movie-entry]"), function (x) {
      x.setAttribute("aria-pressed", x.getAttribute("data-movie-entry") === newType ? "true" : "false");
    });
    newTextEl.placeholder = newType === "quote" ? "記下打動你的台詞…" : "寫下你的觀後感…";
    newMarkEl.placeholder = newType === "quote" ? "角色或時間點（選填）" : "時間點（選填）";
  }
  function renderEntries() {
    var m = movies.get(currentId);
    entriesEl.textContent = "";
    if (!m) return;
    var list = m.entries.slice().sort(function (x, y) { return y.created - x.created; });
    $("m-entries-title").textContent = list.length ? counts(m) : "還沒有內容。上面選「金句」或「感想」開始記。";
    list.forEach(function (e) { entriesEl.appendChild(entryCard(m, e)); });
  }
  function entryCard(m, e) {
    var li = el("li", "entry " + e.type);
    if (editingId === e.id) {
      var ta = el("textarea", "entry-edit"); ta.value = e.text; ta.rows = 4; ta.setAttribute("aria-label", "編輯內容");
      var mk = el("input", "entry-page"); mk.type = "text"; mk.value = e.mark; mk.placeholder = "角色或時間點"; mk.setAttribute("aria-label", "角色或時間點");
      var row = el("div", "entry-actions");
      var ok = el("button", "primary", "儲存"), cancel = el("button", "", "取消");
      ok.type = cancel.type = "button";
      ok.addEventListener("click", function () {
        if (!ta.value.trim()) { setStatus("內容不能是空的", true); return; }
        e.text = ta.value; e.mark = mk.value.trim().slice(0, 30); e.updated = Date.now(); touch(m);
        editingId = null; saveNow(); renderEntries();
      });
      cancel.addEventListener("click", function () { editingId = null; renderEntries(); });
      row.appendChild(mk); row.appendChild(cancel); row.appendChild(ok);
      li.appendChild(ta); li.appendChild(row);
      setTimeout(function () { ta.focus(); }, 0);
      return li;
    }
    li.appendChild(el("p", "entry-text", e.text));
    var meta = el("div", "entry-meta");
    meta.appendChild(el("span", "entry-info", (e.type === "quote" ? "金句" : "感想") + (e.mark ? " · " + e.mark : "") + " · " + fmtDate(e.created)));
    var acts = el("span", "entry-actions");
    var cp = el("button", "", "複製"), ed = el("button", "", "編輯"), del = el("button", "danger-text", "刪除");
    cp.type = ed.type = del.type = "button";
    cp.addEventListener("click", function () { copyEntry(m, e); });
    ed.addEventListener("click", function () { editingId = e.id; renderEntries(); });
    del.addEventListener("click", function () {
      if (!del.hasAttribute("data-armed")) { del.setAttribute("data-armed", ""); del.textContent = "確定刪除？"; return; }
      m.entries = m.entries.filter(function (x) { return x.id !== e.id; }); touch(m);
      saveNow(); renderEntries();
    });
    acts.appendChild(cp); acts.appendChild(ed); acts.appendChild(del);
    meta.appendChild(acts);
    li.appendChild(meta);
    return li;
  }
  function copyEntry(m, e) {
    var text = e.text.trim();
    if (e.type === "quote") text += "\n" + source(m, e);
    var done = function () { setStatus("已複製"); }, fail = function () { setStatus("無法複製，請長按文字自行選取", true); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }

  /* ---- actions ---- */
  function openMovie(id) {
    if (timer) saveNow();
    currentId = id; editingId = null;
    renderList(); renderMovie();
    if (!timer) setStatus("");
  }
  function closeMovie() {
    if (timer) saveNow();
    var m = movies.get(currentId);
    currentId = null; editingId = null;
    if (m && isEmpty(m)) movies.delete(m.id);
    save(); renderList(); renderMovie();
  }
  $("m-new").addEventListener("click", function () {
    var now = Date.now(), m = cleanMovie(newId("m"), { status: "watched", watched: today(), created: now, updated: now });
    movies.set(m.id, m);
    query = ""; $("m-search").value = "";
    if (filter !== "all" && filter !== "watched") { filter = "all"; renderChips(); }
    openMovie(m.id); titleEl.focus();
  });
  $("m-back").addEventListener("click", closeMovie);
  titleEl.addEventListener("input", function () { var m = movies.get(currentId); if (!m) return; m.title = titleEl.value; touch(m); saveSoon(); });
  peopleEl.addEventListener("input", function () { var m = movies.get(currentId); if (!m) return; m.people = peopleEl.value; touch(m); saveSoon(); });
  dateEl.addEventListener("change", function () {
    var m = movies.get(currentId); if (!m) return;
    m.watched = DATE_RE.test(dateEl.value) ? dateEl.value : ""; touch(m); saveNow();
  });
  titleEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); peopleEl.focus(); } });
  peopleEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); newTextEl.focus(); } });
  Array.prototype.forEach.call(document.querySelectorAll("[data-movie-status]"), function (x) {
    x.addEventListener("click", function () {
      var m = movies.get(currentId); if (!m) return;
      m.status = x.getAttribute("data-movie-status");
      if (m.status === "watched" && !m.watched) m.watched = today();
      if (m.status === "want") m.watched = "";
      touch(m); saveNow(); renderMovie();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-movie-star]"), function (x) {
    x.addEventListener("click", function () {
      var m = movies.get(currentId); if (!m) return;
      var n = Number(x.getAttribute("data-movie-star"));
      m.rating = m.rating === n ? 0 : n; touch(m); saveNow(); renderMovie();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-movie-entry]"), function (x) {
    x.addEventListener("click", function () { newType = x.getAttribute("data-movie-entry"); renderComposer(); newTextEl.focus(); });
  });
  $("m-add").addEventListener("click", function () {
    var m = movies.get(currentId); if (!m) return;
    if (!newTextEl.value.trim()) { setStatus("先寫點內容再加入", true); newTextEl.focus(); return; }
    var now = Date.now();
    m.entries.push({ id: newId("e"), type: newType, text: newTextEl.value, mark: newMarkEl.value.trim().slice(0, 30), created: now, updated: now });
    touch(m);
    newTextEl.value = ""; newMarkEl.value = "";
    saveNow(); renderEntries();
    setStatus(newType === "quote" ? "已加入金句" : "已加入感想");
  });
  $("m-del").addEventListener("click", function () { $("m-confirm").hidden = false; });
  $("m-del-no").addEventListener("click", function () { $("m-confirm").hidden = true; });
  $("m-del-yes").addEventListener("click", function () {
    movies.delete(currentId); currentId = null; save(); renderList(); renderMovie();
  });
  $("m-search").addEventListener("input", function (e) { query = e.target.value; renderList(); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-movie-filter]"), function (x) {
    x.addEventListener("click", function () { filter = x.getAttribute("data-movie-filter"); renderChips(); renderList(); });
  });
  document.addEventListener("viewchange", function (e) { if (e.detail === "movies") renderList(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden" && timer) save(); });
  window.addEventListener("pagehide", function () { if (timer) save(); });

  /* ---- backup hooks used by app.js ---- */
  window.Movies = {
    exportData: function () {
      if (timer) save();
      var out = {};
      movies.forEach(function (m) { if (!isEmpty(m)) out[m.id] = JSON.parse(JSON.stringify(m)); });
      return { movies: out };
    },
    importData: function (d) {
      var src = d && d.movies && typeof d.movies === "object" ? d.movies : null;
      if (!src) return null;
      var added = 0, updated = 0;
      Object.keys(src).forEach(function (id) {
        if (!ID_RE.test(id)) return;
        var n = cleanMovie(id, src[id]), old = movies.get(id);
        if (!old) { movies.set(id, n); added++; }
        else if (n.updated > old.updated) { movies.set(id, n); updated++; }
      });
      if (!save()) throw new Error("save");
      renderList(); renderMovie();
      return { added: added, updated: updated };
    }
  };

  load();
  renderChips(); renderList(); renderMovie();
})();
