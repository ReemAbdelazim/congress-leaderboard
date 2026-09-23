import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc, getDoc,
  increment, writeBatch, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const COLORS = ["#8AD09B", "#7CC4E8", "#E9C46A", "#EE8B7A", "#B9A4E8", "#5CC2B5", "#E79BC0", "#D9C7A1"];
const state = {
  groups: new Map(),            // id -> {id,name,points,color,createdAt}
  settings: { title: "Congress 2026", subtitle: "Live standings", hidden: false },
  log: [],
  user: null,
  isAdmin: false,
  view: "board",
  loaded: false,
  lastUpdate: null,
};
let db = null, auth = null, unsubLog = null;
const pending = new Map();      // id -> unsent delta (admin taps)
const timers = new Map();
const flushing = new Set();
const prevRank = new Map();
const moves = new Map();        // id -> {dir, n, until}
let addColor = COLORS[0];

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}
const fmt = (n) => Math.round(n).toLocaleString();
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const safeColor = (c) => /^#[0-9a-fA-F]{6}$/.test(c || "") ? c : COLORS[0];

let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }
function errMsg(e) {
  const c = e && e.code;
  if (c === "permission-denied") return "That change wasn't saved: this account isn't an organiser.";
  if (c === "resource-exhausted") return "The free daily limit was reached. Try again later or upgrade the Firebase plan.";
  if (c === "unavailable") return "You're offline. The change will save when the connection returns.";
  return "That change wasn't saved. Check your connection and try again.";
}
function setLive(s) {
  $("live").dataset.state = s;
  $("live-text").textContent = s === "live" ? "Live" : s === "off" ? "Offline" : "Syncing";
}

/* ---------- ranking ---------- */
function ranked() {
  const arr = [...state.groups.values()].map(g => ({ ...g }));
  arr.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  let rank = 0;
  arr.forEach((g, i) => { if (i === 0 || g.points !== arr[i - 1].points) rank = i + 1; g.rank = rank; });
  return arr;
}

/* ---------- public board ---------- */
const rowEls = new Map();
function boardMessage(title, text) {
  $("board").replaceChildren(h("div", { class: "state" }, h("h2", { text: title }), h("p", { text })));
  rowEls.clear();
}
function renderBoard(events) {
  $("b-title").textContent = state.settings.title || "Congress 2026";
  $("b-sub").textContent = state.settings.subtitle || "Live standings";
  document.title = (state.settings.title || "Congress 2026") + " · Seeds Congress Leaderboard";
  const board = $("board");
  const list = ranked();
  const now = Date.now();

  for (const g of list) {
    const pr = prevRank.get(g.id);
    if (events && pr != null && pr !== g.rank) moves.set(g.id, { dir: g.rank < pr ? "up" : "down", n: Math.abs(pr - g.rank), until: now + 8000 });
    prevRank.set(g.id, g.rank);
  }

  const meta = $("b-meta"); meta.textContent = "";
  if (list.length && !state.settings.hidden) {
    meta.append(h("div", null, h("strong", { text: String(list.length) }), " groups"));
    if (state.lastUpdate) meta.append(h("div", { text: "Updated " + new Date(state.lastUpdate).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) }));
  }

  if (!state.loaded) return boardMessage("Loading standings", "Connecting to the live leaderboard.");
  if (state.settings.hidden) return boardMessage("Scores are hidden for the reveal", "Stay tuned — final standings will appear here the moment they're unveiled.");
  if (!list.length) return boardMessage("No groups yet", state.isAdmin ? "Open the Admin tab to add the first group." : "Groups will appear here as soon as organisers add them.");

  let podium = board.querySelector(".podium"), listEl = board.querySelector(".list");
  if (!podium) {
    podium = h("div", { class: "podium" });
    for (let p = 1; p <= 3; p++) podium.append(h("div", { class: "slot", "data-place": String(p), "data-medal": String(p) }, h("div", { class: "card" }, h("div", { class: "body" }), h("div", { class: "chips" }))));
    listEl = h("div", { class: "list" });
    board.replaceChildren(podium, listEl);
  }
  const max = Math.max(1, ...list.map(g => g.points));

  list.slice(0, 3).concat([null, null, null]).slice(0, 3).forEach((g, i) => {
    const slot = podium.children[i], card = slot.firstChild, body = card.firstChild;
    const prevId = slot.dataset.gid || "", prevPts = slot.dataset.pts;
    if (!g) {
      slot.dataset.medal = String(i + 1); card.classList.add("empty"); slot.dataset.gid = "";
      body.replaceChildren(h("div", { class: "place" }, h("span", { class: "medal", text: String(i + 1) }), ordinal(i + 1)), h("div", { class: "gname", text: "—" }));
      return;
    }
    card.classList.remove("empty");
    slot.dataset.medal = String(Math.min(g.rank, 3));
    body.replaceChildren(
      h("div", { class: "place" }, h("span", { class: "medal", text: String(g.rank) }), g.rank === 1 ? "Leading" : ordinal(g.rank) + " place"),
      h("div", { class: "gname" }, h("span", { class: "swatch", style: "background:" + safeColor(g.color) }), h("span", { text: g.name })),
      h("div", { class: "pts" }, fmt(g.points), h("small", { text: "pts" }))
    );
    if (prevId !== "" && (prevId !== g.id || prevPts !== String(g.points)) && !reduced) { card.classList.remove("pop"); void card.offsetWidth; card.classList.add("pop"); }
    slot.dataset.gid = g.id; slot.dataset.pts = String(g.points);
    const ev = events && events.get(g.id);
    if (ev) addChip(card.lastChild, ev);
  });

  // Everyone after the podium: keyed rows that slide to their new rank
  const rest = list.slice(3);
  const before = new Map();
  for (const [id, el] of rowEls) before.set(id, el.getBoundingClientRect().top);
  const keep = new Set(rest.map(g => g.id));
  for (const [id, el] of rowEls) if (!keep.has(id)) { el.remove(); rowEls.delete(id); }
  let head = listEl.querySelector(".list-head");
  if (rest.length && !head) listEl.prepend(h("div", { class: "list-head" }, h("span", { text: "Rank" }), h("span", { text: "Group" }), h("span", { text: "Points" })));
  if (!rest.length && head) head.remove();
  for (const g of rest) {
    let el = rowEls.get(g.id);
    if (!el) {
      el = h("div", { class: "row" },
        h("div", { class: "rank" }),
        h("div", { class: "mid" }, h("div", { class: "nm" }, h("span", { class: "swatch" }), h("span", { class: "n" })), h("div", { class: "bar" }, h("i"))),
        h("div", { class: "pts" }), h("div", { class: "chips" }));
      rowEls.set(g.id, el);
    }
    const m = moves.get(g.id);
    const rankEl = el.querySelector(".rank"); rankEl.replaceChildren(String(g.rank));
    if (m && m.until > now) rankEl.append(h("span", { class: "move " + m.dir, text: (m.dir === "up" ? "▲" : "▼") + m.n, "aria-label": (m.dir === "up" ? "up " : "down ") + m.n }));
    el.querySelector(".swatch").style.background = safeColor(g.color);
    el.querySelector(".n").textContent = g.name;
    el.querySelector(".bar i").style.width = Math.max(2, (g.points / max) * 100) + "%";
    el.querySelector(".pts").replaceChildren(fmt(g.points), h("small", { text: "pts" }));
    listEl.append(el);
    const ev = events && events.get(g.id);
    if (ev) addChip(el.querySelector(".chips"), ev);
  }
  if (!reduced) for (const g of rest) {
    const el = rowEls.get(g.id), top = before.get(g.id);
    if (top == null) continue;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 650, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
  const soonest = [...moves.values()].filter(m => m.until > now).map(m => m.until);
  clearTimeout(renderBoard._t);
  if (soonest.length) renderBoard._t = setTimeout(() => renderBoard(null), Math.min(...soonest) - now + 50);
}
function addChip(container, d) {
  const c = h("span", { class: "chip" + (d < 0 ? " neg" : ""), text: (d > 0 ? "+" : "") + fmt(d) });
  container.append(c); setTimeout(() => c.remove(), 2700);
}

/* ---------- admin ---------- */
const aRows = new Map();
// Search: case- and accent-insensitive match on the team name
const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
function paintName(el, name, q) {
  const i = q ? norm(name).indexOf(q) : -1;
  if (i < 0 || norm(name).length !== name.length) { el.textContent = name; return; }
  el.replaceChildren(name.slice(0, i), h("mark", { text: name.slice(i, i + q.length) }), name.slice(i + q.length));
}
function adminMatches() {
  const q = norm($("a-search").value);
  return [...state.groups.values()].filter(g => !q || norm(g.name).includes(q));
}
function renderAdmin() {
  if (!state.isAdmin) return;
  const wrap = $("a-list");
  const q = norm($("a-search").value);
  const sort = $("a-sort").value;
  const rankOf = new Map(ranked().map(g => [g.id, g.rank]));
  const groups = [...state.groups.values()].sort(
    sort === "name" ? (a, b) => a.name.localeCompare(b.name)
    : sort === "points" ? (a, b) => b.points - a.points || a.name.localeCompare(b.name)
    : (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name));
  const note = wrap.querySelector(".empty-note"); if (note) note.remove();
  if (!groups.length) { wrap.replaceChildren(h("p", { class: "empty-note", text: "No groups yet. Add one with the form." })); aRows.clear(); $("a-count").textContent = ""; return; }
  const keep = new Set(groups.map(g => g.id));
  for (const [id, r] of aRows) if (!keep.has(id)) { r.el.remove(); aRows.delete(id); }
  let shown = 0;
  for (const g of groups) {
    let r = aRows.get(g.id);
    if (!r) { r = buildAdminRow(g.id); aRows.set(g.id, r); }
    const match = !q || norm(g.name).includes(q);
    r.el.hidden = !match;   // hide rather than remove, so half-typed amounts survive a search
    if (match) shown++;
    r.sw.style.background = safeColor(g.color);
    paintName(r.name, g.name, q);
    r.rank.textContent = "#" + rankOf.get(g.id);
    const p = pending.get(g.id) || 0;
    r.pts.textContent = fmt(g.points + p);
    r.pts.classList.toggle("pending", p !== 0 || flushing.has(g.id));
    wrap.append(r.el);
  }
  const total = groups.length;
  $("a-count").textContent = q ? `${shown} of ${total} teams match “${$("a-search").value.trim()}”` : `${total} team${total === 1 ? "" : "s"}`;
  if (q && !shown) wrap.append(h("p", { class: "empty-note", text: "No teams match that search. Check the spelling or clear the search." }));
}
$("a-search").addEventListener("input", renderAdmin);
$("a-sort").addEventListener("change", renderAdmin);
$("a-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; renderAdmin(); }
  if (e.key === "Enter") {
    e.preventDefault();
    const m = adminMatches();
    if (m.length === 1) { const inp = document.getElementById("amt-" + m[0].id); inp.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" }); inp.focus(); }
    else if (m.length > 1) toast(`${m.length} teams match. Keep typing to narrow it down.`);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || state.view !== "admin" || !state.isAdmin) return;
  const t = e.target; if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  e.preventDefault(); $("a-search").focus(); $("a-search").select();
});
function buildAdminRow(id) {
  const sw = h("span", { class: "swatch" }), name = h("span", { class: "aname" }), pts = h("span", { class: "apts" }), rank = h("span", { class: "arank", title: "Current rank" });
  const quick = h("div", { class: "quick" }, [-5, -1, 1, 5, 10].map(d => h("button", {
    type: "button", class: d > 0 ? "plus" : "minus", text: (d > 0 ? "+" : "−") + Math.abs(d),
    "aria-label": (d > 0 ? "Add " : "Subtract ") + Math.abs(d), onclick: () => bump(id, d),
  })));
  const amt = h("input", { class: "field", type: "number", step: "1", id: "amt-" + id, placeholder: "Amount", "aria-label": "Custom amount" });
  const addBtn = h("button", { class: "btn", type: "button", text: "Add", onclick: () => {
    const v = Math.round(Number(amt.value));
    if (!amt.value || !Number.isFinite(v) || v === 0) return toast("Enter a number to add (use a minus sign to subtract).");
    bump(id, v, true); amt.value = "";
  } });
  const setBtn = h("button", { class: "btn ghost", type: "button", text: "Set to", onclick: () => {
    const v = Math.round(Number(amt.value));
    if (amt.value === "" || !Number.isFinite(v)) return toast("Enter the exact score to set.");
    setPoints(id, v); amt.value = "";
  } });
  amt.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addBtn.click(); } });
  const custom = h("div", { class: "custom" }, amt, addBtn, setBtn);
  const tools = h("div", { class: "actions" });
  const renameBtn = h("button", { class: "btn ghost", type: "button", text: "Rename", onclick: () => openRename() });
  const colorBtn = h("button", { class: "btn ghost", type: "button", text: "Colour", onclick: () => cycleColor(id) });
  const delBtn = h("button", { class: "btn danger", type: "button", text: "Delete", onclick: () => confirmInline(tools, "Delete this group?", "Delete", () => removeGroup(id), resetTools) });
  function resetTools() { tools.replaceChildren(renameBtn, colorBtn, delBtn); }
  function openRename() {
    const g = state.groups.get(id); if (!g) return;
    const inp = h("input", { class: "field", id: "rn-" + id, maxlength: "60", value: g.name, "aria-label": "New name" });
    const save = async () => { const v = inp.value.trim(); if (!v) return toast("Group name can't be empty."); resetTools(); if (v !== g.name) await renameGroup(id, v); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") resetTools(); });
    tools.replaceChildren(h("div", { class: "rename" }, inp, h("button", { class: "btn primary", type: "button", text: "Save", onclick: save }), h("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: resetTools })));
    inp.focus(); inp.select();
  }
  resetTools();
  const el = h("div", { class: "arow" }, h("div", { class: "line1" }, rank, sw, name, pts), quick, custom, tools);
  return { el, sw, name, pts, rank };
}
function confirmInline(container, question, yes, onYes, onDone) {
  let t;
  const restore = () => { clearTimeout(t); onDone(); };
  container.replaceChildren(h("span", { class: "confirm" }, question,
    h("button", { class: "btn danger solid", type: "button", text: yes, onclick: async () => { restore(); await onYes(); } }),
    h("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: restore })));
  t = setTimeout(restore, 6000);
}
function renderLog() {
  const ul = $("a-log");
  if (!state.log.length) return ul.replaceChildren(h("li", { class: "empty-note", text: "Nothing yet." }));
  ul.replaceChildren(...state.log.map(e => h("li", null, h("time", { text: new Date(e.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }), h("span", { text: e.text }))));
}
function renderDanger() {
  const d = $("danger");
  d.replaceChildren(
    h("button", { class: "btn danger", type: "button", text: "Reset all scores to 0", onclick: () => confirmInline(d, "Set every group to 0?", "Reset scores", resetScores, renderDanger) }),
    h("button", { class: "btn danger", type: "button", text: "Remove all groups", onclick: () => confirmInline(d, "Remove every group?", "Remove all", removeAll, renderDanger) }));
}
function renderSwatches() {
  $("add-swatches").replaceChildren(...COLORS.map(c => h("button", {
    type: "button", style: "background:" + c, "aria-label": "Colour " + c, "aria-pressed": String(c === addColor),
    onclick: () => { addColor = c; renderSwatches(); },
  })));
}
function fillSettingsForm() {
  const t = $("set-title"), s = $("set-sub");
  if (document.activeElement !== t) t.value = state.settings.title || "";
  if (document.activeElement !== s) s.value = state.settings.subtitle || "";
  $("set-hidden").checked = !!state.settings.hidden;
}

/* ---------- writes (atomic increments, so two organisers tapping at once never lose points) ---------- */
const gref = (id) => doc(db, "groups", id);
function need() { if (!db || !state.isAdmin) { toast("Sign in as an organiser to make changes."); return false; } return true; }
function bump(id, d, immediate) {
  if (!need()) return;
  pending.set(id, (pending.get(id) || 0) + d);
  renderAdmin();
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => flush(id), immediate ? 0 : 400));
}
async function flush(id) {
  if (flushing.has(id)) return;
  const d = pending.get(id) || 0; if (!d) return;
  const g = state.groups.get(id); if (!g) { pending.delete(id); return; }
  flushing.add(id); pending.delete(id);
  const p = updateDoc(gref(id), { points: increment(d), updatedAt: Date.now() });
  renderAdmin();
  try { await p; addLog(`${d > 0 ? "+" : "−"}${fmt(Math.abs(d))} to ${g.name}`); }
  catch (e) { toast(errMsg(e)); }
  flushing.delete(id); renderAdmin();
  if (pending.get(id)) flush(id);
}
async function setPoints(id, v) {
  if (!need()) return; const g = state.groups.get(id); if (!g) return;
  try { await updateDoc(gref(id), { points: v, updatedAt: Date.now() }); addLog(`${g.name} set to ${fmt(v)}`); }
  catch (e) { toast(errMsg(e)); }
}
async function renameGroup(id, name) {
  const g = state.groups.get(id); const old = g ? g.name : "";
  try { await updateDoc(gref(id), { name }); addLog(`Renamed ${old} to ${name}`); } catch (e) { toast(errMsg(e)); }
}
async function cycleColor(id) {
  if (!need()) return; const g = state.groups.get(id); if (!g) return;
  const next = COLORS[(COLORS.indexOf(safeColor(g.color)) + 1) % COLORS.length];
  try { await updateDoc(gref(id), { color: next }); } catch (e) { toast(errMsg(e)); }
}
async function removeGroup(id) {
  if (!need()) return; const g = state.groups.get(id);
  try { await deleteDoc(gref(id)); addLog(`Removed ${g ? g.name : "a group"}`); toast("Group removed."); } catch (e) { toast(errMsg(e)); }
}
async function resetScores() {
  if (!need()) return;
  try {
    const b = writeBatch(db);
    for (const g of state.groups.values()) b.update(gref(g.id), { points: 0, updatedAt: Date.now() });
    await b.commit(); addLog("All scores reset to 0"); toast("All scores reset.");
  } catch (e) { toast(errMsg(e)); }
}
async function removeAll() {
  if (!need()) return;
  try {
    const b = writeBatch(db);
    for (const g of state.groups.values()) b.delete(gref(g.id));
    await b.commit(); addLog("All groups removed"); toast("All groups removed.");
  } catch (e) { toast(errMsg(e)); }
}
function addLog(text) {
  addDoc(collection(db, "log"), { t: Date.now(), text, by: state.user ? (state.user.email || state.user.uid) : "" }).catch(() => {});
}
async function saveSettings(patch, msg) {
  if (!need()) return;
  try { await setDoc(doc(db, "meta", "settings"), { ...state.settings, ...patch }); if (msg) toast(msg); }
  catch (e) { toast(errMsg(e)); fillSettingsForm(); }
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault(); if (!need()) return;
  const name = $("add-name").value.trim(); if (!name) return toast("Give the group a name.");
  const pts = Math.round(Number($("add-points").value) || 0);
  if ([...state.groups.values()].some(g => g.name.toLowerCase() === name.toLowerCase())) return toast("A group with that name already exists.");
  const btn = $("add-btn"); btn.disabled = true;
  try {
    await addDoc(collection(db, "groups"), { name, points: pts, color: addColor, createdAt: Date.now(), updatedAt: Date.now() });
    addLog(`Added ${name}${pts ? " with " + fmt(pts) + " pts" : ""}`);
    $("add-name").value = ""; $("add-points").value = "0";
    addColor = COLORS[(COLORS.indexOf(addColor) + 1) % COLORS.length]; renderSwatches();
    toast(`Added ${name}.`); $("add-name").focus();
  } catch (err) { toast(errMsg(err)); }
  btn.disabled = false;
});
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  saveSettings({ title: $("set-title").value.trim() || "Congress 2026", subtitle: $("set-sub").value.trim() }, "Settings saved.");
});
$("set-hidden").addEventListener("change", (e) => {
  const hidden = e.target.checked;
  saveSettings({ hidden }, hidden ? "Scores hidden on the public board." : "Scores are showing again.");
  addLog(hidden ? "Scores hidden for the reveal" : "Scores revealed");
});

/* ---------- views ---------- */
function setView(v) {
  state.view = v === "admin" ? "admin" : "board";
  const admin = state.view === "admin";
  $("view-board").hidden = admin;
  $("view-admin").hidden = !(admin && state.isAdmin);
  $("view-signin").hidden = !(admin && !state.isAdmin);
  $("tabs").hidden = !state.isAdmin;
  $("organiser-link").hidden = state.isAdmin;
  $("tab-board").setAttribute("aria-selected", String(!admin));
  $("tab-admin").setAttribute("aria-selected", String(admin));
  try { history.replaceState(null, "", admin ? "#admin" : location.pathname + location.search); } catch (e) {}
  renderAll();
}
$("tab-board").addEventListener("click", () => setView("board"));
$("tab-admin").addEventListener("click", () => setView("admin"));
$("organiser-link").addEventListener("click", () => setView("admin"));
$("back-board").addEventListener("click", () => setView("board"));
window.addEventListener("hashchange", () => setView(location.hash === "#admin" ? "admin" : "board"));
if (document.fullscreenEnabled) {
  const b = $("fs-btn"); b.hidden = false;
  b.addEventListener("click", () => { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); });
  document.addEventListener("fullscreenchange", () => b.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen");
}
function renderAll(events) {
  renderBoard(events);
  if (state.isAdmin) { renderAdmin(); fillSettingsForm(); }
}

/* ---------- sign in ---------- */
function authErr(e) {
  const c = e && e.code || "";
  if (c.includes("popup-closed") || c.includes("cancelled-popup")) return null;
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "That email and password don't match an organiser account.";
  if (c.includes("unauthorized-domain")) return "This website's address isn't allowed yet. Add it under Firebase → Authentication → Settings → Authorized domains.";
  if (c.includes("operation-not-allowed")) return "This sign-in method isn't turned on in Firebase → Authentication → Sign-in method.";
  if (c.includes("popup-blocked")) return "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.";
  return "Sign-in didn't work. Try again.";
}
$("google-btn").addEventListener("click", async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { const m = authErr(e); if (m) toast(m); }
});
$("email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await signInWithEmailAndPassword(auth, $("si-email").value.trim(), $("si-pass").value); $("si-pass").value = ""; }
  catch (err) { const m = authErr(err); if (m) toast(m); }
});
const doSignOut = async () => { await signOut(auth).catch(() => {}); setView("board"); toast("Signed out."); };
$("signout-btn").addEventListener("click", doSignOut);
$("signout-2").addEventListener("click", doSignOut);
$("copy-uid").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("si-uid").textContent); toast("ID copied."); }
  catch (e) { const r = document.createRange(); r.selectNodeContents($("si-uid")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Press Ctrl+C to copy."); }
});
$("recheck-btn").addEventListener("click", () => checkAdmin(state.user));

async function checkAdmin(user) {
  state.user = user;
  let isAdmin = false;
  if (user) {
    try { isAdmin = (await getDoc(doc(db, "admins", user.uid))).exists(); } catch (e) { isAdmin = false; }
  }
  state.isAdmin = isAdmin;
  $("signin-out").hidden = !!user;
  $("signin-pending").hidden = !user || isAdmin;
  if (user) { $("si-who").textContent = user.email || "this account"; $("si-uid").textContent = user.uid; }
  $("admin-who").textContent = user ? "Signed in as " + (user.email || user.uid) : "";
  if (unsubLog) { unsubLog(); unsubLog = null; }
  if (isAdmin) {
    unsubLog = onSnapshot(query(collection(db, "log"), orderBy("t", "desc"), limit(30)), (snap) => {
      state.log = snap.docs.map(d => d.data()).filter(e => typeof e.text === "string");
      renderLog();
    }, () => {});
  }
  if (user && !isAdmin && state.view === "admin") toast("This account isn't an organiser yet.");
  setView(state.view);
}

/* ---------- live connection ---------- */
function start() {
  renderSwatches(); renderDanger(); renderLog();
  if (!firebaseConfig || String(firebaseConfig.apiKey || "").startsWith("PASTE")) {
    setLive("off"); state.loaded = true; renderAll();
    return boardMessage("Almost ready", "Add your Firebase settings to firebase-config.js to switch on the live leaderboard. The README explains how.");
  }
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  state.view = location.hash === "#admin" ? "admin" : "board";
  setView(state.view);

  onSnapshot(collection(db, "groups"), { includeMetadataChanges: true }, (snap) => {
    const events = new Map();
    const next = new Map();
    for (const d of snap.docs) {
      const x = d.data() || {};
      const g = { id: d.id, name: String(x.name || "Unnamed group"), points: Number(x.points) || 0, color: x.color, createdAt: Number(x.createdAt) || 0 };
      const old = state.groups.get(d.id);
      if (state.loaded && old && old.points !== g.points) events.set(d.id, g.points - old.points);
      next.set(d.id, g);
    }
    const changed = snap.docChanges().length > 0 || !state.loaded;
    state.groups = next;
    state.loaded = true;
    setLive(!navigator.onLine ? "off" : snap.metadata.fromCache ? "syncing" : "live");
    if (changed) { state.lastUpdate = Date.now(); renderAll(events.size ? events : null); }
  }, (e) => { setLive("off"); toast("Live updates were interrupted. Reload the page to reconnect."); console.error(e); });

  onSnapshot(doc(db, "meta", "settings"), (d) => {
    const x = (d.exists() && d.data()) || {};
    state.settings = { title: x.title || "Congress 2026", subtitle: x.subtitle != null ? x.subtitle : "Live standings", hidden: !!x.hidden };
    renderAll();
  }, () => {});

  onAuthStateChanged(auth, (user) => { checkAdmin(user); });
  window.addEventListener("offline", () => setLive("off"));
  window.addEventListener("online", () => setLive("syncing"));
}
start();
