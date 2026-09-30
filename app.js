import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc, getDoc,
  increment, writeBatch, query, orderBy, limit, deleteField,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const COLORS = ["#8AD09B", "#7CC4E8", "#E9C46A", "#EE8B7A", "#B9A4E8", "#5CC2B5", "#E79BC0", "#D9C7A1"];
const state = {
  groups: new Map(),            // id -> {id,name,points,color,createdAt}
  settings: { title: "Congress 2026", subtitle: "Live standings", hidden: false, stations: 8 },
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
const LOG_LIMIT = 500;           // Recent changes keeps the latest 500 entries (scrollable)

const $ = (id) => document.getElementById(id);
// Roles: "admin" (organisers, full control) or "volunteer" (hub activity only). The Firestore rules enforce the same limits.
const isVol = () => state.role === "volunteer";
const canHub = () => state.role === "admin" || state.role === "volunteer";
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
const r2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => r2(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const signed = (n) => (r2(n) >= 0 ? "+" : "−") + fmt(Math.abs(n));

/* ---------- scoring ----------
   A team's `points` is its total. Hub and fundraiser points are derived from what was recorded
   (participants per station, % raised); bonus is whatever remains. Every change writes an atomic
   increment of the difference, so totals stay right even when organisers edit at the same time. */
const HUB_TOTAL = 1000;          // all stations, full delegation
const FUND_TOTAL = 1000;         // points for 100% of the goal; teams can go past 100%
const FUND_MAX_PCT = 1000;       // typo guard: 4500 typed instead of 45 is refused
const stationsN = () => state.settings.stations || 8;
const stationName = (s) => { const v = (state.settings.stationNames || [])[s - 1]; return typeof v === "string" ? v.trim() : ""; };
const stationLabel = (s) => stationName(s) ? `Station ${s} · ${stationName(s)}` : `Station ${s}`;
function hubPoints(g, size = g.size, n = stationsN(), hub = g.hub) {
  if (!size) return 0;
  let people = 0;
  for (let s = 1; s <= n; s++) { const c = hub && hub["s" + s]; if (typeof c === "number") people += Math.min(c, size); }
  return people / size * (HUB_TOTAL / n);
}
const stationsDone = (g, n = stationsN()) => { let k = 0; for (let s = 1; s <= n; s++) if (typeof (g.hub || {})["s" + s] === "number") k++; return k; };
const fundPoints = (pct) => Math.max(0, pct || 0) / 100 * FUND_TOTAL;
const bonusPoints = (g) => g.points - hubPoints(g) - fundPoints(g.fundPct);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const safeColor = (c) => /^#[0-9a-fA-F]{6}$/.test(c || "") ? c : COLORS[0];

let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }
function errMsg(e) {
  const c = e && e.code;
  if (c === "permission-denied") return "That change wasn't saved: this account doesn't have permission to make it.";
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
  arr.forEach(g => { g.points = r2(g.points); });
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
  if (!canHub()) return;
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
    r.refresh(g, rankOf.get(g.id), q);
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
    if (m.length === 1) { const r = aRows.get(m[0].id); if (r) r.focusEntry(); }
    else if (m.length > 1) toast(`${m.length} teams match. Keep typing to narrow it down.`);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || state.view !== "admin" || !canHub()) return;
  const t = e.target; if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  e.preventDefault(); $("a-search").focus(); $("a-search").select();
});
const TYPES = [["bonus", "Bonus"], ["hub", "Hub activity"], ["fund", "Fundraiser"]];
function buildAdminRow(id) {
  const G = () => state.groups.get(id);
  const sw = h("span", { class: "swatch" }), name = h("span", { class: "aname" }), pts = h("span", { class: "apts" }), rank = h("span", { class: "arank", title: "Current rank" });
  const breakdown = h("div", { class: "breakdown" });
  let mode = null;

  // 1. Choose the type of points first
  const typeBtns = TYPES.map(([key, label]) => h("button", { type: "button", "aria-pressed": "false", text: label, onclick: () => setMode(key) }));
  const types = h("div", { class: "types-wrap" }, h("span", { class: "types-label", text: "Add points:" }), h("div", { class: "types", role: "group", "aria-label": "Type of points" }, typeBtns));

  // Bonus: straight number
  const amt = h("input", { class: "field", type: "number", step: "1", id: "amt-" + id, placeholder: "Points", "aria-label": "Bonus points" });
  const bonusAdd = () => {
    const v = Math.round(Number(amt.value));
    if (!amt.value || !Number.isFinite(v) || v === 0) return toast("Enter the bonus points to add (use a minus sign to take points away).");
    bump(id, v, true); amt.value = "";
  };
  amt.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); bonusAdd(); } });
  const bonusPane = h("div", { class: "pane", hidden: true },
    h("div", { class: "quick" }, [-5, -1, 1, 5, 10, 25].map(d => h("button", {
      type: "button", class: d > 0 ? "plus" : "minus", text: (d > 0 ? "+" : "−") + Math.abs(d),
      "aria-label": (d > 0 ? "Add " : "Subtract ") + Math.abs(d) + " bonus", onclick: () => bump(id, d),
    }))),
    h("div", { class: "row2" }, amt, h("button", { class: "btn primary", type: "button", text: "Add bonus", onclick: bonusAdd })));

  // Hub activity: station + number of delegates who took part
  const stSel = h("select", { class: "field", id: "st-" + id, "aria-label": "Station" });
  const part = h("input", { class: "field", type: "number", min: "0", step: "1", id: "hp-" + id, placeholder: "Delegates", "aria-label": "Delegates who participated" });
  const hubPrev = h("div", { class: "preview" });
  const hubBtn = h("button", { class: "btn primary", type: "button", text: "Record", onclick: () => doHub() });
  const clearBtn = h("button", { class: "btn ghost", type: "button", text: "Clear station", hidden: true, onclick: () => clearHub(id, Number(stSel.value)) });
  const sizeText = h("span"), sizeLink = h("button", { class: "linkbtn", type: "button", text: "Set delegation size", onclick: () => openSize() });
  const sizeNote = h("div", { class: "preview warn", hidden: true }, sizeText, sizeLink);
  let stTouched = false, stKey = "";
  stSel.addEventListener("change", () => { stTouched = true; hubPreview(); });
  part.addEventListener("input", hubPreview);
  part.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doHub(); } });
  const hubPane = h("div", { class: "pane", hidden: true }, sizeNote,
    h("div", { class: "row2" }, stSel, part, hubBtn, clearBtn), hubPrev);
  function hubPreview() {
    const g = G(); if (!g) return;
    const n = stationsN(), s = Number(stSel.value), size = g.size;
    const prev = (g.hub || {})["s" + s];
    clearBtn.hidden = typeof prev !== "number" || isVol();
    if (!size) { hubPrev.textContent = ""; return; }
    const perStation = HUB_TOTAL / n;
    const base = `${stationLabel(s)}: each delegate is worth ${fmt(perStation / size)} pts, full team ${fmt(perStation)} pts.`;
    const c = part.value === "" ? null : Number(part.value);
    if (c == null) { hubPrev.textContent = base + (typeof prev === "number" ? ` Already recorded: ${prev} of ${size}.` : ""); return; }
    if (!Number.isInteger(c) || c < 0 || c > size) { hubPrev.replaceChildren(h("span", { class: "neg", text: `Enter a whole number from 0 to ${size} (the delegation size).` })); return; }
    const delta = hubPoints(g, size, n, { ...(g.hub || {}), ["s" + s]: c }) - hubPoints(g);
    hubPrev.replaceChildren(`${c} of ${size} delegates = ${fmt(c / size * perStation)} pts`,
      typeof prev === "number" ? ` (replaces ${prev} of ${size}) ` : " ",
      h("strong", { class: delta < 0 ? "neg" : "", text: signed(delta) + " pts" }));
  }
  function doHub() {
    const g = G(); if (!g) return;
    if (!g.size) return toast("Set the delegation size before recording hub activity.");
    const c = Number(part.value);
    if (part.value === "" || !Number.isInteger(c) || c < 0 || c > g.size) return toast(`Enter how many delegates took part: 0 to ${g.size}.`);
    recordHub(id, Number(stSel.value), c).then(ok => { if (ok) { part.value = ""; stTouched = false; } });
  }

  // Fundraiser: % of goal raised so far; only the difference is awarded
  const pct = h("input", { class: "field", type: "number", min: "0", max: String(FUND_MAX_PCT), step: "0.1", id: "fp-" + id, placeholder: "% raised", "aria-label": "Percent fundraised" });
  const fundPrev = h("div", { class: "preview" });
  const fundGo = () => {
    const g = G(); if (!g) return;
    const v = Number(pct.value);
    if (pct.value === "" || !Number.isFinite(v) || v < 0 || v > FUND_MAX_PCT) return toast(`Enter the percentage raised, from 0 to ${FUND_MAX_PCT} (above 100 is fine).`);
    if (r2(v) === r2(g.fundPct)) return toast(`${g.name} is already at ${fmt(v)}%.`);
    updateFund(id, r2(v)).then(ok => { if (ok) { pct.value = ""; fundPreview(); } });
  };
  pct.addEventListener("input", fundPreview);
  pct.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); fundGo(); } });
  const fundPane = h("div", { class: "pane", hidden: true },
    h("div", { class: "row2" }, h("div", { class: "pct" }, pct, h("span", { text: "%" })), h("button", { class: "btn primary", type: "button", text: "Update fundraiser", onclick: fundGo })), fundPrev);
  function fundPreview() {
    const g = G(); if (!g) return;
    const cur = g.fundPct || 0;
    const v = pct.value === "" ? null : Number(pct.value);
    if (v == null) { fundPrev.textContent = `Currently ${fmt(cur)}% raised = ${fmt(fundPoints(cur))} pts (100% = ${fmt(FUND_TOTAL)}). Enter the new total percentage; above 100% is allowed.`; return; }
    if (!Number.isFinite(v) || v < 0 || v > FUND_MAX_PCT) { fundPrev.replaceChildren(h("span", { class: "neg", text: `Enter a percentage from 0 to ${FUND_MAX_PCT}.` })); return; }
    const delta = fundPoints(v) - fundPoints(cur);
    fundPrev.replaceChildren(`${fmt(cur)}% → ${fmt(v)}% = ${fmt(fundPoints(v))} pts total. `,
      h("strong", { class: delta < 0 ? "neg" : "", text: signed(delta) + " pts" }), delta < 0 ? " (lowers their score)" : "", v > 100 ? " · above the goal" : "");
  }

  const panes = { bonus: bonusPane, hub: hubPane, fund: fundPane };
  function setMode(key, quiet) {
    mode = mode === key && !quiet ? null : key;
    typeBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(TYPES[i][0] === mode)));
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== mode;
    const first = { bonus: amt, hub: part, fund: pct }[mode];
    if (mode === "hub") { hubPreview(); if (!G()?.size) return; }
    if (mode === "fund") fundPreview();
    if (first && !quiet) first.focus();
  }
  function fillStations(g) {
    const n = stationsN(), hub = g.hub || {};
    const key = n + "|" + Array.from({ length: n }, (_, i) => (hub["s" + (i + 1)] ?? "") + ":" + stationName(i + 1)).join(",") + "|" + g.size;
    if (key === stKey) return;
    stKey = key;
    const keepVal = stSel.value;
    stSel.replaceChildren(...Array.from({ length: n }, (_, i) => {
      const s = i + 1, c = hub["s" + s];
      return h("option", { value: String(s), text: typeof c === "number" ? `${stationLabel(s)} ✓ ${c}/${g.size || "?"}` : stationLabel(s) });
    }));
    if (stTouched && keepVal && Number(keepVal) <= n) stSel.value = keepVal;
    else { let firstOpen = 1; for (let s = 1; s <= n; s++) if (typeof hub["s" + s] !== "number") { firstOpen = s; break; } stSel.value = String(firstOpen); }
  }

  // Row tools
  const tools = h("div", { class: "actions" });
  const renameBtn = h("button", { class: "btn ghost", type: "button", text: "Rename", onclick: () => openRename() });
  const sizeBtn = h("button", { class: "btn ghost", type: "button", text: "Delegation size", onclick: () => openSize() });
  const colorBtn = h("button", { class: "btn ghost", type: "button", text: "Colour", onclick: () => cycleColor(id) });
  const delBtn = h("button", { class: "btn danger", type: "button", text: "Delete", onclick: () => confirmInline(tools, "Delete this group?", "Delete", () => removeGroup(id), resetTools) });
  function resetTools() { tools.replaceChildren(renameBtn, sizeBtn, colorBtn, delBtn); }
  function inlineEdit(input, onSave) {
    const save = async () => { if (await onSave(input.value)) resetTools(); };
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") resetTools(); });
    tools.replaceChildren(h("div", { class: "rename" }, input, h("button", { class: "btn primary", type: "button", text: "Save", onclick: save }), h("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: resetTools })));
    input.focus(); input.select();
  }
  function openRename() {
    const g = G(); if (!g) return;
    inlineEdit(h("input", { class: "field", id: "rn-" + id, maxlength: "60", value: g.name, "aria-label": "New name" }), async (raw) => {
      const v = raw.trim(); if (!v) { toast("Group name can't be empty."); return false; }
      if (v !== g.name) await renameGroup(id, v); return true;
    });
  }
  function openSize() {
    const g = G(); if (!g) return;
    inlineEdit(h("input", { class: "field", id: "sz-" + id, type: "number", min: "1", max: "100", step: "1", value: g.size ? String(g.size) : "", placeholder: "People in delegation", "aria-label": "Delegation size" }), async (raw) => {
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 1 || v > 100) { toast("Delegation size must be a whole number from 1 to 100."); return false; }
      return v === g.size ? true : await setSize(id, v);
    });
  }
  resetTools();
  // Volunteers only record hub activity: no type picker, no row tools
  if (isVol()) { types.hidden = true; tools.hidden = true; setMode("hub", true); }

  const el = h("div", { class: "arow" }, h("div", { class: "line1" }, rank, sw, name, pts), breakdown, types, bonusPane, hubPane, fundPane, tools);
  function refresh(g, rk, q) {
    sw.style.background = safeColor(g.color);
    paintName(name, g.name, q);
    rank.textContent = "#" + rk;
    const p = pending.get(id) || 0;
    pts.textContent = fmt(g.points + p);
    pts.classList.toggle("pending", p !== 0 || flushing.has(id));
    const n = stationsN();
    breakdown.replaceChildren(...[
      h("span", { class: g.size ? "" : "warn", text: g.size ? `Delegation: ${g.size}` : "Delegation size not set" }),
      isVol() ? null : h("span", { text: `Bonus ${fmt(bonusPoints(g) + p)}` }),
      h("span", { text: `Hub ${fmt(hubPoints(g))} · ${stationsDone(g)}/${n} stations` }),
      isVol() ? null : h("span", { text: `Fundraiser ${fmt(fundPoints(g.fundPct))} · ${fmt(g.fundPct || 0)}%` }),
    ].filter(Boolean));
    fillStations(g);
    sizeNote.hidden = !!g.size;
    sizeText.textContent = isVol() ? "This team has no delegation size yet. Ask an organiser to set it before recording hub activity." : "Set this team's delegation size first. ";
    sizeLink.hidden = isVol();
    part.max = String(g.size || 0);
    part.disabled = hubBtn.disabled = stSel.disabled = !g.size;
    if (mode === "hub") hubPreview();
    if (mode === "fund") fundPreview();
  }
  function focusEntry() {
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    if (isVol()) (part.disabled ? stSel : part).focus(); else typeBtns[0].focus();
  }
  return { el, refresh, focusEntry };
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
  ul.replaceChildren(...state.log.map(e => {
    const who = (typeof e.byName === "string" && e.byName) || (typeof e.by === "string" && e.by) || "";
    return h("li", null,
      h("time", { text: new Date(e.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }),
      h("div", { class: "log-body" }, h("span", { text: e.text }), who ? h("span", { class: "log-by", text: "by " + who }) : null));
  }));
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
  const st = $("set-stations"), n = stationsN();
  if (document.activeElement !== st) st.value = String(n);
  $("stations-note").textContent = `Each station is worth ${fmt(HUB_TOTAL / n)} pts for a full delegation; all ${n} stations = ${fmt(HUB_TOTAL)} pts. Fundraiser: 100% = ${fmt(FUND_TOTAL)} pts, and teams keep earning past 100%.`;
}

/* ---------- writes (atomic increments, so two organisers tapping at once never lose points) ---------- */
const gref = (id) => doc(db, "groups", id);
function need() { if (!db || !state.isAdmin) { toast(isVol() ? "Volunteers can only record hub activity." : "Sign in as an organiser to make changes."); return false; } return true; }
function needHub() { if (!db || !canHub()) { toast("Sign in as an organiser or volunteer to record hub activity."); return false; } return true; }
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
  try { await p; addLog(`Bonus ${signed(d)} to ${g.name}`); }
  catch (e) { toast(errMsg(e)); }
  flushing.delete(id); renderAdmin();
  if (pending.get(id)) flush(id);
}
// Hub activity: recording a station replaces that station's earlier entry, so only the difference is added
async function recordHub(id, station, count) {
  if (!needHub()) return false; const g = state.groups.get(id); if (!g) return false;
  const prev = (g.hub || {})["s" + station];
  const delta = hubPoints(g, g.size, stationsN(), { ...(g.hub || {}), ["s" + station]: count }) - hubPoints(g);
  try {
    // lastStation names the one station changed, so the Firestore rules can check a volunteer's points against the formula
    await updateDoc(gref(id), { ["hub.s" + station]: count, points: increment(delta), lastStation: "s" + station, updatedAt: Date.now() });
    addLog(`Hub · ${stationLabel(station)}: ${count}/${g.size} of ${g.name}${typeof prev === "number" ? ` (was ${prev})` : ""} → ${signed(delta)}`);
    toast(`${g.name}: ${stationLabel(station)} recorded, ${signed(delta)} pts.`);
    return true;
  } catch (e) { toast(errMsg(e)); return false; }
}
async function clearHub(id, station) {
  if (!need()) return; const g = state.groups.get(id); if (!g) return;
  const hub = { ...(g.hub || {}) }; delete hub["s" + station];
  const delta = hubPoints(g, g.size, stationsN(), hub) - hubPoints(g);
  try {
    await updateDoc(gref(id), { ["hub.s" + station]: deleteField(), points: increment(delta), updatedAt: Date.now() });
    addLog(`Hub · ${stationLabel(station)} cleared for ${g.name} → ${signed(delta)}`); toast(`${stationLabel(station)} cleared for ${g.name}.`);
  } catch (e) { toast(errMsg(e)); }
}
// Fundraiser: store the % raised; award only the change since the last update
async function updateFund(id, pct) {
  if (!need()) return false; const g = state.groups.get(id); if (!g) return false;
  const old = g.fundPct || 0;
  const delta = fundPoints(pct) - fundPoints(old);
  try {
    await updateDoc(gref(id), { fundPct: pct, points: increment(delta), updatedAt: Date.now() });
    addLog(`Fundraiser · ${g.name}: ${fmt(old)}% → ${fmt(pct)}% → ${signed(delta)}`);
    toast(`${g.name}: fundraiser at ${fmt(pct)}%, ${signed(delta)} pts.`);
    return true;
  } catch (e) { toast(errMsg(e)); return false; }
}
// Delegation size changes the value of every hub entry already recorded for that team
async function setSize(id, size) {
  if (!need()) return false; const g = state.groups.get(id); if (!g) return false;
  const over = Object.entries(g.hub || {}).find(([, c]) => typeof c === "number" && c > size);
  if (over) { toast(`${over[0].replace("s", "Station ")} recorded ${over[1]} delegates, more than ${size}. Fix that station first.`); return false; }
  const delta = hubPoints(g, size) - hubPoints(g);
  try {
    await updateDoc(gref(id), { size, points: increment(delta), updatedAt: Date.now() });
    addLog(`Delegation size for ${g.name}: ${g.size || "not set"} → ${size}${Math.abs(delta) > 0.001 ? ` (hub ${signed(delta)})` : ""}`);
    toast(`${g.name} now has ${size} delegates.`);
    return true;
  } catch (e) { toast(errMsg(e)); return false; }
}
// Changing the number of hub stations re-values every team's hub points in one batch
async function setStations(n) {
  if (!need()) return;
  const old = stationsN(); if (n === old) return toast(`Already set to ${n} stations.`);
  try {
    const b = writeBatch(db);
    b.set(doc(db, "meta", "settings"), { ...state.settings, stations: n });
    for (const g of state.groups.values()) {
      const delta = hubPoints(g, g.size, n) - hubPoints(g, g.size, old);
      if (Math.abs(delta) > 1e-9) b.update(gref(g.id), { points: increment(delta), updatedAt: Date.now() });
    }
    await b.commit();
    addLog(`Hub stations: ${old} → ${n} (every team's hub points recalculated)`);
    toast(`Hub stations set to ${n}. Scores recalculated.`);
  } catch (e) { toast(errMsg(e)); fillSettingsForm(); }
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
    for (const g of state.groups.values()) b.update(gref(g.id), { points: 0, hub: deleteField(), fundPct: 0, updatedAt: Date.now() });
    await b.commit(); addLog("All scores reset to 0 (hub and fundraiser records cleared)"); toast("All scores reset.");
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
// The organiser's display name comes from their record in the `admins` collection
function adminNameFrom(d) {
  if (!d) return "";
  const direct = d.name ?? d.Name ?? d.fullName ?? d.displayName;
  if (typeof direct === "string" && direct.trim()) return direct.trim().slice(0, 60);
  const anyText = Object.values(d).find(v => typeof v === "string" && v.trim() && !v.includes("@"));
  return anyText ? anyText.trim().slice(0, 60) : "";
}
const whoAmI = () => state.adminName || (state.user ? (state.user.displayName || state.user.email || "An organiser") : "");
function addLog(text) {
  addDoc(collection(db, "log"), { t: Date.now(), text, byName: whoAmI(), by: state.user ? (state.user.email || state.user.uid) : "" }).catch(() => {});
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
  const size = Number($("add-size").value);
  if (!Number.isInteger(size) || size < 1 || size > 100) return toast("Enter the delegation size: how many people are in this team (1 to 100).");
  if ([...state.groups.values()].some(g => g.name.toLowerCase() === name.toLowerCase())) return toast("A group with that name already exists.");
  const btn = $("add-btn"); btn.disabled = true;
  try {
    await addDoc(collection(db, "groups"), { name, points: pts, size, fundPct: 0, hub: {}, color: addColor, createdAt: Date.now(), updatedAt: Date.now() });
    addLog(`Added ${name} (${size} delegates)${pts ? " with " + fmt(pts) + " bonus pts" : ""}`);
    $("add-name").value = ""; $("add-points").value = "0"; $("add-size").value = "";
    addColor = COLORS[(COLORS.indexOf(addColor) + 1) % COLORS.length]; renderSwatches();
    toast(`Added ${name}.`); $("add-name").focus();
  } catch (err) { toast(errMsg(err)); }
  btn.disabled = false;
});
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  saveSettings({ title: $("set-title").value.trim() || "Congress 2026", subtitle: $("set-sub").value.trim() }, "Settings saved.");
});
$("hub-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const n = Number($("set-stations").value);
  if (!Number.isInteger(n) || n < 1 || n > 50) return toast("Number of stations must be a whole number from 1 to 50.");
  setStations(n);
});
$("set-hidden").addEventListener("change", (e) => {
  const hidden = e.target.checked;
  saveSettings({ hidden }, hidden ? "Scores hidden on the public board." : "Scores are showing again.");
  addLog(hidden ? "Scores hidden for the reveal" : "Scores revealed");
});

/* ---------- views ---------- */
// Sign-in lives only at /sign-in: that page hands over with #signin. The main page never offers it,
// so #admin or #stations shows the leaderboard to anyone who isn't a signed-in organiser or volunteer.
const ROOT = location.pathname.replace(/sign-in\/?$/, "");
let signinFlow = location.hash === "#signin";
const viewFromHash = () => ({ "#admin": "admin", "#stations": "stations", "#signin": "admin" })[location.hash] || "board";
function setView(v) {
  state.requested = v;   // remembered so the view can be restored once sign-in finishes loading
  state.view = ["admin", "stations"].includes(v) ? v : "board";
  if (state.view === "stations" && isVol()) state.view = "admin";   // Stations is organisers only
  if (state.view !== "board" && !canHub() && !signinFlow) state.view = "board";
  const organiserOnly = state.view !== "board";
  document.body.classList.toggle("volunteer", isVol());
  $("view-board").hidden = organiserOnly;
  $("view-admin").hidden = !(state.view === "admin" && canHub());
  $("view-stations").hidden = !(state.view === "stations" && state.isAdmin);
  $("view-signin").hidden = !(organiserOnly && !canHub());
  $("tabs").hidden = !canHub();
  $("tab-stations").hidden = !state.isAdmin;
  $("tab-admin").textContent = isVol() ? "Hub points" : "Admin";
  for (const t of ["board", "admin", "stations"]) $("tab-" + t).setAttribute("aria-selected", String(state.view === t));
  const url = organiserOnly && !canHub() ? ROOT + "sign-in" : organiserOnly ? ROOT + "#" + state.view : ROOT;
  try { history.replaceState(null, "", url); } catch (e) {}
  renderAll();
}
$("tab-board").addEventListener("click", () => setView("board"));
$("tab-admin").addEventListener("click", () => setView("admin"));
$("tab-stations").addEventListener("click", () => setView("stations"));
$("back-board").addEventListener("click", () => { signinFlow = false; setView("board"); });
window.addEventListener("hashchange", () => { if (location.hash === "#signin") signinFlow = true; setView(viewFromHash()); });

/* ---------- stations tab ---------- */
const nameDirty = new Set();   // stations whose name field has unsaved edits
function renderStations() {
  if (!state.isAdmin) return;
  const wrap = $("st-names"), n = stationsN();
  if (wrap.children.length !== n) {
    const old = new Map([...wrap.querySelectorAll("input")].map(i => [i.id, i.value]));
    wrap.replaceChildren(...Array.from({ length: n }, (_, i) => {
      const s = i + 1, id = "sn-" + s;
      const inp = h("input", { class: "field", id, maxlength: "60", placeholder: "e.g. Leadership circle", "aria-label": `Name for station ${s}` });
      if (old.has(id) && nameDirty.has(s)) inp.value = old.get(id);
      inp.addEventListener("input", () => { nameDirty.add(s); $("names-dirty").hidden = false; });
      return h("div", { class: "st-row" }, h("label", { for: id, text: "Station " + s }), inp, h("div", { class: "prog" }));
    }));
    for (const s of [...nameDirty]) if (s > n) nameDirty.delete(s);
  }
  const teams = [...state.groups.values()];
  [...wrap.children].forEach((row, i) => {
    const s = i + 1, inp = row.querySelector("input");
    if (!nameDirty.has(s) && document.activeElement !== inp) inp.value = stationName(s);
    const done = teams.filter(g => typeof (g.hub || {})["s" + s] === "number").length;
    const pct = teams.length ? done / teams.length * 100 : 0;
    row.querySelector(".prog").replaceChildren(h("span", { class: "bar" }, h("i", { style: `width:${pct}%` })), teams.length ? `${done} of ${teams.length} teams recorded` : "No teams yet");
  });
  $("names-dirty").hidden = nameDirty.size === 0;
}
$("names-form").addEventListener("submit", async (e) => {
  e.preventDefault(); if (!need()) return;
  const n = stationsN();
  const names = [...(state.settings.stationNames || [])];
  for (let s = 1; s <= n; s++) names[s - 1] = ($("sn-" + s).value || "").trim().slice(0, 60);
  for (let i = 0; i < names.length; i++) if (typeof names[i] !== "string") names[i] = "";
  const btn = $("names-save"); btn.disabled = true;
  try {
    await setDoc(doc(db, "meta", "settings"), { ...state.settings, stationNames: names });
    nameDirty.clear(); $("names-dirty").hidden = true;
    addLog("Station names updated"); toast("Station names saved.");
  } catch (err) { toast(errMsg(err)); }
  btn.disabled = false;
});
if (document.fullscreenEnabled) {
  const b = $("fs-btn"); b.hidden = false;
  b.addEventListener("click", () => { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); });
  document.addEventListener("fullscreenchange", () => b.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen");
}
function renderAll(events) {
  renderBoard(events);
  if (canHub()) renderAdmin();
  if (state.isAdmin) { fillSettingsForm(); renderStations(); }
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

/* ---------- which role someone is signing in for ---------- */
const ROLE_INFO = {
  admin: { label: "Organiser", article: "an organiser", coll: "admins", desc: "Full control: teams, every point type, stations and settings." },
  volunteer: { label: "Volunteer", article: "a volunteer", coll: "volunteers", desc: "Records hub activity only: pick the station and enter how many delegates took part." },
};
let wantRole = null;
try { wantRole = sessionStorage.getItem("wantRole"); } catch (e) {}
if (!ROLE_INFO[wantRole]) wantRole = null;
function renderRolePick() {
  const info = ROLE_INFO[wantRole];
  document.querySelectorAll(".role-types button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.role === wantRole)));
  $("role-desc").textContent = info ? info.desc : "Choose one to continue.";
  $("google-btn").disabled = $("email-btn").disabled = !info;
  $("si-want").textContent = info ? info.label.toLowerCase() : "organiser or volunteer";
  $("si-instr").textContent = info ? `Send this account ID to an organiser so they can add you as ${info.article}:` : "Choose the access you need, then send this account ID to an organiser:";
  $("si-where").textContent = info
    ? `For the organiser: in Firebase → Firestore, open the “${info.coll}” collection and add a document with this ID as the document ID and a “name” field.`
    : "";
  $("copy-request").disabled = !info;
}
function setWantRole(r) {
  wantRole = r;
  try { sessionStorage.setItem("wantRole", r); } catch (e) {}
  renderRolePick();
}
document.querySelectorAll(".role-types button").forEach(b => b.addEventListener("click", () => setWantRole(b.dataset.role)));
document.querySelectorAll(".role-types").forEach(g => g.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();
  const next = wantRole === "admin" ? "volunteer" : "admin";
  setWantRole(next); g.querySelector(`[data-role="${next}"]`).focus();
}));
$("copy-request").addEventListener("click", async () => {
  const info = ROLE_INFO[wantRole], u = state.user; if (!info || !u) return;
  const who = u.displayName || u.email || "me";
  const msg = `Please add ${who} to the Congress leaderboard as ${info.article}.\nAccount ID: ${u.uid}\nFirestore collection: ${info.coll} (document ID = the account ID, add a "name" field)`;
  try { await navigator.clipboard.writeText(msg); toast("Request copied. Paste it to an organiser."); }
  catch (e) { toast("Couldn't copy automatically. Use Copy ID only instead."); }
});
renderRolePick();

async function checkAdmin(user) {
  state.user = user;
  let role = null, rec = null;
  if (user) {
    // Organisers are in `admins`, volunteers in `volunteers`; both keyed by account ID
    try { rec = await getDoc(doc(db, "admins", user.uid)); if (rec.exists()) role = "admin"; } catch (e) {}
    if (!role) { try { rec = await getDoc(doc(db, "volunteers", user.uid)); if (rec.exists()) role = "volunteer"; } catch (e) {} }
  }
  state.adminName = role ? adminNameFrom(rec.data()) : "";
  if (role !== state.role) { aRows.clear(); $("a-list").replaceChildren(); }   // rebuild rows for the new role
  state.role = role;
  const isAdmin = role === "admin";
  state.isAdmin = isAdmin;
  $("signin-out").hidden = !!user;
  $("signin-pending").hidden = !user || !!role;
  if (user) { $("si-who").textContent = user.email || "this account"; $("si-uid").textContent = user.uid; }
  $("admin-who").textContent = user ? "Signed in as " + (state.adminName ? `${state.adminName} (${user.email || user.uid})` : (user.email || user.uid)) + (role === "volunteer" ? " · Volunteer" : role === "admin" ? " · Organiser" : "") : "";
  if (unsubLog) { unsubLog(); unsubLog = null; }
  if (role) {
    unsubLog = onSnapshot(query(collection(db, "log"), orderBy("t", "desc"), limit(LOG_LIMIT)), (snap) => {
      state.log = snap.docs.map(d => d.data()).filter(e => typeof e.text === "string");
      renderLog();
    }, () => {});
  }
  if (user && !role && state.view !== "board") toast("This account doesn't have organiser or volunteer access yet.");
  else if (signinFlow && role && wantRole && role !== wantRole) toast(`This account has ${ROLE_INFO[role].label.toLowerCase()} access, so you're signed in as ${ROLE_INFO[role].article}.`);
  setView(state.requested ?? state.view);
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
  setView(viewFromHash());

  onSnapshot(collection(db, "groups"), { includeMetadataChanges: true }, (snap) => {
    const events = new Map();
    const next = new Map();
    for (const d of snap.docs) {
      const x = d.data() || {};
      const g = {
        id: d.id, name: String(x.name || "Unnamed group"), points: Number(x.points) || 0, color: x.color, createdAt: Number(x.createdAt) || 0,
        size: Number.isInteger(x.size) && x.size > 0 ? x.size : 0,
        hub: x.hub && typeof x.hub === "object" ? x.hub : {},
        fundPct: Number(x.fundPct) || 0,
      };
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
    state.settings = {
      title: x.title || "Congress 2026", subtitle: x.subtitle != null ? x.subtitle : "Live standings", hidden: !!x.hidden,
      stations: Number.isInteger(x.stations) && x.stations > 0 ? x.stations : 8,
      stationNames: Array.isArray(x.stationNames) ? x.stationNames.slice(0, 50).map(v => typeof v === "string" ? v.slice(0, 60) : "") : [],
    };
    renderAll();
  }, () => {});

  onAuthStateChanged(auth, (user) => { checkAdmin(user); });
  window.addEventListener("offline", () => setLive("off"));
  window.addEventListener("online", () => setLive("syncing"));
}
start();
