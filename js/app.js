import { parseRoster, defaultTitle } from "./parser.js";
import { buildCycle, standings } from "./scheduler.js";
import { BALL, RALLY, ARROW, SHARE } from "./doodles.js";
import { courtFlow, waitingFor, benched, isFinished } from "./flow.js";
import {
  keepForReschedule, pendingCount, swapSlots, findSwap, findPull, planExtra, withIds, copyScores,
  maxPlayStreak, lastOnCourt, playersOf, hasProgress, locateMatch,
} from "./ops.js";
import {
  cloudEnabled, createCloud, joinCloud, fetchCloud, saveMatch, saveAll, watchCloud,
  shareUrl, parseShareHash, serverNow, deleteCloud,
} from "./cloud.js";

const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => Math.random().toString(36).slice(2, 9);
const lsGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

// ---------- 儲存 ----------
const KEY = "rallymate.events.v1";
function loadEvents() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
function saveEvents() {
  // 記住最近在用的球局：下次打開 app 直接回到這一局
  const ev = state.events.find((e) => e.id === state.eventId);
  if (ev && state.view === "event") ev.touchedAt = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify(state.events));
  } catch {
    toast("無法儲存（瀏覽器限制），關閉頁面後資料會消失");
  }
}

// ---------- 狀態 ----------
const state = {
  view: "home", // home | paste | setup | event
  events: loadEvents(),
  draft: null,
  eventId: null,
  tab: "live", // live | rounds | rank
  editing: null, // 「賽程」分頁中展開的那場（"r-mi"）
  early: null, // 「賽程」分頁中，還沒輪到、但要提前記分的那場
  fixing: null, // 正在「改比分」的那場（已經打完）
  shared: null, // 唯讀分享的賽事
  players: null, // 「有人加入／離開」視窗裡還沒套用的名單
  absentFor: null, // 「有人還沒到」視窗：哪一場
  picking: null, // 直接選分數：哪一場、哪一隊
};

const current = () => state.shared || state.events.find((e) => e.id === state.eventId);
// 唯讀：別人分享的快照，或用「觀看連結」打開的雲端球局
const readonly = () => {
  if (state.shared) return true;
  const ev = state.events.find((e) => e.id === state.eventId);
  return !!(ev?.cloud && !ev.cloud.key);
};
const sizeOf = (ev) => (ev.mode === "singles" ? 2 : 4);

// ---------- 畫面顏色 ----------
const THEME_KEY = "rallymate.theme";
const THEME_NAMES = { "": "跟手機一樣", light: "亮色", dark: "暗色（黑板）" };
function applyTheme() {
  const t = lsGet(THEME_KEY) || "";
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function nextTheme() {
  const order = ["", "light", "dark"];
  const t = order[(order.indexOf(lsGet(THEME_KEY) || "") + 1) % order.length];
  lsSet(THEME_KEY, t);
  applyTheme();
  return THEME_NAMES[t];
}

// ---------- 雲端同步 ----------
// 還沒送上雲端的修改記在 ev.unsynced（存在手機裡）：
// 離線時記的分數，就算 app 被關掉，下次打開也會先送出去，不會被雲端的舊資料蓋掉
let lastSyncToast = 0;
function syncFail(e) {
  console.warn("sync failed", e);
  updateSyncBadge();
  if (Date.now() - lastSyncToast < 8000) return;
  lastSyncToast = Date.now();
  toast(navigator.onLine ? "同步失敗，請稍後再試" : "目前離線，連上網路後會自動送出");
}
const inflight = new Map(); // "evId:key" → 送出中的次數
const inc = (t) => inflight.set(t, (inflight.get(t) || 0) + 1);
const dec = (t) => {
  const n = (inflight.get(t) || 1) - 1;
  n ? inflight.set(t, n) : inflight.delete(t);
  return n;
};
const isUnsynced = (ev) => !!(ev?.unsynced && (ev.unsynced.all || Object.keys(ev.unsynced.m || {}).length));
const matchKeyOf = (m, r, mi) => m.id || `${r}-${mi}`;

function pushMatch(ev, r, mi) {
  if (!ev?.cloud?.key) return;
  const m = ev.rounds[r]?.matches[mi];
  if (!m) return;
  const key = matchKeyOf(m, r, mi);
  ev.unsynced ??= {};
  (ev.unsynced.m ??= {})[key] = true;
  saveEvents();
  const tag = `${ev.id}:${key}`;
  inc(tag);
  updateSyncBadge();
  saveMatch(ev.cloud, Number(r), Number(mi), m, ev.rounds[r].cycle || 0)
    .then(() => {
      if (dec(tag) === 0 && ev.unsynced?.m) {
        delete ev.unsynced.m[key];
        saveEvents();
      }
      updateSyncBadge();
    })
    .catch((e) => {
      dec(tag);
      syncFail(e);
    });
}

function pushAll(ev) {
  if (!ev?.cloud?.key) return;
  ev.unsynced ??= {};
  ev.unsynced.all = true;
  saveEvents();
  const tag = `${ev.id}:all`;
  inc(tag);
  updateSyncBadge();
  saveAll(ev.cloud, ev)
    .then((data) => {
      if (dec(tag) === 0) {
        ev.unsynced.all = false;
        saveEvents();
        if (data) onRemote(ev.id, data); // 合併了別支手機剛記的比分
      }
      updateSyncBadge();
    })
    .catch((e) => {
      dec(tag);
      syncFail(e);
    });
}

function updateSyncBadge() {
  const el = $(".sync-state");
  const ev = current();
  if (!el || !ev) return;
  const bad = isUnsynced(ev) && ![...inflight.keys()].some((t) => t.startsWith(`${ev.id}:`));
  el.classList.toggle("bad", bad);
  el.textContent = bad ? "⚠️ 還沒同步，連上網路會自動送出" : "🔗 即時同步中";
}

let watching = null; // { id, off }
let lastInteract = 0;
document.addEventListener("pointerdown", () => (lastInteract = Date.now()), true);

async function ensureWatch(ev) {
  if (!ev?.cloud || !cloudEnabled()) return stopWatch();
  if (watching?.id === ev.cloud.id) return;
  stopWatch();
  const w = { id: ev.cloud.id, off: null };
  watching = w;
  try {
    const off = await watchCloud(ev.cloud.id, (data) => onRemote(ev.id, data));
    if (watching === w) w.off = off;
    else off();
  } catch (e) {
    syncFail(e);
  }
}
function stopWatch() {
  watching?.off?.();
  watching = null;
}

function findLocal(ev, key) {
  const pos = /^(\d+)-(\d+)$/.exec(key);
  if (pos) {
    const m = ev.rounds[pos[1]]?.matches[pos[2]];
    return m ? { r: +pos[1], mi: +pos[2], m } : null;
  }
  for (let r = 0; r < ev.rounds.length; r++) {
    const mi = ev.rounds[r].matches.findIndex((x) => x.id === key);
    if (mi >= 0) return { r, mi, m: ev.rounds[r].matches[mi] };
  }
  return null;
}

const snapshotKey = (ev) => JSON.stringify([ev.title, ev.players, ev.rounds]);
const deletedNotice = new Set();
function onRemote(localId, data) {
  const ev = state.events.find((e) => e.id === localId);
  if (!ev) return;
  if (!data) {
    if (ev.cloud && !deletedNotice.has(localId) && state.eventId === localId) {
      deletedNotice.add(localId);
      toast("這個球局在雲端已經被刪除了，這支手機上的資料還在");
    }
    return;
  }
  const u = ev.unsynced;
  // 本機重排過、還沒送上去：先送（送的時候會合併雲端的比分），這次的舊資料不套用
  if (u?.all) {
    if (!inflight.get(`${ev.id}:all`)) pushAll(ev);
    return;
  }
  // 本機記了、還沒送上去的比分：蓋在雲端資料上；沒有在送的就再送一次
  const resend = [];
  for (const key of Object.keys(u?.m || {})) {
    const loc = findLocal(ev, key);
    const at = loc && locateMatch(data.rounds, loc.m, loc.r, loc.mi, ev.rounds[loc.r].cycle || 0);
    if (!at) {
      delete u.m[key];
      continue;
    }
    const t = data.rounds[at[0]].matches[at[1]];
    Object.assign(t, { sa: loc.m.sa, sb: loc.m.sb, done: loc.m.done });
    if (loc.m.doneAt != null) t.doneAt = loc.m.doneAt;
    else delete t.doneAt;
    if (!inflight.get(`${ev.id}:${key}`)) resend.push(at);
  }
  const before = snapshotKey(ev);
  Object.assign(ev, data, { id: ev.id, cloud: ev.cloud, createdAt: ev.createdAt });
  for (const [r, mi] of resend) pushMatch(ev, r, mi);
  if (snapshotKey(ev) === before) return updateSyncBadge(); // 自己剛寫入的回音
  saveEvents();
  remoteRender();
}
// 別人更新時重畫；正在按按鈕或開著選單時先等一下，避免畫面跳掉
let remoteTimer;
function remoteRender() {
  clearTimeout(remoteTimer);
  if (state.view === "home") return renderHome();
  if (state.view !== "event") return;
  if (Date.now() - lastInteract < 1500 || !$("#sheet").hidden || state.animating || state.busy) {
    remoteTimer = setTimeout(remoteRender, 700);
    return;
  }
  // 別人打完、場地換人：一樣播放「下一場名字飛上來」
  const ev = current();
  if (state.tab === "live" && ev && !state.shared && courtsChanged(ev)) return advanceWithFlight(null);
  const y = window.scrollY;
  renderEvent();
  window.scrollTo(0, y);
}

// ---------- 工具 ----------
let toastTimer;
// action：{ label, fn }，例如「復原」
function toast(msg, ms, action) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="toast-btn">${esc(action.label)}</button>` : ""}`;
  t._action = action?.fn || null;
  t.classList.toggle("has-action", !!action);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms || Math.min(8000, Math.max(3000, msg.length * 160)));
}
$("#toast").addEventListener("click", (e) => {
  const t = $("#toast");
  const fn = e.target.closest(".toast-btn") ? t._action : null;
  t.hidden = true;
  t._action = null;
  fn?.();
});

// 大字的確認視窗（取代瀏覽器的小字 confirm）
let askResolve = null;
function ask(html, { ok = "確定", cancel = "取消", danger = false } = {}) {
  return new Promise((resolve) => {
    finishAsk(false);
    openSheet(`<p class="ask-msg">${html}</p>
      <button class="btn ${danger ? "danger-solid" : "primary"} block" data-ask="1">${ok}</button>
      <button class="btn block" data-ask="0" style="margin-top:12px">${cancel}</button>`);
    askResolve = resolve;
  });
}
function finishAsk(v) {
  const r = askResolve;
  askResolve = null;
  r?.(v);
}

// 排賽程要花一點時間時：整個畫面蓋一層「排賽程中…」，避免中途又按到別的
async function busy(msg, fn) {
  let el = $("#busy");
  if (!el) {
    el = document.createElement("div");
    el.id = "busy";
    el.className = "busy";
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="busy-box"><div class="bounce">${BALL}</div><b>${esc(msg)}</b></div>`;
  el.hidden = false;
  state.busy = true;
  try {
    return await fn();
  } finally {
    el.hidden = true;
    state.busy = false;
  }
}

// ---------- 在背景排賽程（人多時要算好幾秒，畫面不會卡住） ----------
let worker = null;
const jobs = new Map();
let jobId = 0;
try {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const j = jobs.get(e.data.id);
    jobs.delete(e.data.id);
    if (!j) return;
    e.data.error ? j.fallback() : j.resolve(e.data.rounds);
  };
  worker.onerror = () => {
    worker = null;
    for (const j of jobs.values()) j.fallback();
    jobs.clear();
  };
} catch {
  worker = null;
}
function runCycle(args) {
  const local = () => new Promise((res) => setTimeout(() => res(buildCycle(args)), 30));
  if (!worker) return local();
  return new Promise((resolve) => {
    const id = ++jobId;
    jobs.set(id, { resolve, fallback: () => local().then(resolve) });
    worker.postMessage({ id, args: JSON.parse(JSON.stringify(args)) });
  });
}

function nameMap(ev) {
  return Object.fromEntries(ev.players.map((p) => [p.id, p.name]));
}
// 名字太長時字小一點，才不會從字中間被切斷
const nameWidth = (s) => [...String(s)].reduce((w, ch) => w + (/[⺀-鿿豈-﫿＀-￯]/.test(ch) ? 1 : 0.6), 0);
const nameCls = (s) => {
  const w = nameWidth(s);
  return w > 6 ? " xlong" : w > 4.2 ? " long" : "";
};
// 每個名字包成一個 span（帶球員 id），換場動畫要靠它找到名字要飛去哪裡
const teamNames = (ids, names) =>
  ids.map((id) => `<span class="pn${nameCls(names[id] || "?")}" data-pid="${esc(id)}">${esc(names[id] || "?")}</span>`).join("<br>");
const teamText = (ids, names) => ids.map((id) => names[id] || "?").join("/");
const teamWords = (ids, names) => ids.map((id) => names[id] || "?").join("、");

function progress(ev) {
  const all = ev.rounds.flatMap((r) => r.matches);
  return { done: all.filter(isFinished).length, total: all.length };
}

function defaultCourts(n, mode) {
  if (mode === "singles") return Math.max(1, Math.min(4, Math.floor(n / 3)));
  return Math.max(1, Math.min(4, Math.floor(n / 5)));
}

// 晚到的人：從第 3 場開始排（球場多時至少跳過第一批）
const lateFromRound = (perRound) => Math.max(1, Math.floor(2 / Math.max(1, perRound)));
const isLate = (p) => !!p.arrive || (p.notes || []).some((n) => /晚到|遲到/.test(n));
const PER_GAME = 15; // 估時間用：每場大約幾分鐘

function fmtMinutes(min) {
  if (min < 60) return `${min} 分鐘`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

function draftInfo(d) {
  const active = d.players.filter((p) => p.active);
  const size = d.mode === "singles" ? 2 : 4;
  const perRound = Math.min(d.courts, Math.floor(active.length / size));
  const rest = active.length - perRound * size;
  const late = active.filter(isLate);
  const fromLate = lateFromRound(perRound);
  const players = active.map((p) => ({ id: p.id, fromRound: isLate(p) ? fromLate : 0 }));
  return { active, size, perRound, rest, late, fromLate, players };
}

// 實際排一次（同樣的設定只排一次），畫面上的場數和開始後的賽程一定一樣；在背景算
function preview(d, info) {
  if (info.perRound <= 0) return null;
  const key = JSON.stringify([d.mode, d.courts, info.players, d.seed]);
  if (d.preview?.key === key) return d.preview;
  const p = { key, rounds: null };
  p.promise = runCycle({ players: info.players, mode: d.mode, courts: d.courts, seed: d.seed }).then((rounds) => {
    p.rounds = rounds;
    if (state.draft === d && d.preview === p && state.view === "setup") renderSetup();
    return rounds;
  });
  d.preview = p;
  return p;
}

function previewStats(info, rounds) {
  const games = rounds.reduce((n, r) => n + r.matches.length, 0);
  const count = {};
  rounds.forEach((r) => r.matches.forEach((m) => playersOf(m).forEach((id) => (count[id] = (count[id] || 0) + 1))));
  const onTime = info.players.filter((p) => !p.fromRound).map((p) => count[p.id] || 0);
  const lateStart = rounds.slice(0, info.fromLate).reduce((n, r) => n + r.matches.length, 0) + 1;
  return {
    games,
    minutes: rounds.length * PER_GAME,
    eachMin: onTime.length ? Math.min(...onTime) : 0,
    eachMax: onTime.length ? Math.max(...onTime) : 0,
    streak: maxPlayStreak(rounds),
    lateStart,
  };
}

// ---------- 畫面切換（手機的返回鍵會回到上一個畫面） ----------
let depth = 0;
const entry = () => ({ view: state.view, eventId: state.eventId, tab: state.tab, depth });
function nav(view, opts = {}, replace = false) {
  Object.assign(state, { editing: null, early: null, fixing: null }, opts, { view });
  if (replace) history.replaceState(entry(), "", location.pathname);
  else {
    depth++;
    history.pushState(entry(), "", location.pathname);
  }
  render();
  window.scrollTo(0, 0);
}
function goBack() {
  if (depth > 0) history.back();
  else nav("home", { shared: null }, true);
}
window.addEventListener("popstate", (e) => {
  // 開著視窗時按返回：只關掉視窗
  if (!$("#sheet").hidden) {
    closeSheet();
    history.pushState(entry(), "", location.pathname);
    return;
  }
  const s = e.state || { view: "home", depth: 0 };
  depth = s.depth || 0;
  Object.assign(state, { view: s.view, eventId: s.eventId ?? state.eventId, tab: s.tab || "live", editing: null, early: null, fixing: null });
  if (s.view !== "event") state.shared = null;
  const gone =
    ((s.view === "paste" || s.view === "setup") && !state.draft) || (s.view === "event" && !current());
  if (gone) {
    // 那個畫面已經不在了（例如球局已經建立、或被刪除）：再往前回到首頁
    if (depth > 0) return history.back();
    state.view = "home";
  }
  render();
});

// ---------- 畫面 ----------
function setTop(title, { back = false, menu = false } = {}) {
  $("#topTitle").textContent = title;
  $("#backBtn").hidden = !back;
  $("#menuBtn").hidden = !menu;
  document.title = title === "Pickle Party" ? title : `${title} · Pickle Party`;
}

function render() {
  const v = state.view;
  app.dataset.view = v;
  if (v === "home") renderHome();
  else if (v === "paste") renderPaste();
  else if (v === "setup") renderSetup();
  else if (v === "event") renderEvent();
  if (v === "event" && !state.shared) ensureWatch(current());
  else stopWatch();
  updateWakeLock();
}

// 最近還沒打完的球局（maxAge 毫秒內用過）
function resumable(maxAge) {
  return state.events
    .filter((ev) => Date.now() - (ev.touchedAt || ev.createdAt) < maxAge && !courtFlow(ev).allDone)
    .sort((a, b) => (b.touchedAt || b.createdAt) - (a.touchedAt || a.createdAt))[0];
}

function renderHome() {
  setTop("Pickle Party");
  const list = [...state.events].sort((a, b) => b.createdAt - a.createdAt);
  app.innerHTML = `
    <button class="btn primary block" data-action="new" style="min-height:60px">＋ 貼上接龍，開新球局</button>
    <div style="height:16px"></div>
    ${
      list.length
        ? list
            .map((ev) => {
              const p = progress(ev);
              const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
              return `<button class="card event-item" data-action="open" data-id="${ev.id}">
                <div class="row between"><strong class="ev-title">${esc(ev.title)}</strong><span class="ev-sub">${ev.cloud ? (ev.cloud.key ? "🔗 同步" : "👀 觀看") : ""}</span></div>
                <div class="ev-sub">${ev.mode === "singles" ? "單打" : "雙打"}・${ev.courts} 面球場・${ev.players.filter((p) => !p.left).length} 人・已打 ${p.done}／${p.total} 場</div>
                <div class="progress"><i style="width:${pct}%"></i></div>
              </button>`;
            })
            .join("")
        : `<div class="card empty">
            ${RALLY}
            <p><strong>還沒有球局</strong></p>
            <p class="ev-sub">在 LINE 長按接龍訊息 → 複製，<br>回到這裡按上面的按鈕貼上就好。</p>
          </div>`
    }
    <button class="btn block theme-btn" data-action="theme">🌓 畫面顏色：${THEME_NAMES[lsGet(THEME_KEY) || ""]}</button>`;
}

const canReadClipboard = () => !!navigator.clipboard?.readText;

function renderPaste() {
  setTop("新球局", { back: true });
  const d = state.draft;
  const parsed = d.players.length > 0;
  const resume = resumable(2 * 86400e3);
  app.innerHTML = `
    ${
      resume
        ? `<button class="card resume-card" data-action="open" data-id="${resume.id}">
            <span class="resume-play">▶</span>
            <span><span class="resume-sub">繼續上次的球局</span><br><b>${esc(resume.title)}</b><br><span class="resume-sub">已打 ${progress(resume).done}／${progress(resume).total} 場</span></span>
          </button>`
        : ""
    }
    <div class="steps"><span class="on"></span><span></span></div>
    <div class="card stack paste-card">
      ${RALLY}
      <h2><span class="hl">複製 LINE 的報名接龍</span>，貼進來</h2>
      ${canReadClipboard() ? `<button class="btn ${d.text ? "" : "primary"} block" data-action="paste-clip">📋 貼上剛剛複製的接龍</button>` : ""}
      <textarea id="rosterText" placeholder="${canReadClipboard() ? "或長按這裡 → 選「貼上」" : "長按這裡 → 選「貼上」"}">${esc(d.text)}</textarea>
      <p class="hint">格式：每行一個編號和名字，像「1.倫」「2 小甄」</p>
      <div class="row" style="justify-content:flex-end">
        <button class="btn sm" data-action="clear-text">清除</button>
      </div>
    </div>
    <div class="card stack" id="parsedCard" ${parsed || d.text ? "" : "hidden"}>
      <div class="row between">
        <h2 style="margin:0">抓到 <span id="countActive">${d.players.filter((p) => p.active).length}</span> 位球員</h2>
        <span class="hint">點名字可以改名</span>
      </div>
      <div class="chips" id="chips">${chipsHtml(d.players)}</div>
      <form class="row" data-form="add-player">
        <input type="text" name="name" placeholder="手動加人" autocomplete="off" />
        <button class="btn sm" type="submit">加入</button>
      </form>
      ${d.time ? `<p class="hint" style="margin:0">時間 ${d.time.start}–${d.time.end}（${d.time.minutes} 分鐘）</p>` : ""}
    </div>
    <div class="sticky-cta">
      <button class="btn primary block" data-action="to-setup" ${d.players.some((p) => p.active) ? "" : "disabled"} id="nextBtn">下一步 ${ARROW}</button>
    </div>`;
}

function chipsHtml(players) {
  if (!players.length) return `<span class="hint">還沒抓到名字，確認每行是「1.名字」或「1 名字」的格式</span>`;
  return players
    .map((p) =>
      state.renaming === p.id
        ? `<span class="chip editing"><input class="chip-input" data-rename="${p.id}" value="${esc(p.name)}" aria-label="修改 ${esc(p.name)} 的名字" enterkeyhint="done" autocomplete="off" /></span>`
        : `<span class="chip ${p.active ? "" : "off"}">
        <button type="button" class="chip-name" data-action="rename" data-id="${p.id}" aria-label="修改名字：${esc(p.name)}">${esc(p.name)}</button>
        ${p.arrive ? `<span class="tag">${esc(p.arrive)} 到</span>` : ""}
        ${p.waitlist ? `<span class="tag">候補</span>` : ""}
        ${p.dup ? `<span class="tag">同名？</span>` : ""}
        ${p.notes?.length ? `<span class="tag">${esc(p.notes.join("、"))}</span>` : ""}
        <button class="x" data-action="toggle-player" data-id="${p.id}" aria-label="${p.active ? "移除" : "加回"} ${esc(p.name)}">${p.active ? "×" : "↺"}</button>
      </span>`
    )
    .join("");
}

function renderSetup() {
  setTop("新球局", { back: true });
  const d = state.draft;
  const info = draftInfo(d);
  const tooFew = info.active.length < info.size;
  const p = tooFew ? null : preview(d, info);
  const st = p?.rounds ? previewStats(info, p.rounds) : null;
  const n = info.active.length;
  const lateStart = st ? st.lateStart : info.fromLate * info.perRound + 1;
  // 連打幾場：看實際排出來的賽程
  const theory = info.rest > 0 ? Math.max(2, Math.ceil(n / info.rest) - 1) : Infinity;
  let restRule = "休息時間平均，<b>不連續打三場以上</b>";
  if (info.rest === 0) restRule = `休息時間平均<br><span class="note">（目前人數剛好沒有人休息，每個人每場都會上）</span>`;
  else if (st && st.streak > 2) {
    const why =
      st.streak > theory && info.late.length
        ? `${info.late.map((x) => esc(x.name)).join("、")} 晚到，前面幾場人比較少`
        : `${n} 人、${info.perRound} 面球場，每次只有 ${info.rest} 人休息`;
    restRule = `休息時間平均，<b>最多連打 ${st.streak} 場</b><br><span class="note">（${why}）</span>`;
  }
  app.innerHTML = `
    <div class="steps"><span class="on"></span><span class="on"></span></div>
    <div class="card">
      <h2><span class="hl">選打法</span></h2>
      <div class="field"><label for="titleInput">球局名稱</label><input type="text" id="titleInput" value="${esc(d.title)}" style="max-width:60%" /></div>
      <div class="field" style="display:block">
        <div class="seg" role="group" aria-label="單打或雙打">
          <button class="${d.mode === "doubles" ? "on" : ""}" data-action="mode" data-v="doubles">雙打</button>
          <button class="${d.mode === "singles" ? "on" : ""}" data-action="mode" data-v="singles">單打</button>
        </div>
      </div>
      <div class="field">
        <label>同時開打的球場面數</label>
        <div class="stepper"><button data-action="step" data-k="courts" data-d="-1" aria-label="減少球場">−</button><output>${d.courts}</output><button data-action="step" data-k="courts" data-d="1" aria-label="增加球場">＋</button></div>
      </div>
    </div>
    ${
      tooFew
        ? `<div class="banner">人數不夠：${d.mode === "doubles" ? "雙打至少 4 人" : "單打至少 2 人"}，目前 ${n} 人</div>`
        : `<div class="summary">
            ${n} 人・${info.perRound} 面球場同時開打${info.rest > 0 ? `、每次 ${info.rest} 人休息` : ""}
            ${d.courts > info.perRound ? `<br><span class="note">（人數只夠開 ${info.perRound} 面球場）</span>` : ""}
            <br><span class="note">${st ? `這一輪共 <b>${st.games} 場</b>，大約 ${fmtMinutes(st.minutes)}（每場以 ${PER_GAME} 分鐘算）` : "排賽程中…"}</span>
            ${info.late.length ? `<br><span class="note">晚到：${info.late.map((x) => `${esc(x.name)}${x.arrive ? ` ${esc(x.arrive)}` : ""}`).join("、")}，從第 ${lateStart} 場開始排</span>` : ""}
          </div>`
    }
    ${tooFew ? "" : `<div class="rules">
      <div class="rules-title">${BALL}排法規則</div>
      <ul>
        <li>每一個人都和不同的人${d.mode === "doubles" ? "<b>搭檔一次</b>" : "<b>對打一次</b>"}</li>
        ${d.mode === "doubles" ? "<li>盡量和<b>不同的組合</b>對打</li>" : ""}
        <li>${restRule}</li>
      </ul>
      ${st && st.eachMin !== st.eachMax ? `<p class="rules-note">因數學關係，這一輪少打一場的人，下一輪會多打一場</p>` : ""}
    </div>`}
    <div class="sticky-cta">
      <button class="btn primary block" data-action="create" ${tooFew ? "disabled" : ""} style="min-height:60px">開始排賽程 ${BALL}</button>
    </div>`;
}

// 「一輪」= 每個人都和每個人搭檔過一次；round.cycle 記錄是第幾輪（0 起算）
const CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const cycleName = (i) => `第${CN[i] || i + 1}輪`;
const cycleCount = (ev) => 1 + Math.max(0, ...ev.rounds.map((r) => r.cycle || 0));
// 每場比賽在它那一輪裡是第幾場
function matchNumbers(ev) {
  const map = new Map();
  const totals = {};
  ev.rounds.forEach((r, ri) =>
    r.matches.forEach((m, mi) => {
      const cy = r.cycle || 0;
      totals[cy] = (totals[cy] || 0) + 1;
      map.set(`${ri}-${mi}`, { cycle: cy, n: totals[cy] });
    })
  );
  return { map, totals };
}
// 目前在打的是第幾輪、打完幾場
function cycleProgress(ev, flow = courtFlow(ev)) {
  const at = flow.courts.find(Boolean) || flow.pending[0];
  const cy = at ? ev.rounds[at.ri].cycle || 0 : cycleCount(ev) - 1;
  const done = ev.rounds.reduce((n, r) => n + ((r.cycle || 0) === cy ? r.matches.filter(isFinished).length : 0), 0);
  return { cy, done, total: matchNumbers(ev).totals[cy] || 0 };
}

function renderEvent() {
  const ev = current();
  if (!ev) {
    state.view = "home";
    return render();
  }
  setTop(ev.title, { back: true, menu: true });
  const tab = state.tab;
  const cp = cycleProgress(ev);
  app.innerHTML = `
    <div class="tabs"><div class="seg" role="tablist">
      <button class="${tab === "live" ? "on" : ""}" data-action="tab" data-v="live" role="tab">現在</button>
      <button class="${tab === "rounds" ? "on" : ""}" data-action="tab" data-v="rounds" role="tab">賽程 ${cp.done}/${cp.total}</button>
      <button class="${tab === "rank" ? "on" : ""}" data-action="tab" data-v="rank" role="tab">排名</button>
    </div></div>
    ${state.shared ? `<div class="banner">這是別人分享的唯讀賽程。<button class="btn sm" data-action="import-shared" style="margin-left:6px">存到我的手機</button></div>` : readonly() ? `<div class="banner live">👀 觀看模式・比分會即時更新</div>` : ""}
    ${tab === "live" ? liveHtml(ev) : tab === "rounds" ? roundsHtml(ev) : rankHtml(ev)}`;
  state.justDone = null;
  updateSyncBadge();
  // 整場打完時跳出「打完了」
  if (tab === "live") {
    const all = courtFlow(ev).allDone;
    const prev = lastAllDone.get(ev.id);
    lastAllDone.set(ev.id, all);
    if (prev === false && all) showBanner(`<span class="big-emoji">🏆</span><b>${cycleName(cycleCount(ev) - 1)}打完了！</b>`);
  }
}

// ---------- 換場動畫 ----------
const lastAllDone = new Map(); // 每個球局上次顯示時是否已經全部打完

// 畫面上各球場目前顯示的比賽（data-key），和最新資料推算的結果比較
const shownCourtKeys = () => [...document.querySelectorAll(".courts > .card[data-court]")].map((el) => el.dataset.key || "");
function courtsChanged(ev) {
  const shown = shownCourtKeys();
  if (!shown.length) return false;
  const now = courtFlow(ev).courts.map((x) => (x ? x.key : ""));
  return now.some((k, i) => k !== shown[i]);
}
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const play = (el, frames, opts) => el.animate(frames, { fill: "forwards", ...opts }).finished;

// 換場：「下一場」裡的名字往上飛，取代球場裡原本的名字（只動有換人的球場）
// stampCard：自己按「這場打完了」的那張卡片（先蓋章）；別人同步過來的沒有
// opts.force：一定要播動畫的球場（換場時比賽編號沒變，但人換了）
// opts.sourceKey：那面球場的新名字，要從「下一場」裡哪一列飛上來
async function advanceWithFlight(stampCard, opts = {}) {
  const ev = current();
  if (reduceMotion() || !ev || document.visibilityState === "hidden") return renderEvent();
  state.animating = true;
  try {
    const shown = shownCourtKeys();
    const flow = courtFlow(ev);
    const changed = flow.courts.map((x, k) => ((x ? x.key : "") !== shown[k] || opts.force?.includes(k) ? k : -1)).filter((k) => k >= 0);
    // 1. 剛打完的那場先蓋章
    if (stampCard) {
      stampCard.querySelector(".row")?.insertAdjacentHTML("beforeend", `<span class="done-badge just">已完成</span>`);
      stampCard.querySelectorAll("button").forEach((b) => (b.disabled = true));
      await wait(450);
    }
    // 2. 記下要上場的人在「下一場」裡的位置
    const sources = [];
    for (const k of changed) {
      const nk = opts.sourceKey?.[k] || flow.courts[k]?.key;
      if (!nk) continue;
      document.querySelectorAll(`.next-card .mini-match[data-key="${nk}"] .pn`).forEach((el) => {
        const cs = getComputedStyle(el);
        sources.push({ court: k, pid: el.dataset.pid, name: el.textContent, rect: el.getBoundingClientRect(), font: parseFloat(cs.fontSize), lh: cs.lineHeight });
      });
    }
    // 3. 有換人的球場：舊的名字、比分、按鈕往上淡出
    const sel = (k) => `.courts > .card[data-court="${k}"]`;
    const parts = (k) => `${sel(k)} .score-num, ${sel(k)} .score-btn, ${sel(k)} .btn, ${sel(k)} .wait-box, ${sel(k)} .last-line`;
    const olds = changed.flatMap((k) => [...document.querySelectorAll(`${sel(k)} .pn, ${sel(k)} .scorebox, ${sel(k)} .done-badge, ${parts(k)}`)]);
    await Promise.all(
      olds.map((el, i) => play(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-18px)" }], { duration: 220, delay: i * 12, easing: "ease-in" }))
    );
    // 4. 畫出新的狀態（有換人的球場、休息名單、下一場先藏起來）
    const y = window.scrollY;
    renderEvent();
    window.scrollTo(0, y);
    const later = [...changed.flatMap((k) => [...document.querySelectorAll(parts(k))]), ...document.querySelectorAll("#app > .rest-line, .next-card > :not(h2)")];
    later.forEach((el) => (el.style.opacity = "0"));
    const flyingPids = new Set(sources.map((s) => `${s.court}:${s.pid}`));
    // 沒有分身可以飛的名字（例如原本不在「下一場」清單裡）直接淡入
    changed.forEach((k) =>
      document.querySelectorAll(`${sel(k)} .pn`).forEach((el) => {
        if (!flyingPids.has(`${k}:${el.dataset.pid}`)) later.push(el), (el.style.opacity = "0");
      })
    );
    // 5. 名字分身飛到球場裡
    const flights = sources.map((s, i) => {
      const target = document.querySelector(`${sel(s.court)} .pn[data-pid="${CSS.escape(s.pid)}"]`);
      if (!target) return Promise.resolve();
      target.style.visibility = "hidden";
      const tr = target.getBoundingClientRect();
      const sc = parseFloat(getComputedStyle(target).fontSize) / s.font;
      const clone = document.createElement("div");
      clone.className = "fly";
      clone.textContent = s.name;
      Object.assign(clone.style, { left: `${s.rect.left}px`, top: `${s.rect.top}px`, fontSize: `${s.font}px`, lineHeight: s.lh });
      document.body.appendChild(clone);
      const dx = tr.left - s.rect.left;
      const dy = tr.top - s.rect.top;
      return clone
        .animate(
          [
            { transform: "translate(0,0) scale(1) rotate(0deg)" },
            { transform: `translate(${dx * 0.5}px, ${dy * 0.55 - 26}px) scale(${(1 + sc) / 2 + 0.12}) rotate(${i % 2 ? 6 : -6}deg)`, offset: 0.55 },
            { transform: `translate(${dx}px, ${dy}px) scale(${sc}) rotate(0deg)` },
          ],
          { duration: 720, delay: i * 70, easing: "cubic-bezier(.45,.05,.3,1)", fill: "forwards" }
        )
        .finished.then(() => {
          target.style.visibility = "";
          target.animate([{ transform: "scale(1.18)" }, { transform: "scale(1)" }], { duration: 260, easing: "cubic-bezier(.3,1.6,.5,1)" });
          clone.remove();
        });
    });
    await Promise.all(flights);
    // 6. 按鈕、休息名單、下一場浮出來；完成場數跳一下
    $(".live-status .ls-main")?.animate([{ transform: "scale(1.15)" }, { transform: "scale(1)" }], { duration: 400 });
    await Promise.all(
      later.map((el, i) =>
        play(el, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: i * 40, easing: "ease-out" }).then(() => {
          el.style.opacity = "";
          el.getAnimations().forEach((a) => a.cancel());
        })
      )
    );
  } finally {
    state.animating = false;
  }
}

// 畫面中間的提示泡泡
function showBanner(html) {
  let b = $("#roundBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "roundBanner";
    b.className = "round-banner";
    b.setAttribute("role", "status");
    document.body.appendChild(b);
  }
  b.innerHTML = html;
  b.classList.remove("show");
  void b.offsetWidth; // 重新觸發動畫
  b.classList.add("show");
  clearTimeout(b._t);
  b._t = setTimeout(() => b.classList.remove("show"), 1700);
}

const nameList = (ids, names) => ids.map((id) => `<span class="nm">${esc(names[id] || "?")}</span>`).join("、");

// ---------- 記分：大按鈕 ----------
// 可以改分數的時候：還沒打完，或正在「改比分」
const canScore = (m, key) => !readonly() && (!isFinished(m) || state.fixing === key);

// courtNo：在「現在」分頁時是實際的球場編號；在「賽程」分頁時為 null
function scoreControls(ev, r, mi, m, courtNo) {
  const key = `${r}-${mi}`;
  const names = nameMap(ev);
  const finished = isFinished(m);
  const editable = canScore(m, key);
  const winA = finished && m.sa > m.sb;
  const winB = finished && m.sb > m.sa;
  const num = matchNumbers(ev).map.get(key)?.n;
  const side = (s) => {
    const ids = s === "a" ? m.a : m.b;
    const val = s === "a" ? m.sa : m.sb;
    const who = teamWords(ids, names);
    return `<div class="team ${s} ${(s === "a" ? winA : winB) ? "win" : ""}">
      <div class="names">${teamNames(ids, names)}</div>
      ${
        editable
          ? `<button type="button" class="score-num" data-action="pick-score" data-r="${r}" data-m="${mi}" data-s="${s}" aria-label="${esc(who)} ${val} 分，點一下直接選分數">${val}</button>
             <button type="button" class="score-btn plus" data-action="score" data-r="${r}" data-m="${mi}" data-s="${s}" data-d="1" aria-label="${esc(who)} 加一分">＋1</button>
             <button type="button" class="score-btn minus" data-action="score" data-r="${r}" data-m="${mi}" data-s="${s}" data-d="-1" aria-label="${esc(who)} 減一分" ${val ? "" : "disabled"}>−1</button>`
          : `<div class="scorebox"><span class="num">${val}</span></div>`
      }
    </div>`;
  };
  let buttons = "";
  if (!readonly()) {
    if (!finished)
      buttons = `<button class="btn primary block" style="margin-top:12px" data-action="finish" data-r="${r}" data-m="${mi}">這場打完了 ✓</button>${
        courtNo && !m.sa && !m.sb
          ? `<button class="btn block swap-btn" data-action="absent" data-r="${r}" data-m="${mi}">🙋 有人還沒到？換一場</button>`
          : ""
      }`;
    else if (state.fixing === key)
      buttons = `<button class="btn primary block" style="margin-top:12px" data-action="fix-done" data-r="${r}" data-m="${mi}">改好了 ✓</button>`;
    else buttons = `<button class="btn block" style="margin-top:12px" data-action="fix-score" data-r="${r}" data-m="${mi}">改比分</button>`;
  }
  return `
    <div class="row between">
      <span class="court-label">${courtNo ? `${courtNo} 號球場<span class="sub">・第 ${num} 場${ev.rounds[r].extra ? "（加場）" : ""}</span>` : `第 ${num} 場${ev.rounds[r].extra ? "（加場）" : ""}`}</span>
      ${finished ? `<span class="done-badge${state.justDone === key ? " just" : ""}">已完成</span>` : ""}
    </div>
    <div class="match">${side("a")}<span class="vs">VS</span>${side("b")}</div>
    ${buttons}`;
}

// 比賽結果一句話：「阿德、Yen 贏 11:7」
function resultText(m, names) {
  if (m.sa === m.sb) return `平手 ${m.sa}:${m.sb}`;
  const [w, hi, lo] = m.sa > m.sb ? [m.a, m.sa, m.sb] : [m.b, m.sb, m.sa];
  return `${teamWords(w, names)} 贏 ${hi}:${lo}`;
}

function liveHtml(ev) {
  const flow = courtFlow(ev);
  const names = nameMap(ev);
  if (flow.allDone) {
    const top = standings(ev.players, ev.rounds).filter((t) => t.rank && t.rank <= 3);
    const cyc = cycleCount(ev);
    return `<div class="card empty">
      <div class="big">🏆</div>
      <p class="done-title"><strong>${cycleName(cyc - 1)}打完了！</strong>${cyc > 1 ? `<br><span class="note">排名是 ${cyc} 輪累計</span>` : ""}</p>
      <div class="podium">${top.map((t) => `<div>${["🥇", "🥈", "🥉"][t.rank - 1]} ${esc(t.name)}</div>`).join("")}</div>
      ${
        readonly()
          ? ""
          : `<div class="stack">
              <button class="btn primary block" data-action="new-cycle">🔁 再來${cycleName(cyc)}（同一組人，成績累計）</button>
              <button class="btn block" data-action="copy-text">複製結果貼到 LINE</button>
            </div>`
      }
    </div>`;
  }
  const activeIds = ev.players.filter((p) => !p.left).map((p) => p.id);
  const wait = waitingFor(ev, flow);
  const nums = matchNumbers(ev);
  const cp = cycleProgress(ev, flow);
  const ro = readonly();
  const courtCard = (x, k) => {
    const last = lastOnCourt(ev, flow, k);
    const lastLine = last ? `<div class="last-line">上一場：${esc(resultText(last.m, names))}</div>` : "";
    if (x) {
      const m = ev.rounds[x.ri].matches[x.mi];
      return `<div class="card court" id="court-${k}" data-court="${k}" data-key="${x.key}">${scoreControls(ev, x.ri, x.mi, m, k + 1).replace('<div class="match">', `${lastLine}<div class="match">`)}</div>`;
    }
    // 場邊有人可以先打：賽程裡有現成的一場就提前；沒有就用場邊的人加打一場
    const pull = !ro && flow.pending.length ? findPull(ev, k) : null;
    const pm = pull && ev.rounds[pull.from.ri].matches[pull.from.mi];
    const extra = !ro && !pull ? planExtra(ev, k, Date.now()) : null;
    const em = extra?.round.matches[0];
    return `<div class="card court court-wait" id="court-${k}" data-court="${k}" data-key="">
      <div class="row between"><span class="court-label">${k + 1} 號球場</span></div>
      ${lastLine}
      <div class="wait-box">${BALL}${
        flow.pending.length
          ? `<b>等待中</b><span>下一場要等 ${nameList(wait, names) || "其他球場"} 打完</span>`
          : `<b>這面球場打完了</b><span>等其他球場結束</span>`
      }</div>
      ${
        pm
          ? `<button class="btn primary block pull-btn" data-action="pull" data-k="${k}">▶ 先讓場邊的人打第 ${nums.map.get(pull.from.key).n} 場<span class="pull-names">${esc(teamWords(pm.a, names))} vs ${esc(teamWords(pm.b, names))}</span></button>`
          : em
            ? `<button class="btn primary block pull-btn" data-action="extra" data-k="${k}">▶ 場邊的人先加打一場<span class="pull-names">${esc(teamWords(em.a, names))} vs ${esc(teamWords(em.b, names))}</span></button>
               <p class="pull-note">不影響原本的賽程，打完這面球場再接著排好的比賽</p>`
            : ""
      }
    </div>`;
  };
  // 「下一場」：接下來要上場的比賽（照順序，最多和球場數一樣多）
  const upcoming = flow.pending.slice(0, flow.nCourts);
  const upcomingIds = new Set(upcoming.flatMap((u) => playersOf(ev.rounds[u.ri].matches[u.mi])));
  const nextRest = activeIds.filter((id) => !upcomingIds.has(id));
  const bench = benched(ev, flow, activeIds);
  // 給群組看比分的連結（只能看、不能改）；放在最下面，不佔上面的位置
  const linkBtn = cloudEnabled() && !state.shared
    ? `<button class="btn block copy-link" data-action="${ev.cloud ? "copy-view-link" : "share-view"}">${SHARE}${ev.cloud ? "複製觀看連結（貼到 LINE 群組）" : "建立觀看連結（貼到 LINE 群組）"}</button>`
    : "";
  return `
    <div class="live-status">
      <span class="ls-main">${cycleCount(ev) > 1 ? `${cycleName(cp.cy)}・` : ""}已完成 ${cp.done} / ${cp.total} 場</span>
      ${ev.cloud ? `<span class="sync-state">🔗 即時同步中</span>` : ""}
    </div>
    ${
      flow.nCourts >= 2
        ? `<div class="court-jump">${flow.courts
            .map((x, k) => {
              const m = x && ev.rounds[x.ri].matches[x.mi];
              return `<button class="jump" data-action="jump" data-k="${k}">${k + 1} 號球場<b>${m ? `${m.sa} : ${m.sb}` : "等待中"}</b></button>`;
            })
            .join("")}</div>`
        : ""
    }
    <div class="courts">${flow.courts.map(courtCard).join("")}</div>
    ${
      upcoming.length
        ? `<div class="card next-card" style="margin-top:14px">
            <h2>下一場</h2>
            ${upcoming
              .map((u) => {
                const m = ev.rounds[u.ri].matches[u.mi];
                return `<div class="mini-match" data-key="${u.key}"><span class="ct">第 ${nums.map.get(u.key).n} 場</span><span class="t r">${teamNames(m.a, names)}</span><span class="s">vs</span><span class="t">${teamNames(m.b, names)}</span></div>`;
              })
              .join("")}
            ${nextRest.length ? `<div class="rest-line">接著休息：${nameList(nextRest, names)}</div>` : ""}
          </div>`
        : ""
    }
    ${bench.length ? `<div class="rest-line">🪑 現在場邊休息：${nameList(bench, names)}</div>` : ""}
    ${linkBtn}`;
}

function roundsHtml(ev) {
  const names = nameMap(ev);
  const flow = courtFlow(ev);
  const nums = matchNumbers(ev);
  const multi = cycleCount(ev) > 1;
  const playing = new Map(flow.courts.filter(Boolean).map((x) => [x.key, flow.courtOf.get(x.key)]));
  const curRounds = new Set(flow.courts.filter(Boolean).map((x) => x.ri));
  let lastCycle = -1;
  return `<div class="card round-list">
    ${ev.rounds
      .map((round, r) => {
        const cy = round.cycle || 0;
        const head = multi && cy !== lastCycle ? `<div class="cycle-head">${cycleName(cy)}</div>` : "";
        lastCycle = cy;
        return `${head}<div class="round ${curRounds.has(r) ? "current" : ""}">
          ${round.matches
            .map((m, mi) => {
              const key = `${r}-${mi}`;
              const num = nums.map.get(key).n;
              const finished = isFinished(m);
              if (state.editing === key) {
                // 還沒輪到的比賽：先確認要「提前記分」才出現按鈕，免得滑動時誤按
                const notYet = !finished && !playing.has(key) && !hasProgress(m) && state.early !== key;
                return `<div class="expanded">${
                  notYet
                    ? `<div class="early-box"><div class="court-label">第 ${num} 場</div>
                        <div class="mini-match static"><span class="t r">${teamNames(m.a, names)}</span><span class="s">vs</span><span class="t">${teamNames(m.b, names)}</span></div>
                        <p>這場還沒輪到。</p>
                        ${readonly() ? "" : `<button class="btn block" data-action="early" data-r="${r}" data-m="${mi}">提前記分</button>`}</div>`
                    : scoreControls(ev, r, mi, m, null)
                }
                  <button class="btn block" style="margin-top:10px" data-action="collapse">收合</button></div>`;
              }
              const where = [round.extra ? "加場" : "", playing.has(key) ? `${playing.get(key)} 號球場・比賽中` : finished && flow.courtOf.get(key) ? `${flow.courtOf.get(key)} 號球場` : ""].filter(Boolean).join("・");
              const wa = finished && m.sa > m.sb ? " won" : "";
              const wb = finished && m.sb > m.sa ? " won" : "";
              return `<button class="mini-match${finished ? " done" : ""}" data-action="expand" data-r="${r}" data-m="${mi}">
                <span class="ct"><b>第 ${num} 場</b>${where ? `<br>${where}` : ""}</span>
                <span class="t r${wa}">${teamNames(m.a, names)}</span>
                <span class="s">${finished || m.sa || m.sb ? `${m.sa} : ${m.sb}` : "vs"}</span>
                <span class="t${wb}">${teamNames(m.b, names)}</span>
              </button>`;
            })
            .join("")}
          ${round.rest.length ? `<div class="rest-line">休息：${nameList(round.rest, names)}</div>` : ""}
        </div>`;
      })
      .join("")}
  </div>`;
}

function rankHtml(ev) {
  const rows = standings(ev.players.filter((p) => !p.left || ev.rounds.some((r) => r.matches.some((m) => playersOf(m).includes(p.id)))), ev.rounds);
  const games = {};
  for (const r of ev.rounds) for (const m of r.matches) for (const id of playersOf(m)) games[id] = (games[id] || 0) + 1;
  return `<div class="card" style="padding:8px 12px">
    <table>
      <thead><tr><th></th><th style="text-align:left">球員</th><th>勝/敗</th><th>淨勝分</th><th>已打</th></tr></thead>
      <tbody>
      ${rows
        .map((t) => {
          const diff = t.pf - t.pa;
          return `<tr>
            <td class="medal">${t.rank ? ["🥇", "🥈", "🥉"][t.rank - 1] || t.rank : "–"}</td>
            <td class="name"><span class="${nameCls(t.name).trim()}">${esc(t.name)}</span></td>
            <td>${t.w}/${t.l}</td>
            <td>${diff > 0 ? "+" : ""}${diff}</td>
            <td>${t.played}/${games[t.id] || 0}</td>
          </tr>`;
        })
        .join("")}
      </tbody>
    </table>
  </div>
  <p class="rank-note">${cycleCount(ev) > 1 ? `${cycleCount(ev)} 輪累計・` : ""}排名：勝率 → 每場平均淨勝分 → 得分多 → 失分少。成績一樣名次相同。<br>已打：打完的場數／這次一共排了幾場</p>`;
}

// ---------- 底部視窗 ----------
function openSheet(html) {
  const s = $("#sheet");
  s.innerHTML = `<div class="panel" role="dialog" aria-modal="true">${html}</div>`;
  s.hidden = false;
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet").innerHTML = "";
  state.players = null; // 調整球員：沒按「重排」就關掉 = 不改
  state.absentFor = null;
  state.picking = null;
  finishAsk(false);
}

function eventMenu() {
  const ev = current();
  const theme = `<button class="menu-item" data-action="theme"><span class="ico">🌓</span>畫面顏色：${THEME_NAMES[lsGet(THEME_KEY) || ""]}</button>`;
  if (readonly() && !state.shared) {
    openSheet(`<h3>${esc(ev.title)}</h3>
      <button class="menu-item" data-action="share-view"><span class="ico">👀</span>分享觀看連結</button>
      <button class="menu-item" data-action="copy-text"><span class="ico">💬</span>複製賽程文字</button>
      ${theme}
      <button class="menu-item danger" data-action="delete-event"><span class="ico">🗑</span>從這支手機移除</button>
      <button class="menu-item" data-action="close-sheet"><span class="ico">✕</span>關閉</button>`);
    return;
  }
  if (readonly()) {
    openSheet(`<h3>分享的賽程</h3>
      <button class="menu-item" data-action="import-shared"><span class="ico">💾</span>存到我的手機（可以記分）</button>
      ${theme}
      <button class="menu-item" data-action="close-sheet"><span class="ico">✕</span>關閉</button>`);
    return;
  }
  const next = cycleName(cycleCount(ev));
  openSheet(`<h3>${esc(ev.title)}</h3>
    <button class="menu-item" data-action="copy-text"><span class="ico">💬</span>複製賽程文字（貼到 LINE 群組）</button>
    ${cloudEnabled()
      ? `<button class="menu-item" data-action="share-view"><span class="ico">👀</span><span>分享「觀看」連結<br><span class="sub">貼到群組，大家即時看比分</span></span></button>
    <button class="menu-item" data-action="share-edit"><span class="ico">✏️</span><span>分享「記分」連結<br><span class="sub">只給幫忙記分的人：拿到的人可以改比分</span></span></button>`
      : `<button class="menu-item" data-action="share-link"><span class="ico">🔗</span>分享唯讀連結</button>`}
    <button class="menu-item" data-action="new-cycle"><span class="ico">🔁</span><span>再來${next}<br><span class="sub">同一組人，成績累計</span></span></button>
    <button class="menu-item" data-action="edit-players"><span class="ico">👥</span>有人加入／離開 → 重排剩下的賽程</button>
    <button class="menu-item" data-action="reshuffle"><span class="ico">🔀</span>重新洗牌（還沒打的場次）</button>
    ${theme}
    <button class="menu-item danger" data-action="delete-event"><span class="ico">🗑</span>${ev.cloud && !ev.cloud.owner ? "從這支手機移除" : "刪除這個球局"}</button>
    <button class="menu-item" data-action="close-sheet"><span class="ico">✕</span>關閉</button>`);
}

function playersSheet() {
  const list = state.players;
  const playing = list.filter((p) => !p.left);
  const left = list.filter((p) => p.left);
  openSheet(`<h3>調整球員</h3>
    <p class="sheet-note">按 × 是「離開」，按 ↺ 是「回來」。已經開打的場次會保留，還沒打的依新名單重排（一樣排到每個人都搭檔過）。</p>
    <div class="chips" style="margin-bottom:12px">
      ${playing.map((p) => `<span class="chip"><span>${esc(p.name)}</span><button class="x" data-action="leave" data-id="${p.id}" aria-label="${esc(p.name)} 離開">×</button></span>`).join("")}
      ${left.map((p) => `<span class="chip off"><span>${esc(p.name)}</span><button class="x" data-action="rejoin" data-id="${p.id}" aria-label="${esc(p.name)} 回來">↺</button></span>`).join("")}
    </div>
    <form class="row" data-form="join" style="margin-bottom:12px">
      <input type="text" name="name" placeholder="新加入的人" autocomplete="off" />
      <button class="btn sm" type="submit">加入</button>
    </form>
    <button class="btn primary block" data-action="apply-players" style="margin-top:12px">重排剩下的賽程</button>
    <button class="btn block" data-action="close-sheet" style="margin-top:12px">取消</button>`);
}

// 「有人還沒到？」：選那個人，換成後面沒有他的比賽
function absentSheet(ev, r, mi) {
  const m = ev.rounds[r].matches[mi];
  const names = nameMap(ev);
  state.absentFor = { r, mi };
  openSheet(`<h3>誰還沒到、還沒準備好？</h3>
    <p class="sheet-note">選一個人，這面球場會改打後面一場沒有他的比賽，等他到了再上。</p>
    <div class="pick-grid">${playersOf(m).map((id) => `<button class="btn block" data-action="absent-pick" data-id="${esc(id)}">${esc(names[id] || "?")}</button>`).join("")}</div>
    <button class="btn block" data-action="absent-pick" data-id="" style="margin-top:12px">⏭ 整場延後（這 ${sizeOf(ev)} 人都晚一點打）</button>
    <button class="btn block" data-action="close-sheet" style="margin-top:12px">取消</button>`);
}

// 點比分數字：直接選分數
function scorePicker(ev, r, mi, s) {
  const m = ev.rounds[r].matches[mi];
  const val = s === "a" ? m.sa : m.sb;
  state.picking = { r, mi, s, ref: { ...m }, cy: ev.rounds[r].cycle || 0 };
  let grid = "";
  for (let i = 0; i <= Math.max(30, val); i++) grid += `<button class="num-btn${i === val ? " on" : ""}" data-action="set-score" data-v="${i}">${i}</button>`;
  openSheet(`<h3>${esc(teamWords(s === "a" ? m.a : m.b, nameMap(ev)))} 的分數</h3>
    <div class="num-grid">${grid}</div>
    <button class="btn block" data-action="close-sheet" style="margin-top:12px">取消</button>`);
}

// ---------- 重排 ----------
// 保留已開打的（打完、場上、有比分），其他依目前名單重排到這一輪每個人都搭檔過為止
async function reschedule(ev) {
  const keep = keepForReschedule(ev);
  const cy = keep.length ? keep[keep.length - 1].cycle || 0 : 0;
  const players = ev.players.filter((p) => !p.left).map((p) => ({ id: p.id, fromRound: p.fromRound || 0 }));
  const baseline = keep.filter((r) => (r.cycle || 0) < cy); // 這一輪開始前的比賽
  const all = await runCycle({ players, mode: ev.mode, courts: ev.courts, keep, baseline, seed: Date.now() });
  const rounds = withIds(all.map((r, i) => (i < keep.length ? r : { ...r, cycle: cy })));
  return copyScores(rounds, ev.rounds, keep.length); // 算的這段時間記的比分
}

// 以同一組人開始下一輪：還沒打的取消，接在後面排新的一輪，成績累計
async function startNextCycle(ev) {
  const flow = courtFlow(ev);
  const pendingKeys = new Set(flow.pending.map((p) => p.key));
  const keep = ev.rounds
    .map((r, ri) => ({ ...r, matches: r.matches.filter((m, mi) => !pendingKeys.has(`${ri}-${mi}`) || hasProgress(m)) }))
    .filter((r) => r.matches.length);
  const next = 1 + Math.max(0, ...keep.map((r) => r.cycle || 0));
  const players = ev.players.filter((p) => !p.left).map((p) => ({ id: p.id, fromRound: 0 }));
  const all = await runCycle({ players, mode: ev.mode, courts: ev.courts, keep, baseline: keep, seed: Date.now() });
  ev.rounds = copyScores(withIds(all.map((r, i) => (i < keep.length ? r : { ...r, cycle: next }))), ev.rounds, keep.length);
  return next;
}

// ---------- 分享 ----------
function scheduleText(ev) {
  const names = nameMap(ev);
  const lines = [`🏓 ${ev.title}｜${ev.mode === "singles" ? "單打" : "雙打"}・${ev.courts} 面球場`, ""];
  const nums = matchNumbers(ev);
  const multi = cycleCount(ev) > 1;
  let lastCycle = -1;
  ev.rounds.forEach((round, r) => {
    const cy = round.cycle || 0;
    if (multi && cy !== lastCycle) lines.push(`＝＝ ${cycleName(cy)} ＝＝`);
    lastCycle = cy;
    round.matches.forEach((m, mi) => {
      const score = isFinished(m) ? `  ${m.sa}:${m.sb}` : "";
      lines.push(`第${nums.map.get(`${r}-${mi}`).n}場${round.extra ? "（加場）" : ""} ${teamText(m.a, names)} vs ${teamText(m.b, names)}${score}`);
    });
    if (round.rest.length) lines.push(`　休：${round.rest.map((id) => names[id]).join("、")}`);
  });
  lines.push("");
  if (progress(ev).done) {
    lines.push("📊 目前排名");
    standings(ev.players, ev.rounds)
      .filter((t) => t.rank)
      .forEach((t) => lines.push(`${t.rank}. ${t.name}  ${t.w}勝${t.l}敗  ${t.pf - t.pa >= 0 ? "+" : ""}${t.pf - t.pa}`));
  }
  return lines.join("\n").trim();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

async function shareOrCopy(text, url, copiedMsg) {
  if (navigator.share) {
    try {
      await navigator.share({ text, url });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  (await copy(`${text}\n${url}`)) ? toast(copiedMsg) : toast("複製失敗");
}

function b64url(bytes) {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
async function encodeShare(ev) {
  const slim = {
    t: ev.title,
    d: ev.date,
    mo: ev.mode,
    c: ev.courts,
    p: ev.players.map((p) => [p.id, p.name]),
    r: ev.rounds.map((r) => [r.matches.map((m) => [m.court, m.a, m.b, m.sa, m.sb, isFinished(m) ? 1 : 0]), r.rest]),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(slim));
  if ("CompressionStream" in window) return "z" + b64url(await pipe(bytes, new CompressionStream("deflate-raw")));
  return "j" + b64url(bytes);
}
async function decodeShare(code) {
  let bytes = unb64url(code.slice(1));
  if (code[0] === "z") bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
  const s = JSON.parse(new TextDecoder().decode(bytes));
  return {
    id: "shared",
    title: s.t,
    date: s.d,
    mode: s.mo,
    courts: s.c,
    createdAt: Date.now(),
    players: s.p.map(([id, name]) => ({ id, name })),
    rounds: s.r.map(([ms, rest]) => ({
      matches: ms.map(([court, a, b, sa, sb, done]) => ({ court, a, b, sa, sb, done: !!done })),
      rest,
    })),
  };
}

// ---------- 動作 ----------
function newDraft() {
  return { text: "", title: defaultTitle(null), players: [], mode: "doubles", courts: 1, seed: Math.floor(Math.random() * 1e9) };
}

function applyParse(text) {
  const d = state.draft;
  d.text = text;
  const r = parseRoster(text);
  // 保留使用者手動改過的狀態
  const prev = Object.fromEntries(d.players.map((p) => [p.srcName, p]));
  const manual = d.players.filter((p) => p.manual);
  d.players = r.players.map((p) => {
    const old = prev[p.name];
    return old ? { ...old, arrive: p.arrive, notes: p.notes } : { ...p, id: uid(), srcName: p.name };
  });
  for (const m of manual) if (!d.players.some((p) => p.name === m.name)) d.players.push(m);
  d.time = r.time;
  if (!d.titleTouched) d.title = defaultTitle(r.date);
}

function refreshParsed() {
  const d = state.draft;
  const card = $("#parsedCard");
  if (!card) return;
  card.hidden = !d.text && !d.players.length;
  $("#chips").innerHTML = chipsHtml(d.players);
  $("#countActive").textContent = d.players.filter((p) => p.active).length;
  $("#nextBtn").disabled = !d.players.some((p) => p.active);
}

// 貼上之後：收起鍵盤，捲到「抓到幾位球員」
function afterPaste() {
  $("#rosterText")?.blur();
  setTimeout(() => $("#parsedCard")?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" }), 80);
}

async function createEvent() {
  const d = state.draft;
  const info = draftInfo(d);
  const p = preview(d, info);
  if (!p) return;
  const rounds = p.rounds || (await busy("排賽程中…", () => p.promise));
  if (state.draft !== d) return;
  const players = info.active.map((x) => ({
    id: x.id,
    name: x.name,
    arrive: x.arrive || null,
    fromRound: info.players.find((y) => y.id === x.id)?.fromRound || 0,
  }));
  const now = new Date();
  const ev = {
    id: uid(),
    title: d.title.trim() || defaultTitle(null),
    date: `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`,
    createdAt: Date.now(),
    mode: d.mode,
    courts: d.courts,
    players,
    rounds: withIds(JSON.parse(JSON.stringify(rounds)).map((r) => ({ ...r, cycle: 0 }))),
  };
  state.events.push(ev);
  state.draft = null;
  nav("event", { eventId: ev.id, tab: "live" }, true);
  saveEvents();
  if (cloudEnabled()) uploadEvent(ev).catch((e) => console.warn("upload later", e)); // 失敗沒關係，分享時會再上傳
}

// 上傳到雲端（建立的人 = owner，之後可以把雲端的也刪掉）
async function uploadEvent(ev) {
  const cloud = await createCloud(ev);
  ev.cloud = { ...cloud, owner: true };
  saveEvents();
  if (state.view === "event" && state.eventId === ev.id) {
    ensureWatch(ev);
    if (!state.animating && $("#sheet").hidden) renderEvent();
  }
  return ev.cloud;
}

async function undoFinish(evId, ref) {
  const ev = state.events.find((e) => e.id === evId);
  if (!ev) return;
  const at = locateMatch(ev.rounds, ref.m, ref.r, ref.mi, ref.cy);
  if (!at) return;
  const m = ev.rounds[at[0]].matches[at[1]];
  m.done = false;
  delete m.doneAt;
  saveEvents();
  pushMatch(ev, at[0], at[1]);
  if (state.view === "event" && state.eventId === evId) {
    if (state.tab === "live") await advanceWithFlight(null);
    else renderEvent();
  }
  toast("已復原，這場繼續打");
}

function scrollToTabTop() {
  window.scrollTo(0, 0);
  if (state.tab === "rounds") {
    const cur = $(".round.current");
    if (cur) cur.scrollIntoView({ block: "start" });
  }
}

async function onAction(el) {
  const a = el.dataset.action;
  const ev = current();
  const d = state.draft;
  let r = el.dataset.r != null ? Number(el.dataset.r) : null;
  let mi = el.dataset.m != null ? Number(el.dataset.m) : null;
  switch (a) {
    case "home":
      closeSheet();
      goBack();
      break;
    case "new":
      nav("paste", { draft: newDraft() });
      break;
    case "clear-text":
      state.draft = newDraft();
      renderPaste();
      break;
    case "paste-clip": {
      let text = "";
      try {
        text = await navigator.clipboard.readText();
      } catch {}
      if (!text.trim()) {
        toast("讀不到剛剛複製的內容，請長按下面的框框，選「貼上」");
        $("#rosterText")?.focus();
        break;
      }
      applyParse(text);
      renderPaste();
      afterPaste();
      break;
    }
    case "toggle-player": {
      const p = d.players.find((x) => x.id === el.dataset.id);
      p.active = !p.active;
      refreshParsed();
      break;
    }
    case "rename": {
      state.renaming = el.dataset.id;
      refreshParsed();
      const input = $(`[data-rename="${el.dataset.id}"]`);
      input?.focus();
      input?.select();
      break;
    }
    case "to-setup":
      d.courts = defaultCourts(d.players.filter((p) => p.active).length, d.mode);
      nav("setup");
      break;
    case "mode":
      d.mode = el.dataset.v;
      d.courts = defaultCourts(d.players.filter((p) => p.active).length, d.mode);
      renderSetup();
      break;
    case "step": {
      if (el.dataset.k === "courts") d.courts = Math.max(1, Math.min(8, d.courts + Number(el.dataset.d)));
      renderSetup();
      break;
    }
    case "create":
      await createEvent();
      break;
    case "open":
      nav("event", { eventId: el.dataset.id, tab: "live", shared: null });
      break;
    case "theme": {
      const name = nextTheme();
      closeSheet();
      if (state.view === "home") renderHome();
      toast(`畫面顏色：${name}`);
      break;
    }
    case "tab":
      state.tab = el.dataset.v;
      state.editing = state.early = state.fixing = null;
      history.replaceState(entry(), "", location.pathname);
      renderEvent();
      scrollToTabTop();
      break;
    case "jump":
      document.getElementById(`court-${el.dataset.k}`)?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
      break;
    case "score": {
      const m = ev.rounds[r]?.matches[mi];
      if (!m || !canScore(m, `${r}-${mi}`)) break;
      const k = el.dataset.s === "a" ? "sa" : "sb";
      const v = Math.max(0, Math.min(99, (m[k] || 0) + Number(el.dataset.d)));
      if (v === m[k]) break;
      m[k] = v;
      saveEvents();
      pushMatch(ev, r, mi);
      if (navigator.vibrate) navigator.vibrate(8);
      const y = window.scrollY;
      renderEvent();
      window.scrollTo(0, y);
      document.querySelector(`[data-action="pick-score"][data-r="${r}"][data-m="${mi}"][data-s="${el.dataset.s}"]`)?.animate(
        [{ transform: "scale(1.25)" }, { transform: "scale(1)" }],
        { duration: 220, easing: "ease-out" }
      );
      break;
    }
    case "pick-score":
      scorePicker(ev, r, mi, el.dataset.s);
      break;
    case "set-score": {
      const pk = state.picking;
      closeSheet();
      const at = pk && locateMatch(ev.rounds, pk.ref, pk.r, pk.mi, pk.cy);
      const m = at && ev.rounds[at[0]].matches[at[1]];
      if (!m || !canScore(m, `${at[0]}-${at[1]}`)) break;
      m[pk.s === "a" ? "sa" : "sb"] = Number(el.dataset.v);
      saveEvents();
      pushMatch(ev, at[0], at[1]);
      const y = window.scrollY;
      renderEvent();
      window.scrollTo(0, y);
      break;
    }
    case "absent":
      absentSheet(ev, r, mi);
      break;
    case "absent-pick": {
      const at = state.absentFor;
      closeSheet();
      if (!at) break;
      const who = el.dataset.id || null;
      const nm = nameMap(ev);
      const s = findSwap(ev, at.r, at.mi, who);
      if (!s) {
        const cy = ev.rounds[at.r].cycle || 0;
        const last = !courtFlow(ev).pending.some((p) => (ev.rounds[p.ri].cycle || 0) === cy);
        toast(
          last
            ? "這是這一輪最後一場，沒有可以換的場次"
            : who
              ? `後面的比賽都有 ${nm[who]}，或有人還在別的球場上，現在沒辦法換`
              : "後面的場次都有人還在其他球場上，暫時不能換，等其他球場打完再試",
          5000
        );
        break;
      }
      swapSlots(ev.rounds, at.r, at.mi, s.rj, s.mj);
      saveEvents();
      pushAll(ev);
      // 換上來的那場：名字從「下一場」飛上來；延後的這場回到「下一場」清單
      await advanceWithFlight(null, { force: [s.k], sourceKey: { [s.k]: s.oldKeyB } });
      toast(
        who
          ? `已換場：${nm[who]} 先休息，等他到了再上`
          : s.again.length
            ? `已換場。${s.again.map((id) => nm[id]).join("、")} 這場也有，還是要接著打`
            : "已換場，原本那場延後打",
        5000
      );
      break;
    }
    case "pull": {
      const k = Number(el.dataset.k);
      const p = findPull(ev, k);
      if (!p) {
        toast("場邊的人現在湊不出一場，等其他球場打完");
        renderEvent();
        break;
      }
      swapSlots(ev.rounds, p.to.ri, p.to.mi, p.from.ri, p.from.mi);
      saveEvents();
      pushAll(ev);
      await advanceWithFlight(null, { force: [k] });
      break;
    }
    case "extra": {
      const k = Number(el.dataset.k);
      const plan = planExtra(ev, k, ev.cloud ? serverNow() : Date.now());
      if (!plan) {
        toast("場邊的人現在湊不出一場，等其他球場打完");
        renderEvent();
        break;
      }
      ev.rounds.splice(plan.insertAt, 0, plan.round);
      saveEvents();
      pushAll(ev);
      await advanceWithFlight(null, { force: [k] });
      toast(`${k + 1} 號球場加打一場，打完再接著排好的比賽`);
      break;
    }
    case "finish": {
      const cy = ev.rounds[r].cycle || 0;
      let m = ev.rounds[r].matches[mi];
      if (m.sa === m.sb) {
        if (!(await ask(m.sa === 0 ? "還沒記分，確定這場打完了嗎？" : `比分 ${m.sa}:${m.sb} 平手，確定這場打完了嗎？`, { ok: "確定打完了", cancel: "還沒，繼續打" }))) return;
      } else if (Math.max(m.sa, m.sb) < 11) {
        if (!(await ask(`比分 ${m.sa}:${m.sb}，兩隊都還沒到 11 分。<br>確定這場打完了嗎？`, { ok: "確定打完了", cancel: "還沒，繼續打" }))) return;
      }
      // 等確認的時候，別支手機的資料可能同步進來了：照比賽編號重新找這場
      const at = locateMatch(ev.rounds, m, r, mi, cy);
      if (!at) return;
      [r, mi] = at;
      m = ev.rounds[r].matches[mi];
      if (isFinished(m)) return; // 別支手機已經按了打完
      m.done = true;
      if (m.doneAt == null) m.doneAt = ev.cloud ? serverNow() : Date.now(); // 打完的時間：用來推算每面球場接下來打哪場
      saveEvents();
      pushMatch(ev, r, mi);
      const num = matchNumbers(ev).map.get(`${r}-${mi}`)?.n;
      const ref = { m: { ...m }, r, mi, cy: ev.rounds[r].cycle || 0 };
      const undo = { label: "復原", fn: () => undoFinish(ev.id, ref) };
      if (state.tab === "live") await advanceWithFlight(document.querySelector(`.courts > .card[data-key="${r}-${mi}"]`)); // 下一場的名字飛上來遞補
      else {
        state.justDone = `${r}-${mi}`; // 這場蓋上「已完成」章
        renderEvent();
      }
      toast(`第 ${num} 場已記錄：${resultText(m, nameMap(ev))}`, 8000, undo);
      break;
    }
    case "fix-score":
      state.fixing = `${r}-${mi}`;
      renderEvent();
      break;
    case "fix-done": {
      const m = ev.rounds[r]?.matches[mi];
      if (m && !m.done && m.doneAt != null) {
        m.done = true; // 舊版「改比分」留下的狀態
        saveEvents();
        pushMatch(ev, r, mi);
      }
      state.fixing = null;
      renderEvent();
      toast("比分已更新");
      break;
    }
    case "expand":
      state.editing = `${r}-${mi}`;
      state.early = state.fixing = null;
      renderEvent();
      break;
    case "early":
      state.early = `${r}-${mi}`;
      renderEvent();
      break;
    case "collapse":
      state.editing = state.early = state.fixing = null;
      renderEvent();
      break;
    case "menu":
      eventMenu();
      break;
    case "close-sheet":
      closeSheet();
      break;
    case "copy-text":
      closeSheet();
      (await copy(scheduleText(ev))) ? toast("已複製，到 LINE 群組貼上即可") : toast("複製失敗");
      break;
    case "copy-view-link": {
      if (!ev?.cloud) break;
      (await copy(shareUrl(ev.cloud, false))) ? toast("觀看連結已複製，貼到 LINE 群組，大家就能看比分") : toast("複製失敗");
      break;
    }
    case "share-link": {
      closeSheet();
      const url = `${location.origin}${location.pathname}#s=${await encodeShare(ev)}`;
      await shareOrCopy(`${ev.title} 賽程`, url, "連結已複製（比分是此刻的快照）");
      break;
    }
    case "share-edit":
    case "share-view": {
      closeSheet();
      if (!ev.cloud) {
        toast("上傳中…");
        try {
          await uploadEvent(ev);
        } catch (e) {
          console.warn(e);
          return toast("上傳失敗，請確認網路後再試");
        }
      }
      const editable = a === "share-edit";
      if (editable && !ev.cloud.key) return toast("你只有觀看權限，不能分享記分連結");
      await shareOrCopy(
        editable ? `🏓 ${ev.title}｜記分連結（點開可以一起改比分）` : `🏓 ${ev.title}｜即時比分`,
        shareUrl(ev.cloud, editable),
        editable ? "記分連結已複製，只貼給幫忙記分的人" : "觀看連結已複製，貼到 LINE 群組"
      );
      renderEvent();
      break;
    }
    case "import-shared": {
      closeSheet();
      const copyEv = { ...state.shared, id: uid(), createdAt: Date.now(), players: state.shared.players.map((p) => ({ ...p, fromRound: 0 })) };
      state.events.push(copyEv);
      state.shared = null;
      nav("event", { eventId: copyEv.id, tab: "live" }, true);
      saveEvents();
      toast("已存到這支手機");
      break;
    }
    case "new-cycle": {
      closeSheet();
      if (ev.players.filter((p) => !p.left).length < sizeOf(ev)) return toast("人數不夠排賽程");
      const left = courtFlow(ev).pending.length;
      const nextName = cycleName(cycleCount(ev));
      const curName = cycleName(cycleCount(ev) - 1);
      if (left && !(await ask(`${curName}還有 ${left} 場沒打，要直接開始${nextName}嗎？<br>沒打的場次會取消（正在打的會繼續）。`, { ok: `開始${nextName}` }))) return;
      await busy(`排${nextName}中…`, () => startNextCycle(ev));
      saveEvents();
      pushAll(ev);
      state.tab = "live";
      history.replaceState(entry(), "", location.pathname);
      renderEvent();
      window.scrollTo(0, 0);
      showBanner(`${BALL}<b>${nextName}開始！</b><span>成績會累計</span>`);
      break;
    }
    case "edit-players":
      state.players = JSON.parse(JSON.stringify(ev.players));
      playersSheet();
      break;
    case "leave":
    case "rejoin": {
      const p = state.players?.find((x) => x.id === el.dataset.id);
      if (!p) break;
      p.left = a === "leave";
      playersSheet();
      break;
    }
    case "apply-players": {
      const list = state.players;
      if (!list) break;
      if (list.filter((p) => !p.left).length < sizeOf(ev)) return toast("人數不夠排賽程");
      ev.players = list.map(({ isNew, ...p }) => p);
      closeSheet();
      ev.rounds = await busy("重排賽程中…", () => reschedule(ev));
      saveEvents();
      pushAll(ev);
      toast("已重排剩下的賽程");
      renderEvent();
      break;
    }
    case "reshuffle": {
      closeSheet();
      const n = pendingCount(ev);
      if (n <= 0) return toast("沒有還沒打的場次");
      if (!(await ask(`還沒打的 ${n} 場會重新排過。<br>已經貼到 LINE 的賽程會跟著不一樣，確定嗎？`, { ok: "重新洗牌" }))) return;
      ev.rounds = await busy("重新洗牌中…", () => reschedule(ev));
      saveEvents();
      pushAll(ev);
      toast("已重新洗牌");
      renderEvent();
      break;
    }
    case "delete-event": {
      closeSheet();
      const owner = !!ev.cloud?.owner;
      const msg = !ev.cloud
        ? `刪除「${esc(ev.title)}」？<br>刪除後無法復原。`
        : owner
          ? `刪除「${esc(ev.title)}」？<br>用連結打開的人也會看不到，刪除後無法復原。`
          : `從這支手機移除「${esc(ev.title)}」？<br>其他人的連結還是可以用。`;
      if (!(await ask(msg, { ok: ev.cloud && !owner ? "移除" : "刪除", danger: true }))) return;
      if (ev.cloud) stopWatch();
      if (owner) deleteCloud(ev.cloud).catch(() => toast("網路不通，雲端上的資料沒有刪掉；這支手機上已經移除"));
      state.events = state.events.filter((e) => e.id !== ev.id);
      saveEvents();
      nav("home", { eventId: null }, true);
      break;
    }
  }
}

document.addEventListener("click", (e) => {
  if (state.busy) return;
  const sheet = $("#sheet");
  if (e.target === sheet) return closeSheet(); // 點遮罩關閉（調整球員：沒套用的變更不算）
  const ans = e.target.closest("[data-ask]");
  if (ans) {
    const r = askResolve;
    askResolve = null;
    closeSheet();
    r?.(ans.dataset.ask === "1");
    return;
  }
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  onAction(el);
});

document.addEventListener("input", (e) => {
  const d = state.draft;
  if (!d) return;
  if (e.target.id === "rosterText") {
    applyParse(e.target.value);
    refreshParsed();
    if (e.inputType === "insertFromPaste") afterPaste();
  } else if (e.target.id === "titleInput") {
    d.title = e.target.value;
    d.titleTouched = true;
  }
});

// 名字原地編輯：Enter 或點別處 = 確定，Esc = 取消
function finishRename(input, save) {
  const id = input.dataset.rename;
  if (state.renaming !== id) return; // 已處理過（重繪時的 blur）
  state.renaming = null;
  const d = state.draft;
  const p = d?.players.find((x) => x.id === id);
  const name = input.value.trim();
  if (save && p && name && name !== p.name) {
    if (d.players.some((x) => x.id !== id && x.name === name)) toast("名單裡已經有這個名字");
    else {
      p.name = name;
      delete p.dup;
    }
  }
  refreshParsed();
}
document.addEventListener("keydown", (e) => {
  const input = e.target.closest?.("[data-rename]");
  if (!input) return;
  if (e.key === "Enter") {
    e.preventDefault();
    finishRename(input, true);
  } else if (e.key === "Escape") {
    finishRename(input, false);
  }
});
document.addEventListener("focusout", (e) => {
  const input = e.target.closest?.("[data-rename]");
  if (input) finishRename(input, true);
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  if (!name) return;
  if (form.dataset.form === "add-player") {
    const d = state.draft;
    if (d.players.some((p) => p.name === name)) return toast("名單裡已經有這個名字");
    d.players.push({ id: uid(), name, srcName: name, active: true, manual: true, notes: [], waitlist: false });
    form.name.value = "";
    refreshParsed();
  } else if (form.dataset.form === "join") {
    const list = state.players;
    if (!list) return;
    const existing = list.find((p) => p.name === name);
    if (existing) existing.left = false;
    else list.push({ id: uid(), name, fromRound: 0, isNew: true });
    playersSheet();
  }
});

// ---------- 螢幕常亮（記分時不要自動鎖屏） ----------
let wakeLock = null;
async function updateWakeLock() {
  const want = state.view === "event" && !readonly() && document.visibilityState === "visible";
  try {
    if (want && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* 不支援就算了 */
  }
}
document.addEventListener("visibilitychange", updateWakeLock);

// 分頁列黏在頂列下面：頂列高度會因為 iPhone 瀏海而不同，用量的
function trackTopbar() {
  const bar = $(".topbar");
  const set = () => document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
  set();
  if ("ResizeObserver" in window) new ResizeObserver(set).observe(bar);
  else window.addEventListener("resize", set);
}

// ---------- 啟動 ----------
async function boot() {
  applyTheme();
  trackTopbar();
  $(".topbar .logo").innerHTML = BALL;
  const link = parseShareHash(location.hash);
  if (link) {
    history.replaceState(null, "", location.pathname);
    if (!cloudEnabled()) toast("這個版本沒有開啟雲端同步");
    else await openCloudLink(link);
  }
  const m = location.hash.match(/^#s=(.+)$/);
  if (m) {
    try {
      state.shared = await decodeShare(m[1]);
      state.view = "event";
      state.tab = "live";
    } catch {
      toast("分享連結壞掉了");
    }
  }
  if (state.view === "home") {
    // 今天還沒打完的球局：直接回到那一局（不小心關掉、重新整理也不怕）
    const ev = resumable(12 * 3600e3);
    if (ev) Object.assign(state, { view: "event", eventId: ev.id, tab: "live" });
    else Object.assign(state, { view: "paste", draft: newDraft() });
  }
  // 返回鍵：最底下一層是首頁（球局列表），再往前才離開 app
  const first = state.view;
  depth = 0;
  history.replaceState({ view: "home", depth: 0 }, "", location.pathname);
  if (first !== "home") {
    depth = 1;
    history.pushState(entry(), "", location.pathname);
  }
  render();
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
async function openCloudLink(link) {
  app.innerHTML = `<div class="card empty"><div class="bounce">${BALL}</div><p>載入球局中…</p></div>`;
  try {
    let ev = state.events.find((e) => e.cloud?.id === link.id);
    if (!ev) {
      if (link.key) await joinCloud(link);
      const data = await fetchCloud(link.id);
      if (!data) throw new Error("not found");
      ev = { ...data, id: uid(), cloud: { id: link.id, key: link.key }, touchedAt: Date.now() };
      state.events.push(ev);
      saveEvents();
      toast(link.key ? "已加入，可以一起記分" : "觀看模式，比分會即時更新");
    } else if (link.key && !ev.cloud.key) {
      await joinCloud(link); // 原本只能看，現在拿到記分連結
      ev.cloud.key = link.key;
      saveEvents();
      toast("已升級成可以記分");
    }
    Object.assign(state, { eventId: ev.id, view: "event", tab: "live" });
  } catch (e) {
    console.warn(e);
    toast(navigator.onLine ? "找不到這個球局，或連結有誤" : "目前離線，連上網路後再打開連結");
  }
}

window.addEventListener("hashchange", () => location.reload());
boot();
