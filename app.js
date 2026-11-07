/* STG Field Notes: Listing Lead + Listing Details.
   Apple Pencil writes, finger scrolls and taps. Saved per property. Works offline. Exports PDF. */
(() => {
  "use strict";

  const SHEET_W = 816, SHEET_H = 1056;
  const INK = "#14213D", PEN_W = 2.1, ERASE_R = 11, PHOTO_MAX_SIDE = 4096, PHOTO_MAX_PIXELS = 2.4e6, WIDE = 2.1;
  const FORMS = {
    lead:    { title: "Listing Lead",    tag: "FIRST VISIT",    layout: "lead-layout.json",    prefix: "lead-" },
    details: { title: "Listing Details", tag: "LISTING SIGNED", layout: "details-layout.json", prefix: "details-" },
  };
  const ICON_CAM = '<svg viewBox="0 0 24 24"><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.6"/></svg>';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------------- storage ---------------- */
  const DB = {
    db: null,
    async open() {
      if (this.db) return this.db;
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open("stg-field-notes", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return this.db;
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction("kv", mode); const out = fn(t.objectStore("kv"));
        t.oncomplete = () => res(out instanceof IDBRequest ? out.result : undefined);
        t.onerror = () => rej(t.error);
      });
    },
    get(k) { return this.tx("readonly", s => s.get(k)); },
    set(k, v) { return this.tx("readwrite", s => { s.put(v, k); }); },
    del(k) { return this.tx("readwrite", s => { s.delete(k); }); },
    keys() { return this.tx("readonly", s => s.getAllKeys()); },
    delMany(ks) { return this.tx("readwrite", s => { ks.forEach(k => s.delete(k)); }); },
  };

  let docs = [];                       // [{id,type,name,leadId,created,updated}]
  const saveDocs = () => DB.set("docs", docs).catch(e => console.warn(e));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const layouts = {};
  async function getLayout(type) {
    if (!layouts[type]) layouts[type] = await fetch(FORMS[type].layout).then(r => r.json());
    return layouts[type];
  }

  /* ---------------- the open form ---------------- */
  let cur = null;   // {meta, layout, pages, strokes, photos, photoUrls, undo, tool, drawing, lastPenUp}
  let tool = "pen";

  async function openDoc(meta) {
    const layout = await getLayout(meta.type);
    cur = { meta, layout, pages: [], strokes: [], photos: {}, photoUrls: {}, text: {}, undo: [], drawing: null, lastPenUp: 0 };
    const doc = $("#doc"); doc.innerHTML = "";
    const prefix = FORMS[meta.type].prefix;
    for (let i = 0; i < layout.pages; i++) {
      const el = document.createElement("section"); el.className = "page";
      const bg = new Image(); bg.className = "bg"; bg.src = `${prefix}page-${i + 1}.png`; bg.alt = ""; bg.draggable = false;
      const tcanvas = document.createElement("canvas"); tcanvas.className = "txt";
      const canvas = document.createElement("canvas"); canvas.className = "ink";
      el.append(bg, tcanvas, canvas); doc.append(el);
      const p = { el, canvas, ctx: canvas.getContext("2d"), tcanvas, tctx: tcanvas.getContext("2d"), bg, index: i };
      cur.pages.push(p); cur.strokes.push([]); bindInk(p);
    }
    for (const s of layout.slots) {
      const b = document.createElement("button"); b.className = "slot"; b.dataset.id = s.id;
      Object.assign(b.style, { left: pct(s.x, SHEET_W), top: pct(s.y, SHEET_H), width: pct(s.w, SHEET_W), height: pct(s.h, SHEET_H) });
      b.addEventListener("click", () => openPhotoMenu(s));
      cur.pages[s.page].el.append(b);
    }
    try {
      const ink = await DB.get(`d:${meta.id}:ink`);
      if (Array.isArray(ink)) ink.forEach((p, i) => { if (cur.strokes[i] && Array.isArray(p)) cur.strokes[i] = p; });
      for (const s of layout.slots) { const b = await DB.get(`d:${meta.id}:p:${s.id}`); if (b) cur.photos[s.id] = b; }
      const tx = await DB.get(`d:${meta.id}:text`); if (tx && typeof tx === "object") cur.text = tx;
    } catch (e) { console.warn("load failed", e); }
    layout.slots.forEach(s => renderSlot(s.id));
    setTitle(); setSaved("");
    document.body.className = "editing";
    window.scrollTo({ top: 0 });
    cur.pages.forEach(p => { ro.observe(p.el); sizeCanvas(p); });
    try { const n = +(localStorage.getItem("fn-hint") || 0); if (n < 3) { localStorage.setItem("fn-hint", n + 1); toast("Write with the Pencil. Or tap a box with your finger to type or dictate."); } } catch (e) {}
  }

  async function closeDoc() {
    if (!cur) return;
    await flushInk();
    cur.pages.forEach(p => ro.unobserve(p.el));
    Object.values(cur.photoUrls).forEach(u => URL.revokeObjectURL(u));
    cur = null; $("#doc").innerHTML = "";
    document.body.className = "at-home";
    renderHome(); window.scrollTo({ top: 0 });
  }

  function setTitle() {
    $("#docTitle").innerHTML = `<small>${esc(FORMS[cur.meta.type].title.toUpperCase())}</small>${esc(cur.meta.name || "Untitled")}`;
  }
  function touch() { if (!cur) return; cur.meta.updated = Date.now(); saveDocs(); }

  const pct = (v, t) => (v / t * 100) + "%";
  const ro = new ResizeObserver(() => cur && cur.pages.forEach(sizeCanvas));
  function sizeCanvas(p) {
    const r = p.el.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (w && (p.canvas.width !== w || p.canvas.height !== h)) {
      p.canvas.width = p.tcanvas.width = w; p.canvas.height = p.tcanvas.height = h; redraw(p.index); redrawText(p.index);
    }
  }

  /* ---------------- saving ---------------- */
  let saveTimer = null;
  function scheduleSave() { setSaved("…"); clearTimeout(saveTimer); saveTimer = setTimeout(flushInk, 700); }
  async function flushInk() {
    if (!saveTimer || !cur) return;          // nothing pending
    clearTimeout(saveTimer); saveTimer = null;
    try { await DB.set(`d:${cur.meta.id}:ink`, cur.strokes); touch(); setSaved("Saved"); }
    catch (e) { setSaved(""); console.warn("save failed", e); }
  }
  async function savePhoto(id) {
    const k = `d:${cur.meta.id}:p:${id}`;
    try { cur.photos[id] ? await DB.set(k, cur.photos[id]) : await DB.del(k); touch(); setSaved("Saved"); }
    catch (e) { console.warn("photo save failed", e); }
  }
  function setSaved(t) { $("#saved").textContent = t; }

  /* ---------------- ink ---------------- */
  const widthFor = pr => PEN_W * (0.45 + 0.9 * (pr || 0.5));
  function drawStroke(ctx, stroke, k, fromIdx = 1) {
    const pts = stroke.pts;
    ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * k, pts[0][1] * k, widthFor(pts[0][2]) * k / 2, 0, Math.PI * 2); ctx.fill(); return; }
    for (let i = Math.max(1, fromIdx); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], prev = pts[i - 2] || a;
      const m1 = [(prev[0] + a[0]) / 2, (prev[1] + a[1]) / 2], m2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      ctx.lineWidth = widthFor((a[2] + b[2]) / 2) * k;
      ctx.beginPath(); ctx.moveTo(m1[0] * k, m1[1] * k); ctx.quadraticCurveTo(a[0] * k, a[1] * k, m2[0] * k, m2[1] * k); ctx.stroke();
      if (i === pts.length - 1) { ctx.beginPath(); ctx.moveTo(m2[0] * k, m2[1] * k); ctx.lineTo(b[0] * k, b[1] * k); ctx.stroke(); }
    }
  }
  function redraw(i) {
    const p = cur.pages[i]; const k = p.canvas.width / SHEET_W;
    p.ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
    for (const s of cur.strokes[i]) drawStroke(p.ctx, s, k);
  }
  /* ---------------- typed / dictated text + checkbox ticks ---------------- */
  const TEXT_INK = "#163172", FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const fieldsOn = i => (cur.layout.fields || []).filter(f => f.page === i);
  function wrap(ctx, text, maxW) {
    const out = [];
    for (const para of String(text).split(/\n/)) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? line + " " + word : word;
        if (ctx.measureText(t).width <= maxW || !line) line = t; else { out.push(line); line = word; }
      }
      out.push(line);
    }
    return out.filter((l, i, a) => l || a.length === 1);
  }
  function drawFieldText(ctx, f, value, k) {
    const padX = 6, padY = 3, x = f.x * k, w = (f.w - 2 * padX) * k;
    const single = f.lines <= 1;
    const text = single ? String(value).replace(/\s*\n\s*/g, " ") : String(value);
    const slotH = single ? f.h : f.h / f.lines;
    let size = Math.min(single ? 17 : 15.5, slotH * (single ? 0.5 : 0.48)), lines, lineH;
    for (;;) {
      ctx.font = `${size * k}px ${FONT}`;
      lines = wrap(ctx, text, w);
      lineH = Math.max(size * 1.25, single ? 0 : 0);
      const cap = single ? Math.max(1, Math.floor((f.h - 2 * padY) / lineH)) : Math.max(f.lines, Math.floor((f.h - 2 * padY) / lineH));
      if (lines.length <= cap || size <= 8) { if (lines.length > cap) { lines = lines.slice(0, cap); lines[cap - 1] = lines[cap - 1].replace(/.{0,2}$/, "…"); } break; }
      size -= 0.5;
    }
    ctx.fillStyle = TEXT_INK; ctx.textBaseline = "alphabetic";
    if (!single && lines.length <= f.lines) {            // sit on the ruled lines
      lines.forEach((l, i) => ctx.fillText(l, x + padX * k, (f.y + (i + 1) * slotH - slotH * 0.3) * k));
    } else {                                              // centre the block in the box
      const blockH = lines.length * lineH, top = f.y + (f.h - blockH) / 2;
      lines.forEach((l, i) => ctx.fillText(l, x + padX * k, (top + (i + 0.8) * lineH) * k));
    }
  }
  function drawTick(ctx, f, k) {
    ctx.strokeStyle = TEXT_INK; ctx.lineWidth = 2.6 * k; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo((f.x + f.w * 0.18) * k, (f.y + f.h * 0.55) * k);
    ctx.lineTo((f.x + f.w * 0.42) * k, (f.y + f.h * 0.8) * k); ctx.lineTo((f.x + f.w * 0.88) * k, (f.y + f.h * 0.18) * k); ctx.stroke();
  }
  function drawTexts(ctx, i, k) {
    for (const f of fieldsOn(i)) {
      const v = cur.text[f.id]; if (!v) continue;
      if (f.kind === "check") drawTick(ctx, f, k); else drawFieldText(ctx, f, v, k);
    }
  }
  function redrawText(i) {
    const p = cur.pages[i]; const k = p.tcanvas.width / SHEET_W;
    p.tctx.clearRect(0, 0, p.tcanvas.width, p.tcanvas.height); drawTexts(p.tctx, i, k);
  }
  function fieldAt(page, [x, y]) {
    let best = null;
    for (const f of fieldsOn(page)) {
      const pad = f.kind === "check" ? 9 : 5, extraR = f.kind === "check" ? 46 : 0;
      if (x >= f.x - pad && x <= f.x + f.w + pad + extraR && y >= f.y - pad && y <= f.y + f.h + pad) {
        const a = f.w * f.h; if (!best || a < best.a) best = { f, a };
      }
    }
    return best && best.f;
  }
  async function saveText() {
    try { await DB.set(`d:${cur.meta.id}:text`, cur.text); touch(); setSaved("Saved"); } catch (e) { console.warn("text save failed", e); }
  }
  function setText(f, value, undoable = true) {
    if (undoable) pushUndo({ type: "text", id: f.id, page: f.page, prev: cur.text[f.id] });
    if (value) cur.text[f.id] = value; else delete cur.text[f.id];
    redrawText(f.page); saveText();
  }
  function openTextEditor(f) {
    const body = openModal(f.label);
    const ta = document.createElement("textarea");
    ta.className = "dictate"; ta.rows = f.lines > 1 ? Math.min(8, f.lines * 2) : 2; ta.value = cur.text[f.id] || "";
    ta.setAttribute("autocapitalize", "sentences"); ta.setAttribute("enterkeyhint", "done");
    body.append(ta);
    const tip = document.createElement("p"); tip.className = "tip"; tip.textContent = "Tap the 🎤 on the keyboard and talk, or type."; body.append(tip);
    const done = document.createElement("button"); done.className = "big gold"; done.textContent = "Done"; body.append(done);
    done.onclick = () => { closeModal(); setText(f, ta.value.trim()); };
    if (ta.value) {
      const clr = document.createElement("button"); clr.className = "big light"; clr.textContent = "Clear this box"; body.append(clr);
      clr.onclick = () => { closeModal(); setText(f, ""); };
    }
    if (f.lines <= 1) ta.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); done.click(); } });
    ta.focus();                                             // same tap, so iPad raises the keyboard
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
  }

  function toSheet(p, e) {
    const r = p.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * SHEET_W, (e.clientY - r.top) / r.height * SHEET_H, e.pressure || 0.5];
  }
  const isPenLike = e => e.pointerType === "pen" || e.pointerType === "mouse";
  let lastPointerType = "";

  function bindInk(p) {
    const c = p.canvas;
    c.addEventListener("click", e => {
      if (!cur || lastPointerType !== "touch") return;    // Pencil taps are ink, not a box tap
      const f = fieldAt(p.index, toSheet(p, e)); if (!f) return;
      if (f.kind === "check") { setText(f, cur.text[f.id] ? "" : "x"); }
      else openTextEditor(f);
    });
    c.addEventListener("pointerdown", e => {
      lastPointerType = e.pointerType;
      if (!cur || !isPenLike(e) || e.button > 0) return;
      e.preventDefault(); try { c.setPointerCapture(e.pointerId); } catch (_) {}
      const pt = toSheet(p, e);
      if (tool === "pen") {
        const stroke = { pts: [pt] }; cur.strokes[p.index].push(stroke);
        cur.drawing = { p, stroke, id: e.pointerId }; drawStroke(p.ctx, stroke, c.width / SHEET_W);
      } else { cur.drawing = { p, erased: [], id: e.pointerId }; eraseAt(p, pt); }
    });
    c.addEventListener("pointermove", e => {
      const d = cur && cur.drawing; if (!d || d.id !== e.pointerId) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; const k = c.width / SHEET_W;
      for (const ev of (evs.length ? evs : [e])) {
        const pt = toSheet(p, ev);
        if (d.stroke) {
          const last = d.stroke.pts[d.stroke.pts.length - 1];
          if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.4) continue;
          d.stroke.pts.push(pt); drawStroke(p.ctx, d.stroke, k, d.stroke.pts.length - 1);
        } else eraseAt(p, pt);
      }
    });
    const end = e => {
      const d = cur && cur.drawing; if (!d || d.id !== e.pointerId) return;
      cur.drawing = null; cur.lastPenUp = Date.now();
      if (d.stroke) { pushUndo({ type: "ink", page: p.index, stroke: d.stroke }); scheduleSave(); }
      else if (d.erased.length) { pushUndo({ type: "erase", page: p.index, items: d.erased }); scheduleSave(); }
    };
    c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
  }
  function eraseAt(p, [x, y]) {
    const list = cur.strokes[p.index]; let hit = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].pts.some(q => Math.hypot(q[0] - x, q[1] - y) < ERASE_R)) { cur.drawing.erased.push({ stroke: list[i], idx: i }); list.splice(i, 1); hit = true; }
    }
    if (hit) redraw(p.index);
  }
  // Pencil (and a resting palm while writing) must not scroll the page. Fingers still scroll.
  document.addEventListener("touchstart", e => {
    if ([...e.touches].some(t => t.touchType === "stylus") && e.target.closest && e.target.closest("canvas.ink")) e.preventDefault();
  }, { passive: false });
  document.addEventListener("touchmove", e => {
    if (!cur) return;
    const stylus = [...e.touches].some(t => t.touchType === "stylus");
    if (stylus || cur.drawing || Date.now() - cur.lastPenUp < 350) { if (e.cancelable) e.preventDefault(); }
  }, { passive: false });

  /* ---------------- undo ---------------- */
  function pushUndo(a) { cur.undo.push(a); if (cur.undo.length > 300) cur.undo.shift(); }
  function undo() {
    if (!cur) return; const a = cur.undo.pop(); if (!a) { toast("Nothing to undo."); return; }
    if (a.type === "ink") { const l = cur.strokes[a.page]; const i = l.lastIndexOf(a.stroke); if (i >= 0) l.splice(i, 1); redraw(a.page); scheduleSave(); }
    else if (a.type === "erase") { const l = cur.strokes[a.page]; a.items.slice().reverse().forEach(it => l.splice(Math.min(it.idx, l.length), 0, it.stroke)); redraw(a.page); scheduleSave(); }
    else if (a.type === "photo") setPhoto(a.id, a.prev, false);
    else if (a.type === "text") { if (a.prev) cur.text[a.id] = a.prev; else delete cur.text[a.id]; redrawText(a.page); saveText(); }
  }

  /* ---------------- photos ---------------- */
  let pendingSlot = null;
  function renderSlot(id) {
    const b = document.querySelector(`.slot[data-id="${id}"]`); if (!b) return;
    if (cur.photoUrls[id]) { URL.revokeObjectURL(cur.photoUrls[id]); delete cur.photoUrls[id]; }
    const blob = cur.photos[id];
    if (blob) {
      const u = cur.photoUrls[id] = URL.createObjectURL(blob); b.innerHTML = `<img alt="" draggable="false" src="${u}">`; b.classList.add("has");
      const im = b.querySelector("img");
      im.onload = () => { if (im.naturalWidth / im.naturalHeight > WIDE) { im.style.objectFit = "contain"; b.style.background = "#F1F3F6"; } };
    }
    else { b.innerHTML = `<span class="empty">${ICON_CAM}<span>Tap for photo</span></span>`; b.classList.remove("has"); b.style.background = ""; }
  }
  function setPhoto(id, blob, undoable = true) {
    if (undoable) pushUndo({ type: "photo", id, prev: cur.photos[id] || null });
    if (blob) cur.photos[id] = blob; else delete cur.photos[id];
    renderSlot(id); savePhoto(id);
  }
  async function shrink(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const s = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight), Math.sqrt(PHOTO_MAX_PIXELS / (img.naturalWidth * img.naturalHeight)));
      const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const out = await new Promise(r => c.toBlob(r, "image/jpeg", 0.86)); c.width = c.height = 0; return out;
    } finally { URL.revokeObjectURL(url); }
  }
  const slotLabel = s => s.label || s.room || s.id;

  function openPhotoMenu(slot) {
    const has = !!cur.photos[slot.id];
    const lbl = slotLabel(slot); const body = openModal(/^photo/i.test(lbl) ? lbl : lbl + " photo");
    const btn = (html, cls, fn) => { const b = document.createElement("button"); b.className = "big " + cls; b.innerHTML = html; b.onclick = fn; body.append(b); };
    btn(ICON_CAM.replace("<svg", '<svg width="24" height="24" style="fill:none;stroke:currentColor;stroke-width:1.8"') + (has ? "Retake photo" : "Take photo"), "", () => {
      pendingSlot = slot.id; closeModal(); $("#camInput").value = ""; $("#camInput").click();
    });
    btn("Choose from Photos", "light", () => { pendingSlot = slot.id; closeModal(); $("#libInput").value = ""; $("#libInput").click(); });
    const tip = document.createElement("p"); tip.style.cssText = "margin:-4px 2px 2px;font-size:13px";
    tip.textContent = "Pano: take it in the Camera app first, then choose it here."; body.append(tip);
    btn("Paste from iPhone", "light", () => pasteInto(slot.id));
    if (cur.meta.leadId) btn("Use a Listing Lead photo", "light", () => pickFromLead(slot));
    if (has) {
      btn("View photo", "light", () => { closeModal(); const v = $("#viewer"); v.querySelector("img").src = cur.photoUrls[slot.id]; v.hidden = false; });
      btn("Remove photo", "danger", () => { closeModal(); setPhoto(slot.id, null); toast("Photo removed. Tap Undo to bring it back."); });
    }
  }

  async function pasteInto(id) {
    closeModal();
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) throw new Error("no clipboard");
      for (const it of await navigator.clipboard.read()) {
        const type = it.types.find(t => t.startsWith("image/"));
        if (type) { setPhoto(id, await shrink(await it.getType(type))); toast("Photo added."); return; }
      }
      toast("No photo to paste. On the iPhone: open the photo, tap Share, then Copy. Then try again.");
    } catch (e) {
      if (e && e.name === "NotAllowedError") return;
      toast("Couldn't paste. On the iPhone: open the photo, tap Share, then Copy. Then tap Paste again.");
    }
  }

  async function leadPhotos(leadId) {
    const keys = (await DB.keys()).filter(k => String(k).startsWith(`d:${leadId}:p:`));
    const out = [];
    for (const k of keys) { const b = await DB.get(k); if (b) out.push({ key: k, blob: b }); }
    return out;
  }
  async function pickFromLead(slot) {
    const lead = docs.find(d => d.id === cur.meta.leadId);
    const photos = lead ? await leadPhotos(lead.id) : [];
    if (!photos.length) { closeModal(); toast(lead ? "That Listing Lead has no photos." : "The linked Listing Lead was deleted."); return; }
    const body = openModal(`From Listing Lead: ${lead.name}`);
    const grid = document.createElement("div"); grid.className = "pick"; body.append(grid);
    const urls = [];
    photos.forEach(ph => {
      const u = URL.createObjectURL(ph.blob); urls.push(u);
      const b = document.createElement("button"); b.innerHTML = `<img alt="" src="${u}">`;
      b.onclick = () => { closeModal(); setPhoto(slot.id, ph.blob); toast("Photo added."); };
      grid.append(b);
    });
    onModalClose = () => urls.forEach(u => URL.revokeObjectURL(u));
  }

  /* ---------------- PDF ---------------- */
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  async function renderPageCanvas(i, scale) {
    const p = cur.pages[i];
    const c = document.createElement("canvas"); c.width = SHEET_W * scale; c.height = SHEET_H * scale;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(p.bg.complete && p.bg.naturalWidth ? p.bg : await loadImg(p.bg.src), 0, 0, c.width, c.height);
    for (const s of cur.layout.slots.filter(s => s.page === i && cur.photos[s.id])) {
      const img = await loadImg(cur.photoUrls[s.id]);
      const bx = s.x * scale, by = s.y * scale, bw = s.w * scale, bh = s.h * scale;
      ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
      if (img.naturalWidth / img.naturalHeight > WIDE) {          // panorama: show it whole
        const r = Math.min(bw / img.naturalWidth, bh / img.naturalHeight), w = img.naturalWidth * r, h = img.naturalHeight * r;
        ctx.fillStyle = "#F1F3F6"; ctx.fillRect(bx, by, bw, bh); ctx.drawImage(img, bx + (bw - w) / 2, by + (bh - h) / 2, w, h);
      } else {                                                      // normal photo: fill the box
        const r = Math.max(bw / img.naturalWidth, bh / img.naturalHeight), sw = bw / r, sh = bh / r;
        ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, bx, by, bw, bh);
      }
      ctx.restore();
      ctx.strokeStyle = "#B9BFC9"; ctx.lineWidth = scale * 0.75; ctx.strokeRect(bx, by, bw, bh);
    }
    drawTexts(ctx, i, scale);
    for (const s of cur.strokes[i]) drawStroke(ctx, s, scale);
    return c;
  }
  async function buildPdf() {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "pt", format: "letter", compress: true });
    const PW = 612, PH = 792;
    for (let i = 0; i < cur.pages.length; i++) {
      if (i) pdf.addPage();
      const c = await renderPageCanvas(i, 2);
      pdf.addImage(c.toDataURL("image/jpeg", 0.88), "JPEG", 0, 0, PW, PH, undefined, "FAST"); c.width = c.height = 0;
    }
    const withPhotos = cur.layout.slots.filter(s => cur.photos[s.id]);
    const per = 2, total = Math.ceil(withPhotos.length / per);
    for (let n = 0; n < withPhotos.length; n++) {
      const k = n % per;
      if (k === 0) {
        pdf.addPage();
        pdf.setFillColor(27, 42, 73); pdf.rect(36, 36, PW - 72, 26, "F"); pdf.setFillColor(184, 144, 58); pdf.rect(36, 36, 6, 26, "F");
        pdf.setTextColor(255, 255, 255); pdf.setFont("helvetica", "bold"); pdf.setFontSize(10.5);
        pdf.text(`PHOTOS  |  ${cur.meta.name || ""}`.toUpperCase().slice(0, 80), 50, 53);
        pdf.setDrawColor(185, 191, 201); pdf.setLineWidth(0.5); pdf.line(36, PH - 40, PW - 36, PH - 40);
        pdf.setTextColor(140, 150, 168); pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5);
        pdf.text(`Susan Taylor Real Estate Group  |  ${FORMS[cur.meta.type].title}  |  Confidential seller information`, 36, PH - 28);
        pdf.text(`Photos ${Math.floor(n / per) + 1} of ${total}`, PW - 36, PH - 28, { align: "right" });
      }
      const s = withPhotos[n], top = 78 + k * 328;
      pdf.setTextColor(27, 42, 73); pdf.setFont("helvetica", "bold"); pdf.setFontSize(12); pdf.text(slotLabel(s), 36, top + 10);
      const img = await loadImg(cur.photoUrls[s.id]);
      const maxW = PW - 72, maxH = 296, r = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = img.naturalWidth * r, h = img.naturalHeight * r;
      pdf.addImage(await blobToDataURL(cur.photos[s.id]), "JPEG", 36 + (maxW - w) / 2, top + 18, w, h, undefined, "FAST");
    }
    return pdf.output("blob");
  }
  const blobToDataURL = b => new Promise(res => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(b); });
  const cleanName = s => (s || "").replace(/[\\/:*?"<>|]+/g, "-").trim();

  function openSaveDialog() {
    const body = openModal("Save as PDF");
    const def = `${cleanName(cur.meta.name) || "Property"} - ${FORMS[cur.meta.type].title}`;
    body.innerHTML = `<p>File name:</p><input type="text" id="fname" value="${esc(def)}" autocomplete="off">`;
    const go = document.createElement("button"); go.className = "big gold"; go.textContent = "Make PDF"; body.append(go);
    go.onclick = async () => {
      const name = cleanName($("#fname").value) || def;
      closeModal(); $("#busy").hidden = false;
      try {
        await flushInk();
        const blob = await buildPdf(); $("#busy").hidden = true;
        offerPdf(new File([blob], name.endsWith(".pdf") ? name : name + ".pdf", { type: "application/pdf" }));
      } catch (e) { console.error(e); $("#busy").hidden = true; toast("Sorry, the PDF didn't work. Try again; your work is still here."); }
    };
  }
  function offerPdf(file) {
    const url = URL.createObjectURL(file); window.__lastPdf = file;
    const body = openModal("PDF ready");
    body.innerHTML = `<p>Tap <b>Share / Save</b>, then <b>Save to Files</b> and pick the SharePoint folder.</p>`;
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    if (canShare) {
      const b = document.createElement("button"); b.className = "big gold"; b.textContent = "Share / Save"; body.append(b);
      b.onclick = async () => { try { await navigator.share({ files: [file], title: file.name }); closeModal(); } catch (e) {} };
    }
    const a = document.createElement("a"); a.className = "big light"; a.href = url; a.download = file.name; a.target = "_blank";
    a.textContent = canShare ? "Open PDF" : "Download PDF"; a.style.textDecoration = "none"; body.append(a);
    onModalClose = () => setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------------- home screen ---------------- */
  const fmtDate = t => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  function renderHome() {
    const list = $("#list"); list.innerHTML = "";
    const sorted = docs.slice().sort((a, b) => b.updated - a.updated);
    if (!sorted.length) { list.innerHTML = `<div class="empty-list">No saved forms yet. Start a Listing Lead above.</div>`; return; }
    for (const d of sorted) {
      const f = FORMS[d.type] || FORMS.lead;
      const row = document.createElement("div"); row.className = "item";
      const linked = d.leadId && docs.find(x => x.id === d.leadId);
      row.innerHTML = `<button class="open"><span class="tag ${d.type}">${f.tag}</span><b>${esc(d.name || "Untitled")}</b>
        <small>${f.title} · updated ${fmtDate(d.updated)}${linked ? " · linked to Listing Lead" : ""}</small></button>`;
      row.querySelector(".open").onclick = () => openDoc(d);
      if (d.type === "lead") {
        const b = document.createElement("button"); b.className = "act go"; b.textContent = "Start Details";
        b.onclick = () => startDetailsFromLead(d); row.append(b);
      }
      const del = document.createElement("button"); del.className = "act"; del.textContent = "Delete";
      del.onclick = () => confirmDelete(d); row.append(del);
      list.append(row);
    }
  }

  /* Lead -> Details: copy shared answers (typed text and the actual Pencil strokes) */
  const LEAD_TO_DETAILS = {
    "seller-name-s": "seller-name-s", "property-address": "property-address", "best-phone": "mobile", "email": "email-1",
    "mortgage-yes": "current-financing-on-the-property-yes", "mortgage-no": "current-financing-on-the-property-no",
    "style": "style", "approx-sq-ft": "approx-size-sq-ft", "beds": "bedrooms", "baths": "baths", "parking-garage": "garage",
  };
  const BASEMENT = { "basement-finished-yes": "Finished", "basement-finished-partly": "Partly finished", "basement-finished-no": "Unfinished" };
  function strokeCentre(st) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of st.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  const inRect = ([x, y], f, pad) => x >= f.x - pad && x <= f.x + f.w + pad && y >= f.y - pad && y <= f.y + f.h + pad;
  async function prefillFromLead(detailsId, leadId) {
    const L = await getLayout("lead"), D = await getLayout("details");
    const lText = (await DB.get(`d:${leadId}:text`)) || {}, lInk = (await DB.get(`d:${leadId}:ink`)) || [];
    const text = {}, ink = Array.from({ length: D.pages }, () => []);
    const fld = (lay, id) => (lay.fields || []).find(f => f.id === id);
    let n = 0;
    for (const [from, to] of Object.entries(LEAD_TO_DETAILS)) {
      const lf = fld(L, from), df = fld(D, to); if (!lf || !df) continue;
      let got = false;
      if (lText[from]) { text[to] = lText[from]; got = true; }
      const strokes = (lInk[lf.page] || []).filter(st => st.pts && st.pts.length && inRect(strokeCentre(st), lf, 4));
      if (strokes.length) {
        const k = Math.min(df.w / lf.w, df.h / lf.h, 1);
        ink[df.page].push(...strokes.map(st => ({ pts: st.pts.map(([x, y, pr]) => [df.x + (x - lf.x) * k, df.y + (y - lf.y) * k, pr]) })));
        got = true;
      }
      if (got) n++;
    }
    for (const [from, label] of Object.entries(BASEMENT)) if (lText[from]) { text["basement-bath-bedroom-rec-room"] = label; n++; break; }
    await DB.set(`d:${detailsId}:text`, text); await DB.set(`d:${detailsId}:ink`, ink);
    return n;
  }

  async function createDoc(type, name, leadId) {
    const now = Date.now();
    const meta = { id: newId(), type, name: name || "Untitled", leadId: leadId || null, created: now, updated: now };
    let copied = 0;
    if (type === "details" && leadId) { try { copied = await prefillFromLead(meta.id, leadId); } catch (e) { console.warn("prefill failed", e); } }
    docs.push(meta); await saveDocs(); await openDoc(meta);
    if (leadId) toast(copied ? `Copied ${copied} answer${copied > 1 ? "s" : ""} from the Listing Lead. Its photos are in each photo box.`
                             : "Linked to the Listing Lead. Its photos are in each photo box.");
  }

  function nameDialog(title, initial, cta, onOk, extra) {
    const body = openModal(title);
    body.innerHTML = `<div class="lbl2">Property (address)</div><input type="text" id="pname" placeholder="e.g. 12 Bur Oak Ave" value="${esc(initial || "")}" autocomplete="off">`;
    if (extra) extra(body);
    const go = document.createElement("button"); go.className = "big gold"; go.textContent = cta; body.append(go);
    go.onclick = () => { const v = $("#pname").value.trim(); closeModal(); onOk(v); };
    setTimeout(() => { try { $("#pname").focus(); } catch (e) {} }, 50);
  }

  function newLead() { nameDialog("New Listing Lead", "", "Start", name => createDoc("lead", name)); }

  function newDetails() {
    let chosen = null;
    const leads = docs.filter(d => d.type === "lead").sort((a, b) => b.updated - a.updated);
    nameDialog("New Listing Details", "", "Start", name => createDoc("details", name || (chosen && chosen.name), chosen && chosen.id), body => {
      if (!leads.length) return;
      const h = document.createElement("div"); h.className = "lbl2"; h.textContent = "Link to a Listing Lead (brings its photos)"; body.append(h);
      leads.slice(0, 6).forEach(l => {
        const b = document.createElement("button"); b.className = "choice";
        b.innerHTML = `${esc(l.name)}<small>Listing Lead · ${fmtDate(l.updated)}</small>`;
        b.onclick = () => {
          const on = chosen !== l; chosen = on ? l : null;
          body.querySelectorAll(".choice").forEach(x => x.classList.remove("sel")); if (on) b.classList.add("sel");
          const inp = $("#pname"); if (on && !inp.value.trim()) inp.value = l.name;
        };
        body.append(b);
      });
    });
  }

  function startDetailsFromLead(lead) {
    const existing = docs.find(d => d.type === "details" && d.leadId === lead.id);
    if (existing) { openDoc(existing); toast("Opened the Listing Details already started for this property."); return; }
    createDoc("details", lead.name, lead.id);
  }

  function confirmDelete(d) {
    const body = openModal(`Delete "${d.name}"?`);
    body.innerHTML = `<p>This removes the ${FORMS[d.type].title} and its photos from this iPad. Save the PDF first if you need it.</p>`;
    const b = document.createElement("button"); b.className = "big danger"; b.textContent = "Delete"; body.append(b);
    b.onclick = async () => {
      closeModal();
      try { await DB.delMany((await DB.keys()).filter(k => String(k).startsWith(`d:${d.id}:`))); } catch (e) {}
      docs = docs.filter(x => x.id !== d.id); await saveDocs(); renderHome(); toast("Deleted.");
    };
  }

  function rename() {
    nameDialog("Rename", cur.meta.name, "Save", v => { if (v) { cur.meta.name = v; touch(); setTitle(); } });
  }

  /* ---------------- modal / toast ---------------- */
  let onModalClose = null;
  function openModal(title) {
    if (onModalClose) { onModalClose(); onModalClose = null; }
    $("#sheetTitle").textContent = title; const body = $("#sheetBody"); body.innerHTML = ""; $("#sheet").hidden = false; return body;
  }
  function closeModal() { $("#sheet").hidden = true; if (onModalClose) { onModalClose(); onModalClose = null; } }
  let toastTimer;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 4200); }
  function setTool(t) { tool = t; $("#tPen").classList.toggle("on", t === "pen"); $("#tEraser").classList.toggle("on", t === "eraser"); }

  /* ---------------- boot ---------------- */
  async function init() {
    $("#tPen").onclick = () => setTool("pen");
    $("#tEraser").onclick = () => setTool("eraser");
    $("#tUndo").onclick = undo;
    $("#bSave").onclick = openSaveDialog;
    $("#bBack").onclick = closeDoc;
    $("#docTitle").onclick = rename;
    $("#newLead").onclick = newLead;
    $("#newDetails").onclick = newDetails;
    document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => { closeModal(); $("#viewer").hidden = true; });
    $("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeModal(); });
    const onPicked = async e => {
      const f = e.target.files && e.target.files[0]; const id = pendingSlot; pendingSlot = null;
      if (!f || !id || !cur) return;
      try { setPhoto(id, await shrink(f)); } catch (err) { toast("Couldn't use that photo. Try again."); }
    };
    $("#camInput").addEventListener("change", onPicked);
    $("#libInput").addEventListener("change", onPicked);
    document.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key === "z" && cur) { e.preventDefault(); undo(); } });
    document.addEventListener("visibilitychange", () => { if (document.hidden) flushInk(); });

    try { docs = (await DB.get("docs")) || []; } catch (e) { console.warn("storage unavailable", e); docs = docs || []; }
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    renderHome();
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.__app = { get cur() { return cur; }, get docs() { return docs; }, buildPdf, DB };   // test hooks
  init();
})();
