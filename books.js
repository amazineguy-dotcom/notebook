(function () {
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), listEl = $("b-list"), entriesEl = $("b-entries"), statusEl = $("b-status");
  var titleEl = $("b-title"), authorEl = $("b-author"), newTextEl = $("b-new-text"), newPageEl = $("b-new-page");

  var BOOKS_KEY = "notebook.books.v1";
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var STATUS = { reading: "在讀", done: "讀完", want: "想讀" };
  var books = new Map();   // id -> {id,title,author,status,rating,created,updated,entries:[{id,type,text,page,created,updated}]}
  var currentId = null, query = "", filter = "all", newType = "quote", timer = null, editingId = null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function newId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fmtDate(ms) {
    if (!ms) return "";
    var d = new Date(ms), n = new Date();
    return (d.getFullYear() === n.getFullYear() ? "" : d.getFullYear() + "/") + (d.getMonth() + 1) + "/" + d.getDate();
  }
  function cleanEntry(r) {
    r = r || {};
    if (typeof r.id !== "string" || !ID_RE.test(r.id)) return null;
    return {
      id: r.id, type: r.type === "thought" ? "thought" : "quote", text: String(r.text || ""),
      page: String(r.page || "").slice(0, 20), created: Number(r.created) || 0, updated: Number(r.updated) || 0
    };
  }
  function cleanBook(id, r) {
    r = r || {};
    return {
      id: id, title: String(r.title || ""), author: String(r.author || ""),
      status: STATUS[r.status] ? r.status : "reading",
      rating: Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0))),
      created: Number(r.created) || 0, updated: Number(r.updated) || 0,
      entries: (Array.isArray(r.entries) ? r.entries : []).map(cleanEntry).filter(Boolean)
    };
  }

  /* ---- storage ---- */
  function load() {
    try {
      var raw = JSON.parse(lsGet(BOOKS_KEY) || "{}");
      Object.keys(raw).forEach(function (id) { if (ID_RE.test(id)) books.set(id, cleanBook(id, raw[id])); });
    } catch (e) {}
  }
  function isEmpty(b) { return !b.title.trim() && !b.author.trim() && !b.entries.length; }
  function save() {
    clearTimeout(timer); timer = null;
    var out = {};
    books.forEach(function (b) {
      if (isEmpty(b) && b.id !== currentId) return;
      out[b.id] = { title: b.title, author: b.author, status: b.status, rating: b.rating, created: b.created, updated: b.updated, entries: b.entries };
    });
    return lsSet(BOOKS_KEY, JSON.stringify(out));
  }
  function setStatus(text, isErr) { statusEl.textContent = text || ""; statusEl.classList.toggle("err", !!isErr); }
  function saveNow() {
    if (save()) setStatus("已儲存"); else setStatus("儲存失敗，手機空間可能不足。", true);
    renderList();
  }
  function saveSoon() { setStatus("儲存中…"); clearTimeout(timer); timer = setTimeout(saveNow, 400); }
  function touch(b) { b.updated = Date.now(); }

  /* ---- render: rail ---- */
  function bookName(b) { return b.title.trim() || "未命名的書"; }
  function stars(n) { return n ? "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n) : ""; }
  function snippet(text, q) {
    var flat = text.replace(/\s+/g, " ").trim();
    if (!q || flat.length <= 60) return flat.slice(0, 80);
    var i = flat.toLowerCase().indexOf(q), start = Math.max(0, i - 12);
    return (start ? "…" : "") + flat.slice(start, start + 80);
  }
  function hit(text, q) { return text.toLowerCase().indexOf(q) !== -1; }
  function counts(b) {
    var q = 0, t = 0;
    b.entries.forEach(function (e) { if (e.type === "quote") q++; else t++; });
    return q + " 句金句 · " + t + " 則感想";
  }
  function el(tag, cls, text) {
    var x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  }
  function renderChips() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-book-filter]"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-book-filter") === filter ? "true" : "false");
    });
  }
  function renderList() {
    var q = query.trim().toLowerCase();
    listEl.textContent = "";
    if (filter === "quotes") { renderQuoteList(q); return; }
    var arr = [];
    books.forEach(function (b) {
      if (isEmpty(b) && b.id !== currentId) return;
      if (filter !== "all" && b.status !== filter) return;
      var match = null;
      if (q) {
        if (!hit(b.title + "\n" + b.author, q)) {
          match = b.entries.filter(function (e) { return hit(e.text, q); })[0];
          if (!match) return;
        }
      }
      arr.push({ b: b, match: match });
    });
    arr.sort(function (x, y) { return y.b.updated - x.b.updated; });
    if (!arr.length) {
      listEl.appendChild(el("li", "empty", q ? "找不到符合「" + query.trim() + "」的書或筆記。"
        : filter !== "all" ? "沒有「" + STATUS[filter] + "」的書。"
        : "還沒有書。按「＋ 新書」記下正在讀的書，開始收集金句和感想。"));
      return;
    }
    arr.forEach(function (it) {
      var b = it.b, li = el("li"), btn = el("button", "item");
      btn.type = "button";
      if (b.id === currentId) btn.setAttribute("aria-current", "true");
      var top = el("div", "item-top");
      top.appendChild(el("span", "item-title", bookName(b)));
      top.appendChild(el("span", "item-badge", STATUS[b.status]));
      if (b.rating) top.appendChild(el("span", "item-stars", stars(b.rating)));
      btn.appendChild(top);
      var sub = (b.author.trim() ? b.author.trim() + " · " : "") + counts(b);
      btn.appendChild(el("div", "item-preview", it.match ? (it.match.type === "quote" ? "金句：" : "感想：") + snippet(it.match.text, q) : sub));
      btn.addEventListener("click", function () { openBook(b.id); });
      li.appendChild(btn); listEl.appendChild(li);
    });
  }
  function renderQuoteList(q) {
    var arr = [];
    books.forEach(function (b) {
      b.entries.forEach(function (e) {
        if (e.type !== "quote" || !e.text.trim()) return;
        if (q && !hit(e.text + "\n" + b.title + "\n" + b.author, q)) return;
        arr.push({ b: b, e: e });
      });
    });
    arr.sort(function (x, y) { return y.e.created - x.e.created; });
    if (!arr.length) {
      listEl.appendChild(el("li", "empty", q ? "找不到符合「" + query.trim() + "」的金句。" : "還沒有金句。打開一本書，選「金句」記下來，這裡會集中列出。"));
      return;
    }
    arr.forEach(function (it) {
      var li = el("li"), btn = el("button", "item quote-item");
      btn.type = "button";
      btn.appendChild(el("div", "quote-text", it.e.text.trim()));
      btn.appendChild(el("div", "quote-src", "——《" + bookName(it.b) + "》" + (it.b.author.trim() ? it.b.author.trim() : "") + (it.e.page ? " p." + it.e.page : "")));
      btn.addEventListener("click", function () { openBook(it.b.id); });
      li.appendChild(btn); listEl.appendChild(li);
    });
  }

  /* ---- render: book page ---- */
  function renderBook() {
    var b = currentId && books.get(currentId), open = !!b;
    $("b-editor").hidden = !open; $("b-blank").hidden = open;
    app.classList.toggle("books-editing", open);
    $("b-confirm").hidden = true;
    if (!open) return;
    if (titleEl.value !== b.title) titleEl.value = b.title;
    if (authorEl.value !== b.author) authorEl.value = b.author;
    Array.prototype.forEach.call(document.querySelectorAll("[data-book-status]"), function (x) {
      x.setAttribute("aria-pressed", x.getAttribute("data-book-status") === b.status ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-star]"), function (x) {
      x.setAttribute("aria-pressed", Number(x.getAttribute("data-star")) <= b.rating ? "true" : "false");
    });
    renderComposer();
    renderEntries();
  }
  function renderComposer() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-entry-type]"), function (x) {
      x.setAttribute("aria-pressed", x.getAttribute("data-entry-type") === newType ? "true" : "false");
    });
    newTextEl.placeholder = newType === "quote" ? "抄下打動你的句子…" : "寫下你的想法…";
  }
  function renderEntries() {
    var b = books.get(currentId);
    entriesEl.textContent = "";
    if (!b) return;
    var list = b.entries.slice().sort(function (x, y) { return y.created - x.created; });
    $("b-entries-title").textContent = list.length ? counts(b) : "還沒有內容。上面選「金句」或「感想」開始記。";
    list.forEach(function (e) { entriesEl.appendChild(entryCard(b, e)); });
  }
  function entryCard(b, e) {
    var li = el("li", "entry " + e.type);
    if (editingId === e.id) {
      var ta = el("textarea", "entry-edit"); ta.value = e.text; ta.rows = 4; ta.setAttribute("aria-label", "編輯內容");
      var pg = el("input", "entry-page"); pg.type = "text"; pg.inputMode = "numeric"; pg.value = e.page; pg.placeholder = "頁數"; pg.setAttribute("aria-label", "頁數");
      var row = el("div", "entry-actions");
      var ok = el("button", "primary", "儲存"), cancel = el("button", "", "取消");
      ok.type = cancel.type = "button";
      ok.addEventListener("click", function () {
        if (!ta.value.trim()) { setStatus("內容不能是空的", true); return; }
        e.text = ta.value; e.page = pg.value.trim().slice(0, 20); e.updated = Date.now(); touch(b);
        editingId = null; saveNow(); renderEntries();
      });
      cancel.addEventListener("click", function () { editingId = null; renderEntries(); });
      row.appendChild(pg); row.appendChild(cancel); row.appendChild(ok);
      li.appendChild(ta); li.appendChild(row);
      setTimeout(function () { ta.focus(); }, 0);
      return li;
    }
    li.appendChild(el("p", "entry-text", e.text));
    var meta = el("div", "entry-meta");
    meta.appendChild(el("span", "entry-info", (e.type === "quote" ? "金句" : "感想") + (e.page ? " · p." + e.page : "") + " · " + fmtDate(e.created)));
    var acts = el("span", "entry-actions");
    var cp = el("button", "", "複製"), ed = el("button", "", "編輯"), del = el("button", "danger-text", "刪除");
    cp.type = ed.type = del.type = "button";
    cp.addEventListener("click", function () { copyEntry(b, e); });
    ed.addEventListener("click", function () { editingId = e.id; renderEntries(); });
    del.addEventListener("click", function () {
      if (!del.hasAttribute("data-armed")) { del.setAttribute("data-armed", ""); del.textContent = "確定刪除？"; return; }
      b.entries = b.entries.filter(function (x) { return x.id !== e.id; }); touch(b);
      saveNow(); renderEntries();
    });
    acts.appendChild(cp); acts.appendChild(ed); acts.appendChild(del);
    meta.appendChild(acts);
    li.appendChild(meta);
    return li;
  }
  function copyEntry(b, e) {
    var text = e.text.trim();
    if (e.type === "quote") text += "\n——《" + bookName(b) + "》" + b.author.trim() + (e.page ? " p." + e.page : "");
    var done = function () { setStatus("已複製"); }, fail = function () { setStatus("無法複製，請長按文字自行選取", true); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }

  /* ---- actions ---- */
  function openBook(id) {
    if (timer) saveNow();
    currentId = id; editingId = null;
    renderList(); renderBook();
    if (!timer) setStatus("");
  }
  function closeBook() {
    if (timer) saveNow();
    var b = books.get(currentId);
    currentId = null; editingId = null;
    if (b && isEmpty(b)) books.delete(b.id);
    save(); renderList(); renderBook();
  }
  $("b-new").addEventListener("click", function () {
    var now = Date.now(), b = cleanBook(newId("b"), { status: "reading", created: now, updated: now });
    books.set(b.id, b);
    query = ""; $("b-search").value = "";
    if (filter !== "all" && filter !== "reading") { filter = "all"; renderChips(); }
    openBook(b.id); titleEl.focus();
  });
  $("b-back").addEventListener("click", closeBook);
  titleEl.addEventListener("input", function () { var b = books.get(currentId); if (!b) return; b.title = titleEl.value; touch(b); saveSoon(); });
  authorEl.addEventListener("input", function () { var b = books.get(currentId); if (!b) return; b.author = authorEl.value; touch(b); saveSoon(); });
  titleEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); authorEl.focus(); } });
  authorEl.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); newTextEl.focus(); } });
  Array.prototype.forEach.call(document.querySelectorAll("[data-book-status]"), function (x) {
    x.addEventListener("click", function () {
      var b = books.get(currentId); if (!b) return;
      b.status = x.getAttribute("data-book-status"); touch(b); saveNow(); renderBook();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-star]"), function (x) {
    x.addEventListener("click", function () {
      var b = books.get(currentId); if (!b) return;
      var n = Number(x.getAttribute("data-star"));
      b.rating = b.rating === n ? 0 : n; touch(b); saveNow(); renderBook();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-entry-type]"), function (x) {
    x.addEventListener("click", function () { newType = x.getAttribute("data-entry-type"); renderComposer(); newTextEl.focus(); });
  });
  $("b-add").addEventListener("click", function () {
    var b = books.get(currentId); if (!b) return;
    if (!newTextEl.value.trim()) { setStatus("先寫點內容再加入", true); newTextEl.focus(); return; }
    var now = Date.now();
    b.entries.push({ id: newId("e"), type: newType, text: newTextEl.value, page: newPageEl.value.trim().slice(0, 20), created: now, updated: now });
    touch(b);
    newTextEl.value = ""; newPageEl.value = "";
    saveNow(); renderEntries();
    setStatus(newType === "quote" ? "已加入金句" : "已加入感想");
  });
  $("b-del").addEventListener("click", function () { $("b-confirm").hidden = false; });
  $("b-del-no").addEventListener("click", function () { $("b-confirm").hidden = true; });
  $("b-del-yes").addEventListener("click", function () {
    books.delete(currentId); currentId = null; save(); renderList(); renderBook();
  });
  $("b-search").addEventListener("input", function (e) { query = e.target.value; renderList(); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-book-filter]"), function (x) {
    x.addEventListener("click", function () { filter = x.getAttribute("data-book-filter"); renderChips(); renderList(); });
  });
  document.addEventListener("viewchange", function (e) { if (e.detail === "books") renderList(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden" && timer) save(); });
  window.addEventListener("pagehide", function () { if (timer) save(); });

  /* ---- backup hooks used by app.js ---- */
  window.Books = {
    exportData: function () {
      if (timer) save();
      var out = {};
      books.forEach(function (b) { if (!isEmpty(b)) out[b.id] = JSON.parse(JSON.stringify(b)); });
      return { books: out };
    },
    importData: function (d) {
      var src = d && d.books && typeof d.books === "object" ? d.books : null;
      if (!src) return null;
      var added = 0, updated = 0;
      Object.keys(src).forEach(function (id) {
        if (!ID_RE.test(id)) return;
        var n = cleanBook(id, src[id]), old = books.get(id);
        if (!old) { books.set(id, n); added++; }
        else if (n.updated > old.updated) { books.set(id, n); updated++; }
      });
      if (!save()) throw new Error("save");
      renderList(); renderBook();
      return { added: added, updated: updated };
    }
  };

  load();
  renderChips(); renderList(); renderBook();
})();
