/* STG Field Notes: Listing Lead + Listing Details.
   Apple Pencil writes, finger taps type/dictate/tick, finger drags scroll. Saved per property.
   Listing Lead grows room by room. Works offline. Exports PDF. */
(() => {
  "use strict";

  const SHEET_W = 816, SHEET_H = 1056;
  const INK = "#14213D", PEN_W = 2.1, ERASE_R = 11, PHOTO_MAX_SIDE = 4096, PHOTO_MAX_PIXELS = 2.4e6, WIDE = 2.1;
  const FORMS = {
    lead:    { title: "Listing Lead",    tag: "FIRST VISIT",    layout: "lead-layout.json",    prefix: "lead-" },
    details: { title: "Listing Details", tag: "LISTING SIGNED", layout: "details-layout.json", prefix: "details-" },
  };
  // Room picker. "to" = the matching Listing Details row, so notes + photos carry over.
  const ROOM_CHOICES = [
    ["Kitchen", "kitchen"], ["Breakfast area", "breakfast-area"], ["Living room", "living"], ["Dining room", "dining"],
    ["Family room", "family"], ["Primary bedroom", "master"], ["Primary bath", "master-bath"], ["Bedroom 2", "bed-2"],
    ["Bedroom 3", "bed-3"], ["Bedroom 4", "bed-4"], ["Main bath", "main-bath"], ["Powder room", null], ["Basement", "basement"],
    ["Laundry", "laundry"], ["Office", null], ["Garage", null], ["Front exterior", null], ["Backyard", "backyard"],
  ];
  const ROOM_ALIASES = { master: "master", "masterbedroom": "master", "primary": "master", "masterbath": "master-bath", "ensuite": "master-bath",
    "living": "living", "dining": "dining", "family": "family", "bed2": "bed-2", "bed3": "bed-3", "bed4": "bed-4", "bedroom2": "bed-2",
    "bedroom3": "bed-3", "bedroom4": "bed-4", "yard": "backyard", "backyard": "backyard", "laundryroom": "laundry", "breakfast": "breakfast-area" };
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  function detailsRoomFor(name) {
    const n = norm(name); if (!n) return null;
    for (const [label, to] of ROOM_CHOICES) if (to && norm(label) === n) return to;
    return ROOM_ALIASES[n] || null;
  }

  const ICON_CAM = '<svg viewBox="0 0 24 24"><path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.6"/></svg>';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

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

  let docs = [];
  const saveDocs = () => DB.set("docs", docs).catch(e => console.warn(e));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const layouts = {};
  async function getLayout(type) {
    if (!layouts[type]) {
      const L = await fetch(FORMS[type].layout).then(r => r.json());
      for (const x of [...(L.slots || []), ...(L.fields || [])]) if (!x.pageKey) x.pageKey = "f" + x.page;
      if (!L.pageList) L.pageList = Array.from({ length: L.pages }, (_, i) => ({ key: "f" + i, bg: `${FORMS[type].prefix}page-${i + 1}.png` }));
      layouts[type] = L;
    }
    return layouts[type];
  }
  // stored formats: ink was an array by page index, photos were single Blobs
  const inkToMap = v => Array.isArray(v) ? Object.fromEntries(v.map((s, i) => ["f" + i, Array.isArray(s) ? s : []])) : (v && typeof v === "object" ? v : {});
  const asList = v => v ? (Array.isArray(v) ? v.filter(Boolean) : [v]) : [];

  /* ---------------- room geometry (Listing Lead) ---------------- */
  function roomGeom(L, n) {                 // n is 1-based
    const R = L.rooms, k = Math.ceil(n / R.perPage), j = (n - 1) % R.perPage;
    const cx = R.x, cy = R.firstTop + j * (R.h + R.gap), at = r => ({ x: cx + r.x, y: cy + r.y, w: r.w, h: r.h });
    return { pageKey: "r" + k, card: { x: cx, y: cy, w: R.w, h: R.h }, name: at(R.name), notes: at(R.notes), photo: at(R.photo) };
  }
  const roomName = n => (cur && cur.text[`room-${n}-name`]) || "";
  function roomFields(n) {
    const g = roomGeom(cur.layout, n), nm = roomName(n) || `Room ${n}`;
    return [
      { id: `room-${n}-name`, kind: "room", room: n, pageKey: g.pageKey, lines: 1, label: `Room ${n}`, ...g.name },
      { id: `room-${n}-notes`, kind: "text", room: n, pageKey: g.pageKey, lines: cur.layout.rooms.notesLines, label: `${nm}: notes`, ...g.notes },
    ];
  }
  const roomSlot = n => { const g = roomGeom(cur.layout, n); return { id: `room-${n}`, room: n, pageKey: g.pageKey, label: roomName(n) || `Room ${n}`, ...g.photo }; };
  const range = n => Array.from({ length: n }, (_, i) => i + 1);
  const allFields = () => [...(cur.layout.fields || []), ...(cur.layout.rooms ? range(cur.rooms).flatMap(roomFields) : [])];
  const allSlots = () => [...(cur.layout.slots || []), ...(cur.layout.rooms ? range(cur.rooms).map(roomSlot) : [])];
  const fieldsOn = key => allFields().filter(f => f.pageKey === key);
  const slotsOn = key => allSlots().filter(s => s.pageKey === key);
  const slotById = id => allSlots().find(s => s.id === id);

  /* ---------------- the open form ---------------- */
  let cur = null, tool = "pen";

  async function openDoc(meta) {
    const layout = await getLayout(meta.type);
    cur = { meta, layout, pages: [], strokes: {}, photos: {}, photoUrls: {}, text: {}, rooms: 0, undo: [], drawing: null, lastPenUp: 0 };
    const id = meta.id;
    try {
      cur.strokes = inkToMap(await DB.get(`d:${id}:ink`));
      const tx = await DB.get(`d:${id}:text`); if (tx && typeof tx === "object") cur.text = tx;
      const keys = (await DB.keys()).filter(k => String(k).startsWith(`d:${id}:p:`));
      for (const k of keys) { const list = asList(await DB.get(k)); if (list.length) cur.photos[String(k).slice(`d:${id}:p:`.length)] = list; }
      if (layout.rooms) cur.rooms = Math.max(1, +(await DB.get(`d:${id}:rooms`)) || 0) || 1;
    } catch (e) { console.warn("load failed", e); }
    if (layout.rooms) await migrateOldLeadPhotos();
    buildPages();
    setTitle(); setSaved("");
    document.body.className = "editing";
    window.scrollTo({ top: 0 });
    try { const n = +(localStorage.getItem("fn-hint") || 0); if (n < 3) { localStorage.setItem("fn-hint", n + 1); toast("Write with the Pencil. Or tap a box with your finger to type or dictate."); } } catch (e) {}
  }

  // Earlier Listing Leads had 6 numbered photo boxes; turn each into a room card.
  async function migrateOldLeadPhotos() {
    const old = Object.keys(cur.photos).filter(k => /^photo-\d+$/.test(k)).sort((a, b) => a.slice(6) - b.slice(6));
    if (!old.length) return;
    let n = cur.rooms === 1 && !cur.photos["room-1"] && !roomName(1) ? 0 : cur.rooms;
    for (const k of old) {
      n++; cur.photos[`room-${n}`] = cur.photos[k]; delete cur.photos[k];
      const cap = cur.text[`${k}-caption`]; if (cap) { cur.text[`room-${n}-name`] = cap; delete cur.text[`${k}-caption`]; }
      await DB.set(`d:${cur.meta.id}:p:room-${n}`, cur.photos[`room-${n}`]); await DB.del(`d:${cur.meta.id}:p:${k}`);
    }
    cur.rooms = Math.max(1, n);
    await DB.set(`d:${cur.meta.id}:rooms`, cur.rooms); await DB.set(`d:${cur.meta.id}:text`, cur.text);
  }

  function buildPages() {
    const doc = $("#doc");
    cur.pages.forEach(p => ro.unobserve(p.el));
    Object.values(cur.photoUrls).flat().forEach(u => URL.revokeObjectURL(u)); cur.photoUrls = {};
    doc.innerHTML = ""; cur.pages = [];
    const L = cur.layout;
    for (const entry of L.pageList) {
      if (entry.dynamic === "rooms") {
        const nPages = Math.ceil(cur.rooms / L.rooms.perPage);
        for (let k = 1; k <= nPages; k++) {
          const p = makePage("r" + k, L.rooms.bg, "rooms");
          range(cur.rooms).filter(n => roomGeom(L, n).pageKey === p.key).forEach(n => {
            const g = roomGeom(L, n).card;
            const im = el("img", "roomcard"); im.src = L.rooms.card; im.alt = ""; im.draggable = false;
            Object.assign(im.style, { left: pct(g.x, SHEET_W), top: pct(g.y, SHEET_H), width: pct(g.w, SHEET_W), height: pct(g.h, SHEET_H) });
            p.el.insertBefore(im, p.tcanvas);
          });
        }
        const add = el("button", "addroom", "<b>＋</b> Add room");
        add.onclick = addRoom; doc.append(add);
      } else makePage(entry.key, entry.bg, "fixed");
    }
    for (const s of allSlots()) {
      const p = cur.pages.find(q => q.key === s.pageKey); if (!p) continue;
      const b = el("button", "slot"); b.dataset.id = s.id;
      Object.assign(b.style, { left: pct(s.x, SHEET_W), top: pct(s.y, SHEET_H), width: pct(s.w, SHEET_W), height: pct(s.h, SHEET_H) });
      b.addEventListener("click", () => openPhotoMenu(s.id));
      p.el.append(b); renderSlot(s.id);
    }
    cur.pages.forEach(p => { ro.observe(p.el); sizeCanvas(p, true); });
  }
  function makePage(key, bgSrc, kind) {
    const pe = el("section", "page"); pe.dataset.key = key;
    const bg = el("img", "bg"); bg.src = bgSrc; bg.alt = ""; bg.draggable = false;
    const tcanvas = el("canvas", "txt"), canvas = el("canvas", "ink");
    pe.append(bg, tcanvas, canvas);
    const before = $("#doc .addroom");
    if (kind === "rooms" && before) $("#doc").insertBefore(pe, before); else $("#doc").append(pe);
    const p = { key, kind, el: pe, bg, canvas, ctx: canvas.getContext("2d"), tcanvas, tctx: tcanvas.getContext("2d") };
    if (!cur.strokes[key]) cur.strokes[key] = [];
    cur.pages.push(p); bindInk(p);
    return p;
  }
  const pageByKey = key => cur.pages.find(p => p.key === key);

  async function closeDoc() {
    if (!cur) return;
    await flushInk();
    cur.pages.forEach(p => ro.unobserve(p.el));
    Object.values(cur.photoUrls).flat().forEach(u => URL.revokeObjectURL(u));
    cur = null; $("#doc").innerHTML = "";
    document.body.className = "at-home";
    renderHome(); window.scrollTo({ top: 0 });
  }

  function setTitle() {
    $("#docTitle").innerHTML = `<small>${esc(FORMS[cur.meta.type].title.toUpperCase())}</small>${esc(cur.meta.name || "Untitled")}`;
  }
  function touch() { if (!cur) return; cur.meta.updated = Date.now(); saveDocs(); }

  const pct = (v, t) => (v / t * 100) + "%";
  const ro = new ResizeObserver(() => cur && cur.pages.forEach(p => sizeCanvas(p)));
  function sizeCanvas(p, force) {
    const r = p.el.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (w && (force || p.canvas.width !== w || p.canvas.height !== h)) {
      p.canvas.width = p.tcanvas.width = w; p.canvas.height = p.tcanvas.height = h; redraw(p.key); redrawText(p.key);
    }
  }

  /* ---------------- saving ---------------- */
  let saveTimer = null;
  function scheduleSave() { setSaved("…"); clearTimeout(saveTimer); saveTimer = setTimeout(flushInk, 700); }
  async function flushInk() {
    if (!saveTimer || !cur) return;
    clearTimeout(saveTimer); saveTimer = null;
    try { await DB.set(`d:${cur.meta.id}:ink`, cur.strokes); touch(); setSaved("Saved"); }
    catch (e) { setSaved(""); console.warn("save failed", e); }
  }
  async function savePhotos(id) {
    const k = `d:${cur.meta.id}:p:${id}`, list = cur.photos[id] || [];
    try { list.length ? await DB.set(k, list) : await DB.del(k); touch(); setSaved("Saved"); } catch (e) { console.warn("photo save failed", e); }
  }
  async function saveText() {
    try { await DB.set(`d:${cur.meta.id}:text`, cur.text); touch(); setSaved("Saved"); } catch (e) { console.warn("text save failed", e); }
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
  function redraw(key) {
    const p = pageByKey(key); if (!p) return; const k = p.canvas.width / SHEET_W;
    p.ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
    for (const s of cur.strokes[key] || []) drawStroke(p.ctx, s, k);
  }

  /* ---------------- typed / dictated text, ticks, page numbers ---------------- */
  const TEXT_INK = "#163172", FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
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
  function drawFieldText(ctx, f, value, k, bold) {
    const padX = 6, padY = 3, x = f.x * k, w = (f.w - 2 * padX) * k;
    const single = f.lines <= 1;
    const text = single ? String(value).replace(/\s*\n\s*/g, " ") : String(value);
    const slotH = single ? f.h : f.h / f.lines;
    let size = Math.min(single ? 17 : 15.5, slotH * (single ? 0.55 : 0.48)), lines, lineH;
    for (;;) {
      ctx.font = `${bold ? "bold " : ""}${size * k}px ${FONT}`;
      lines = wrap(ctx, text, w); lineH = size * 1.25;
      const cap = single ? Math.max(1, Math.floor((f.h - 2 * padY) / lineH)) : Math.max(f.lines, Math.floor((f.h - 2 * padY) / lineH));
      if (lines.length <= cap || size <= 8) { if (lines.length > cap) { lines = lines.slice(0, cap); lines[cap - 1] = lines[cap - 1].replace(/.{0,2}$/, "…"); } break; }
      size -= 0.5;
    }
    ctx.fillStyle = TEXT_INK; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    if (!single && lines.length <= f.lines) lines.forEach((l, i) => ctx.fillText(l, x + padX * k, (f.y + (i + 1) * slotH - slotH * 0.3) * k));
    else { const top = f.y + (f.h - lines.length * lineH) / 2; lines.forEach((l, i) => ctx.fillText(l, x + padX * k, (top + (i + 0.8) * lineH) * k)); }
  }
  function drawTick(ctx, f, k) {
    ctx.strokeStyle = TEXT_INK; ctx.lineWidth = 2.6 * k; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo((f.x + f.w * 0.18) * k, (f.y + f.h * 0.55) * k);
    ctx.lineTo((f.x + f.w * 0.42) * k, (f.y + f.h * 0.8) * k); ctx.lineTo((f.x + f.w * 0.88) * k, (f.y + f.h * 0.18) * k); ctx.stroke();
  }
  function drawTexts(ctx, key, k) {
    for (const f of fieldsOn(key)) {
      const v = cur.text[f.id]; if (!v) continue;
      if (f.kind === "check") drawTick(ctx, f, k); else drawFieldText(ctx, f, v, k, f.kind === "room");
    }
    const pn = cur.layout.pageNumber, idx = cur.pages.findIndex(p => p.key === key);
    if (pn && idx >= 0) {
      ctx.font = `${9.5 * k}px ${FONT}`; ctx.fillStyle = "#8C96A8"; ctx.textAlign = "right"; ctx.textBaseline = "alphabetic";
      ctx.fillText(`Page ${idx + 1} of ${cur.pages.length}`, pn.x * k, pn.y * k); ctx.textAlign = "left";
    }
  }
  function redrawText(key) {
    const p = pageByKey(key); if (!p) return; const k = p.tcanvas.width / SHEET_W;
    p.tctx.clearRect(0, 0, p.tcanvas.width, p.tcanvas.height); drawTexts(p.tctx, key, k);
  }
  function fieldAt(key, [x, y]) {
    let best = null;
    for (const f of fieldsOn(key)) {
      const pad = f.kind === "check" ? 9 : 5, extraR = f.kind === "check" ? 46 : 0;
      if (x >= f.x - pad && x <= f.x + f.w + pad + extraR && y >= f.y - pad && y <= f.y + f.h + pad) {
        const a = f.w * f.h; if (!best || a < best.a) best = { f, a };
      }
    }
    return best && best.f;
  }
  function setText(f, value, undoable = true) {
    if (undoable) pushUndo({ type: "text", id: f.id, pageKey: f.pageKey, prev: cur.text[f.id] });
    if (value) cur.text[f.id] = value; else delete cur.text[f.id];
    redrawText(f.pageKey); saveText();
  }
  function openTextEditor(f) {
    const body = openModal(f.label);
    const ta = el("textarea", "dictate"); ta.rows = f.lines > 1 ? Math.min(8, f.lines * 2) : 2; ta.value = cur.text[f.id] || "";
    ta.setAttribute("autocapitalize", "sentences"); ta.setAttribute("enterkeyhint", "done"); body.append(ta);
    body.append(el("p", "tip", "Tap the 🎤 on the keyboard and talk, or type."));
    const done = el("button", "big gold", "Done"); body.append(done);
    done.onclick = () => { closeModal(); setText(f, ta.value.trim()); };
    if (ta.value) { const clr = el("button", "big light", "Clear this box"); body.append(clr); clr.onclick = () => { closeModal(); setText(f, ""); }; }
    if (f.lines <= 1) ta.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); done.click(); } });
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
  }

  /* ---------------- rooms ---------------- */
  async function addRoom() {
    cur.rooms++; await DB.set(`d:${cur.meta.id}:rooms`, cur.rooms); touch();
    const n = cur.rooms; buildPages();
    const g = roomGeom(cur.layout, n), p = pageByKey(g.pageKey);
    if (p) { const r = p.el.getBoundingClientRect(); window.scrollBy({ top: r.top + r.height * (g.card.y / SHEET_H) - 90, behavior: "smooth" }); }
    openRoomPicker(n);
  }
  function openRoomPicker(n) {
    const f = roomFields(n)[0];
    const body = openModal(`Room ${n}: what room is this?`);
    const grid = el("div", "roomgrid"); body.append(grid);
    for (const [label] of ROOM_CHOICES) {
      const b = el("button", "rchoice" + (roomName(n) === label ? " sel" : ""), esc(label));
      b.onclick = () => { closeModal(); setRoomName(n, label); };
      grid.append(b);
    }
    body.append(el("div", "lbl2", "Or type / dictate a name"));
    const ta = el("textarea", "dictate"); ta.rows = 1; ta.value = ROOM_CHOICES.some(c => c[0] === roomName(n)) ? "" : roomName(n);
    ta.setAttribute("autocapitalize", "words"); ta.setAttribute("enterkeyhint", "done"); body.append(ta);
    const done = el("button", "big gold", "Use this name"); body.append(done);
    done.onclick = () => { closeModal(); setRoomName(n, ta.value.trim()); };
    ta.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); done.click(); } });
    if (n === cur.rooms && cur.rooms > 1) {
      const rm = el("button", "big danger", "Remove this room"); body.append(rm);
      rm.onclick = () => {
        if (!rm.dataset.armed) { rm.dataset.armed = "1"; rm.textContent = "Tap again to remove room, notes and photos"; return; }
        closeModal(); removeLastRoom();
      };
    }
    void f;
  }
  function setRoomName(n, name) {
    const f = roomFields(n)[0];
    setText(f, name);
    renderSlot(`room-${n}`);
  }
  async function removeLastRoom() {
    const n = cur.rooms, g = roomGeom(cur.layout, n);
    delete cur.text[`room-${n}-name`]; delete cur.text[`room-${n}-notes`];
    delete cur.photos[`room-${n}`]; await DB.del(`d:${cur.meta.id}:p:room-${n}`);
    cur.strokes[g.pageKey] = (cur.strokes[g.pageKey] || []).filter(st => !inRect(strokeCentre(st), g.card, 2));
    cur.rooms--; cur.undo = cur.undo.filter(a => (a.pageKey || a.page) !== g.pageKey && a.id !== `room-${n}`);
    await DB.set(`d:${cur.meta.id}:rooms`, cur.rooms); await saveText(); await DB.set(`d:${cur.meta.id}:ink`, cur.strokes);
    if (!range(cur.rooms).some(m => roomGeom(cur.layout, m).pageKey === g.pageKey)) delete cur.strokes[g.pageKey];
    buildPages(); toast("Room removed.");
  }

  /* ---------------- pointer handling ---------------- */
  function toSheet(p, e) {
    const r = p.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * SHEET_W, (e.clientY - r.top) / r.height * SHEET_H, e.pressure || 0.5];
  }
  const isPenLike = e => e.pointerType === "pen" || e.pointerType === "mouse";
  let lastPointerType = "";

  function bindInk(p) {
    const c = p.canvas;
    c.addEventListener("click", e => {
      if (!cur || lastPointerType !== "touch") return;     // Pencil taps are ink, not box taps
      const f = fieldAt(p.key, toSheet(p, e)); if (!f) return;
      if (f.kind === "check") setText(f, cur.text[f.id] ? "" : "x");
      else if (f.kind === "room") openRoomPicker(f.room);
      else openTextEditor(f);
    });
    c.addEventListener("pointerdown", e => {
      lastPointerType = e.pointerType;
      if (!cur || !isPenLike(e) || e.button > 0) return;
      e.preventDefault(); try { c.setPointerCapture(e.pointerId); } catch (_) {}
      const pt = toSheet(p, e);
      if (tool === "pen") {
        const stroke = { pts: [pt] }; cur.strokes[p.key].push(stroke);
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
      if (d.stroke) { pushUndo({ type: "ink", pageKey: p.key, stroke: d.stroke }); scheduleSave(); }
      else if (d.erased.length) { pushUndo({ type: "erase", pageKey: p.key, items: d.erased }); scheduleSave(); }
    };
    c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
  }
  function eraseAt(p, [x, y]) {
    const list = cur.strokes[p.key]; let hit = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].pts.some(q => Math.hypot(q[0] - x, q[1] - y) < ERASE_R)) { cur.drawing.erased.push({ stroke: list[i], idx: i }); list.splice(i, 1); hit = true; }
    }
    if (hit) redraw(p.key);
  }
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
    if (a.type === "ink") { const l = cur.strokes[a.pageKey] || []; const i = l.lastIndexOf(a.stroke); if (i >= 0) l.splice(i, 1); redraw(a.pageKey); scheduleSave(); }
    else if (a.type === "erase") { const l = cur.strokes[a.pageKey]; a.items.slice().reverse().forEach(it => l.splice(Math.min(it.idx, l.length), 0, it.stroke)); redraw(a.pageKey); scheduleSave(); }
    else if (a.type === "photos") setPhotos(a.id, a.prev, false);
    else if (a.type === "text") {
      if (a.prev) cur.text[a.id] = a.prev; else delete cur.text[a.id];
      redrawText(a.pageKey); saveText(); const m = /^room-(\d+)-name$/.exec(a.id); if (m) renderSlot(`room-${m[1]}`);
    }
  }

  /* ---------------- photos (each box holds a list) ---------------- */
  let pendingSlot = null;
  function renderSlot(id) {
    const b = document.querySelector(`.slot[data-id="${id}"]`); if (!b) return;
    (cur.photoUrls[id] || []).forEach(u => URL.revokeObjectURL(u)); delete cur.photoUrls[id];
    const list = cur.photos[id] || [];
    if (list.length) {
      const urls = cur.photoUrls[id] = list.map(x => URL.createObjectURL(x));
      b.innerHTML = `<img alt="" draggable="false" src="${urls[0]}">${list.length > 1 ? `<span class="badge">+${list.length - 1}</span>` : ""}`;
      b.classList.add("has"); b.style.background = "";
      const im = b.querySelector("img");
      im.onload = () => { if (im.naturalWidth / im.naturalHeight > WIDE) { im.style.objectFit = "contain"; b.style.background = "#F1F3F6"; } };
    } else {
      const s = slotById(id);
      b.innerHTML = `<span class="empty">${ICON_CAM}<span>${s && s.room ? "Tap for photos" : "Tap for photo"}</span></span>`;
      b.classList.remove("has"); b.style.background = "";
    }
  }
  function setPhotos(id, list, undoable = true) {
    if (undoable) pushUndo({ type: "photos", id, prev: (cur.photos[id] || []).slice() });
    if (list && list.length) cur.photos[id] = list.slice(); else delete cur.photos[id];
    renderSlot(id); savePhotos(id);
  }
  const addPhoto = (id, blob) => setPhotos(id, [...(cur.photos[id] || []), blob]);
  async function shrink(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const s = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight), Math.sqrt(PHOTO_MAX_PIXELS / (img.naturalWidth * img.naturalHeight)));
      const c = el("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const out = await new Promise(r => c.toBlob(r, "image/jpeg", 0.86)); c.width = c.height = 0; return out;
    } finally { URL.revokeObjectURL(url); }
  }
  const slotLabel = s => s.label || s.room || s.id;

  function openPhotoMenu(id) {
    const slot = slotById(id); if (!slot) return;
    const n = (cur.photos[id] || []).length, lbl = slotLabel(slot);
    const body = openModal(/^photo/i.test(lbl) ? lbl : `${lbl}: photos`);
    const btn = (html, cls, fn) => { const b = el("button", "big " + cls, html); b.onclick = fn; body.append(b); };
    btn(ICON_CAM.replace("<svg", '<svg width="24" height="24" style="fill:none;stroke:currentColor;stroke-width:1.8"') + (n ? "Take another photo" : "Take photo"), "", () => {
      pendingSlot = id; closeModal(); $("#camInput").value = ""; $("#camInput").click();
    });
    btn("Choose from Photos", "light", () => { pendingSlot = id; closeModal(); $("#libInput").value = ""; $("#libInput").click(); });
    body.append(el("p", "tip", "Pano: take it in the Camera app first, then choose it here. You can pick several at once."));
    btn("Paste from iPhone", "light", () => pasteInto(id));
    if (cur.meta.leadId) btn("Use a Listing Lead photo", "light", () => pickFromLead(id));
    if (n) btn(`View or remove photos (${n})`, "light", () => openGallery(id));
  }

  function openGallery(id) {
    const slot = slotById(id), list = cur.photos[id] || [];
    const body = openModal(`${slotLabel(slot)}: ${list.length} photo${list.length > 1 ? "s" : ""}`);
    const grid = el("div", "gallery"); body.append(grid);
    const urls = list.map(b => URL.createObjectURL(b));
    list.forEach((blob, i) => {
      const cell = el("div", "gcell");
      const im = el("button", "gimg", `<img alt="" src="${urls[i]}">`);
      im.onclick = () => { const v = $("#viewer"); v.querySelector("img").src = urls[i]; v.hidden = false; };
      const rm = el("button", "gdel", "Remove");
      rm.onclick = () => { const next = list.filter((_, j) => j !== i); setPhotos(id, next); if (next.length) openGallery(id); else closeModal(); toast("Photo removed. Tap Undo to bring it back."); };
      cell.append(im);
      if (i > 0) { const up = el("button", "gdel", "Make main"); up.onclick = () => { const next = [list[i], ...list.filter((_, j) => j !== i)]; setPhotos(id, next); openGallery(id); }; cell.append(up); }
      cell.append(rm); grid.append(cell);
    });
    onModalClose = () => setTimeout(() => urls.forEach(u => URL.revokeObjectURL(u)), 30000);
  }

  async function pasteInto(id) {
    closeModal();
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) throw new Error("no clipboard");
      for (const it of await navigator.clipboard.read()) {
        const type = it.types.find(t => t.startsWith("image/"));
        if (type) { addPhoto(id, await shrink(await it.getType(type))); toast("Photo added."); return; }
      }
      toast("No photo to paste. On the iPhone: open the photo, tap Share, then Copy. Then try again.");
    } catch (e) {
      if (e && e.name === "NotAllowedError") return;
      toast("Couldn't paste. On the iPhone: open the photo, tap Share, then Copy. Then tap Paste again.");
    }
  }

  async function docPhotos(docId) {
    const keys = (await DB.keys()).filter(k => String(k).startsWith(`d:${docId}:p:`));
    const out = [];
    for (const k of keys) asList(await DB.get(k)).forEach(blob => out.push({ key: k, blob }));
    return out;
  }
  async function pickFromLead(id) {
    const lead = docs.find(d => d.id === cur.meta.leadId);
    const photos = lead ? await docPhotos(lead.id) : [];
    if (!photos.length) { closeModal(); toast(lead ? "That Listing Lead has no photos." : "The linked Listing Lead was deleted."); return; }
    const body = openModal(`From Listing Lead: ${lead.name}`);
    const grid = el("div", "pick"); body.append(grid);
    const urls = [];
    photos.forEach(ph => {
      const u = URL.createObjectURL(ph.blob); urls.push(u);
      const b = el("button", "", `<img alt="" src="${u}">`);
      b.onclick = () => { closeModal(); addPhoto(id, ph.blob); toast("Photo added."); };
      grid.append(b);
    });
    onModalClose = () => urls.forEach(u => URL.revokeObjectURL(u));
  }

  /* ---------------- PDF ---------------- */
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  function drawPhotoInBox(ctx, img, bx, by, bw, bh) {
    ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
    if (img.naturalWidth / img.naturalHeight > WIDE) {
      const r = Math.min(bw / img.naturalWidth, bh / img.naturalHeight), w = img.naturalWidth * r, h = img.naturalHeight * r;
      ctx.fillStyle = "#F1F3F6"; ctx.fillRect(bx, by, bw, bh); ctx.drawImage(img, bx + (bw - w) / 2, by + (bh - h) / 2, w, h);
    } else {
      const r = Math.max(bw / img.naturalWidth, bh / img.naturalHeight), sw = bw / r, sh = bh / r;
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, bx, by, bw, bh);
    }
    ctx.restore();
  }
  async function renderPageCanvas(p, scale) {
    const c = el("canvas"); c.width = SHEET_W * scale; c.height = SHEET_H * scale;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(p.bg.complete && p.bg.naturalWidth ? p.bg : await loadImg(p.bg.src), 0, 0, c.width, c.height);
    if (p.kind === "rooms") {
      const card = await loadImg(cur.layout.rooms.card);
      range(cur.rooms).map(n => roomGeom(cur.layout, n)).filter(g => g.pageKey === p.key)
        .forEach(g => ctx.drawImage(card, g.card.x * scale, g.card.y * scale, g.card.w * scale, g.card.h * scale));
    }
    for (const s of slotsOn(p.key)) {
      const list = cur.photos[s.id] || []; if (!list.length) continue;
      const img = await loadImg(cur.photoUrls[s.id][0]);
      const bx = s.x * scale, by = s.y * scale, bw = s.w * scale, bh = s.h * scale;
      drawPhotoInBox(ctx, img, bx, by, bw, bh);
      ctx.strokeStyle = "#B9BFC9"; ctx.lineWidth = scale * 0.75; ctx.strokeRect(bx, by, bw, bh);
      if (list.length > 1) {
        const t = `+${list.length - 1}`; ctx.font = `bold ${12 * scale}px ${FONT}`; const tw = ctx.measureText(t).width;
        const bw2 = tw + 14 * scale, bh2 = 20 * scale, x2 = bx + bw - bw2 - 6 * scale, y2 = by + bh - bh2 - 6 * scale;
        ctx.fillStyle = "#1B2A49"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x2, y2, bw2, bh2, 10 * scale) : ctx.rect(x2, y2, bw2, bh2); ctx.fill();
        ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(t, x2 + 7 * scale, y2 + bh2 / 2); ctx.textBaseline = "alphabetic";
      }
    }
    drawTexts(ctx, p.key, scale);
    for (const s of cur.strokes[p.key] || []) drawStroke(ctx, s, scale);
    return c;
  }
  async function buildPdf() {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "pt", format: "letter", compress: true });
    const PW = 612, PH = 792;
    for (let i = 0; i < cur.pages.length; i++) {
      if (i) pdf.addPage();
      const c = await renderPageCanvas(cur.pages[i], 2);
      pdf.addImage(c.toDataURL("image/jpeg", 0.88), "JPEG", 0, 0, PW, PH, undefined, "FAST"); c.width = c.height = 0;
    }
    const items = [];
    for (const s of allSlots()) { const list = cur.photos[s.id] || []; list.forEach((b, i) => items.push({ s, b, url: cur.photoUrls[s.id][i], i, n: list.length })); }
    const per = 2, total = Math.ceil(items.length / per);
    for (let m = 0; m < items.length; m++) {
      const k = m % per;
      if (k === 0) {
        pdf.addPage();
        pdf.setFillColor(27, 42, 73); pdf.rect(36, 36, PW - 72, 26, "F"); pdf.setFillColor(184, 144, 58); pdf.rect(36, 36, 6, 26, "F");
        pdf.setTextColor(255, 255, 255); pdf.setFont("helvetica", "bold"); pdf.setFontSize(10.5);
        pdf.text(`PHOTOS  |  ${cur.meta.name || ""}`.toUpperCase().slice(0, 80), 50, 53);
        pdf.setDrawColor(185, 191, 201); pdf.setLineWidth(0.5); pdf.line(36, PH - 40, PW - 36, PH - 40);
        pdf.setTextColor(140, 150, 168); pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5);
        pdf.text(`Susan Taylor Real Estate Group  |  ${FORMS[cur.meta.type].title}  |  Confidential seller information`, 36, PH - 28);
        pdf.text(`Photos ${Math.floor(m / per) + 1} of ${total}`, PW - 36, PH - 28, { align: "right" });
      }
      const it = items[m], top = 78 + k * 328;
      pdf.setTextColor(27, 42, 73); pdf.setFont("helvetica", "bold"); pdf.setFontSize(12);
      pdf.text(slotLabel(it.s) + (it.n > 1 ? `  (${it.i + 1} of ${it.n})` : ""), 36, top + 10);
      const img = await loadImg(it.url);
      const maxW = PW - 72, maxH = 296, r = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = img.naturalWidth * r, h = img.naturalHeight * r;
      pdf.addImage(await blobToDataURL(it.b), "JPEG", 36 + (maxW - w) / 2, top + 18, w, h, undefined, "FAST");
    }
    return pdf.output("blob");
  }
  const blobToDataURL = b => new Promise(res => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(b); });
  const cleanName = s => (s || "").replace(/[\\/:*?"<>|]+/g, "-").trim();

  function openSaveDialog() {
    const body = openModal("Save as PDF");
    const def = `${cleanName(cur.meta.name) || "Property"} - ${FORMS[cur.meta.type].title}`;
    body.innerHTML = `<p>File name:</p><input type="text" id="fname" value="${esc(def)}" autocomplete="off">`;
    const go = el("button", "big gold", "Make PDF"); body.append(go);
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
      const b = el("button", "big gold", "Share / Save"); body.append(b);
      b.onclick = async () => { try { await navigator.share({ files: [file], title: file.name }); closeModal(); } catch (e) {} };
    }
    const a = el("a", "big light", canShare ? "Open PDF" : "Download PDF"); a.href = url; a.download = file.name; a.target = "_blank";
    a.style.textDecoration = "none"; body.append(a);
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
      const row = el("div", "item");
      const linked = d.leadId && docs.find(x => x.id === d.leadId);
      row.innerHTML = `<button class="open"><span class="tag ${d.type}">${f.tag}</span><b>${esc(d.name || "Untitled")}</b>
        <small>${f.title} · updated ${fmtDate(d.updated)}${linked ? " · linked to Listing Lead" : ""}</small></button>`;
      row.querySelector(".open").onclick = () => openDoc(d);
      if (d.type === "lead") { const b = el("button", "act go", "Start Details"); b.onclick = () => startDetailsFromLead(d); row.append(b); }
      const del = el("button", "act", "Delete"); del.onclick = () => confirmDelete(d); row.append(del);
      list.append(row);
    }
  }

  /* Lead -> Details: copy shared answers, typed text and the actual Pencil strokes, plus rooms */
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
  const moveStrokes = (strokes, from, to) => {
    const k = Math.min(to.w / from.w, to.h / from.h, 1);
    return strokes.map(st => ({ pts: st.pts.map(([x, y, pr]) => [to.x + (x - from.x) * k, to.y + (y - from.y) * k, pr]) }));
  };
  async function prefillFromLead(detailsId, leadId) {
    const L = await getLayout("lead"), D = await getLayout("details");
    const lText = (await DB.get(`d:${leadId}:text`)) || {}, lInk = inkToMap(await DB.get(`d:${leadId}:ink`));
    const lRooms = Math.max(1, +(await DB.get(`d:${leadId}:rooms`)) || 1);
    const text = {}, ink = {}, photos = {};
    const fld = (lay, id) => (lay.fields || []).find(f => f.id === id);
    const pushInk = (key, list) => { (ink[key] = ink[key] || []).push(...list); };
    let n = 0;
    for (const [from, to] of Object.entries(LEAD_TO_DETAILS)) {
      const lf = fld(L, from), df = fld(D, to); if (!lf || !df) continue;
      let got = false;
      if (lText[from]) { text[to] = lText[from]; got = true; }
      const strokes = (lInk[lf.pageKey] || []).filter(st => st.pts && st.pts.length && inRect(strokeCentre(st), lf, 4));
      if (strokes.length) { pushInk(df.pageKey, moveStrokes(strokes, lf, df)); got = true; }
      if (got) n++;
    }
    for (const [from, label] of Object.entries(BASEMENT)) if (lText[from]) { text["basement-bath-bedroom-rec-room"] = label; n++; break; }
    // rooms: matching names go to that Details row; others go to Additional notes + the "Additional" photo box
    const extras = [];
    for (let r = 1; r <= lRooms; r++) {
      const name = lText[`room-${r}-name`] || "", notes = lText[`room-${r}-notes`] || "";
      const pv = asList(await DB.get(`d:${leadId}:p:room-${r}`));
      const target = detailsRoomFor(name);
      const tmpCur = { layout: L };
      const g = roomGeom(tmpCur.layout, r);
      const notesInk = (lInk[g.pageKey] || []).filter(st => st.pts && st.pts.length && inRect(strokeCentre(st), g.notes, 4));
      if (!name && !notes && !pv.length && !notesInk.length) continue;
      if (target) {
        const df = fld(D, `${target}-details`);
        if (notes) text[df.id] = text[df.id] ? `${text[df.id]}; ${notes}` : notes;
        if (notesInk.length && df && !(ink[df.pageKey] || []).some(st => inRect(strokeCentre(st), df, 2))) pushInk(df.pageKey, moveStrokes(notesInk, g.notes, df));
        if (pv.length) photos[target] = [...(photos[target] || []), ...pv];
      } else {
        if (name || notes) extras.push(`${name || "Room " + r}${notes ? ": " + notes : ""}`);
        if (pv.length) photos["additional"] = [...(photos["additional"] || []), ...pv];
      }
      n++;
    }
    if (extras.length) text["notes"] = extras.join("\n");
    if (!text["property-address"]) { const lead = docs.find(d => d.id === leadId); if (lead && lead.name && lead.name !== "Untitled") text["property-address"] = lead.name; }
    await DB.set(`d:${detailsId}:text`, text); await DB.set(`d:${detailsId}:ink`, ink);
    for (const [slot, list] of Object.entries(photos)) await DB.set(`d:${detailsId}:p:${slot}`, list);
    return n;
  }

  async function createDoc(type, name, leadId) {
    const now = Date.now();
    const meta = { id: newId(), type, name: name || "Untitled", leadId: leadId || null, created: now, updated: now };
    let copied = 0;
    if (type === "details" && leadId) { try { copied = await prefillFromLead(meta.id, leadId); } catch (e) { console.warn("prefill failed", e); } }
    else if (name) await DB.set(`d:${meta.id}:text`, { "property-address": name });   // the form's name is the address
    docs.push(meta); await saveDocs(); await openDoc(meta);
    if (leadId) toast(copied ? `Copied ${copied} item${copied > 1 ? "s" : ""} from the Listing Lead, rooms and photos included.`
                             : "Linked to the Listing Lead. Its photos are in each photo box.");
    else if (type === "lead") setTimeout(() => toast("Tip: in Room by Room, tap the room name to pick the room, then add notes and photos."), 4500);
  }

  function nameDialog(title, initial, cta, onOk, extra) {
    const body = openModal(title);
    body.innerHTML = `<div class="lbl2">Property address</div><input type="text" id="pname" placeholder="e.g. 12 Bur Oak Ave" value="${esc(initial || "")}" autocomplete="off">`;
    if (extra) extra(body);
    const go = el("button", "big gold", cta); body.append(go);
    go.onclick = () => { const v = $("#pname").value.trim(); closeModal(); onOk(v); };
    setTimeout(() => { try { $("#pname").focus(); } catch (e) {} }, 50);
  }
  function newLead() { nameDialog("New Listing Lead", "", "Start", name => createDoc("lead", name)); }
  function newDetails() {
    let chosen = null;
    const leads = docs.filter(d => d.type === "lead").sort((a, b) => b.updated - a.updated);
    nameDialog("New Listing Details", "", "Start", name => createDoc("details", name || (chosen && chosen.name), chosen && chosen.id), body => {
      if (!leads.length) return;
      body.append(el("div", "lbl2", "Link to a Listing Lead (copies its answers, rooms and photos)"));
      leads.slice(0, 6).forEach(l => {
        const b = el("button", "choice", `${esc(l.name)}<small>Listing Lead · ${fmtDate(l.updated)}</small>`);
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
    const b = el("button", "big danger", "Delete"); body.append(b);
    b.onclick = async () => {
      closeModal();
      try { await DB.delMany((await DB.keys()).filter(k => String(k).startsWith(`d:${d.id}:`))); } catch (e) {}
      docs = docs.filter(x => x.id !== d.id); await saveDocs(); renderHome(); toast("Deleted.");
    };
  }
  function rename() {
    nameDialog("Rename", cur.meta.name, "Save", v => {
      if (!v) return;
      const old = cur.meta.name, addr = cur.text["property-address"];
      cur.meta.name = v; touch(); setTitle();
      if (!addr || addr === old) {                       // keep the address box in step with the name
        const f = allFields().find(x => x.id === "property-address");
        if (f) setText(f, v, false);
      }
    });
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
      const files = [...(e.target.files || [])]; const id = pendingSlot; pendingSlot = null;
      if (!files.length || !id || !cur) return;
      try {
        const blobs = []; for (const f of files) blobs.push(await shrink(f));
        setPhotos(id, [...(cur.photos[id] || []), ...blobs]);
        if (blobs.length > 1) toast(`${blobs.length} photos added.`);
      } catch (err) { toast("Couldn't use that photo. Try again."); }
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

  window.__app = { get cur() { return cur; }, get docs() { return docs; }, buildPdf, DB, roomGeom };   // test hooks
  init();
})();
