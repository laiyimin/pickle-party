// 賽程操作（不碰畫面，可以單獨測試）：
// 重排時要保留哪些比賽、換場、空著的球場先上、雲端比分合併、連打場數
import { courtFlow, isFinished } from "./flow.js";

export const playersOf = (m) => [...m.a, ...m.b];
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);
const teamKey = (t) => [...arr(t)].sort().join("+");
const pairKey = (m) => [teamKey(m.a), teamKey(m.b)].sort().join("|");
const clone = (x) => JSON.parse(JSON.stringify(x));

// 同一場比賽：有編號就比編號；舊資料沒有編號，比兩隊的人
export function sameMatch(x, y) {
  if (!x || !y) return false;
  if (x.id && y.id) return x.id === y.id;
  return pairKey(x) === pairKey(y);
}

// 這場有沒有開始（打完、或已經記了分）
export const hasProgress = (m) => isFinished(m) || !!m.sa || !!m.sb;

// 每場比賽一個固定編號：兩支手機記分時用它找比賽，不會因為重排、對調後位置改變而寫錯場
let seq = 0;
export const newMatchId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${(seq++).toString(36)}`;
export function withIds(rounds) {
  for (const r of rounds) for (const m of r.matches) if (!m.id) m.id = newMatchId();
  return rounds;
}

// ---------- 重排 ----------
// 要保留的：已經打完、正在場上、或已經記了分的比賽。
// 同一批裡其他還沒打的比賽要拿出來重排（例如 2 面球場時，一面先打完、把下一批的比賽先拉上場，
// 同一批另一場還沒打——那場如果有人離開，不能留著）
export function keepForReschedule(ev) {
  const flow = courtFlow(ev);
  const onCourt = new Set(flow.courts.filter(Boolean).map((x) => x.key));
  const started = (m, ri, mi) => hasProgress(m) || onCourt.has(`${ri}-${mi}`);
  let last = -1;
  ev.rounds.forEach((r, ri) => r.matches.forEach((m, mi) => started(m, ri, mi) && (last = ri)));
  return ev.rounds
    .slice(0, last + 1)
    .map((r, ri) => {
      const kept = r.matches.filter((m, mi) => started(m, ri, mi));
      if (kept.length === r.matches.length) return r;
      const playing = new Set(kept.flatMap(playersOf));
      const dropped = r.matches.filter((m) => !kept.includes(m)).flatMap(playersOf);
      return { ...r, matches: kept, rest: [...new Set([...(r.rest || []), ...dropped])].filter((id) => !playing.has(id)) };
    })
    .filter((r) => r.matches.length);
}

// 還沒打、會被重排的場數
export function pendingCount(ev) {
  const kept = keepForReschedule(ev).reduce((n, r) => n + r.matches.length, 0);
  return ev.rounds.reduce((n, r) => n + r.matches.length, 0) - kept;
}

// ---------- 換場 ----------
// 兩場比賽交換順序（場地編號留在原位）；在不同批時，兩批的休息名單也跟著換
export function swapSlots(rounds, ri, mi, rj, mj) {
  const A = rounds[ri].matches[mi];
  const B = rounds[rj].matches[mj];
  rounds[ri].matches[mi] = { ...B, court: A.court };
  rounds[rj].matches[mj] = { ...A, court: B.court };
  if (ri !== rj) {
    const pa = playersOf(A);
    const pb = playersOf(B);
    const fix = (round, out, inn) => (round.rest = [...new Set([...(round.rest || []), ...out])].filter((id) => !inn.includes(id)));
    fix(rounds[ri], pa, pb);
    fix(rounds[rj], pb, pa);
  }
}

const courtKeys = (flow) => flow.courts.map((x) => (x ? x.key : ""));
// 晚到的人：換場時不能把他提前到預定開始的那一批之前（他可能還沒到）
const tooEarly = (ev, m, ri) => (ev.players || []).some((p) => (p.fromRound || 0) > ri && playersOf(m).includes(p.id));
const busyPlayers = (ev, flow) => new Set(flow.courts.filter(Boolean).flatMap((x) => playersOf(ev.rounds[x.ri].matches[x.mi])));
const cycleOf = (ev, ri) => ev.rounds[ri].cycle || 0;

/**
 * 場上這場（還沒開始記分）換成後面的一場：
 * - exclude 沒給：整場延後，換成同一輪的下一場（兩場都有的人還是要接著打）
 * - exclude 給了某人：他還沒到／還沒準備好 → 換成最早一場「沒有他」的比賽
 * 換完之後，這面球場要真的變成打那一場、其他球場不受影響（各手機推算結果才會一致）
 */
export function findSwap(ev, ri, mi, exclude = null) {
  const flow = courtFlow(ev);
  const k = flow.courts.findIndex((x) => x && x.ri === ri && x.mi === mi);
  if (k < 0) return null;
  const A = ev.rounds[ri].matches[mi];
  const mine = new Set(playersOf(A));
  const busy = busyPlayers(ev, flow);
  const now = courtKeys(flow);
  for (const p of flow.pending) {
    if (cycleOf(ev, p.ri) !== cycleOf(ev, ri)) continue; // 不跨到下一輪
    const B = ev.rounds[p.ri].matches[p.mi];
    if (exclude && playersOf(B).includes(exclude)) continue;
    if (playersOf(B).some((id) => busy.has(id) && !mine.has(id))) continue; // 有人還在別的球場上
    if (tooEarly(ev, B, ri)) continue;
    const trial = clone(ev.rounds);
    swapSlots(trial, ri, mi, p.ri, p.mi);
    const after = courtKeys(courtFlow({ rounds: trial }));
    if (after.every((key, j) => key === now[j])) return { k, rj: p.ri, mj: p.mi, oldKeyB: p.key, again: playersOf(B).filter((id) => mine.has(id)) };
  }
  return null;
}

/**
 * 第 k 面球場空著在等人，但場邊有人可以先打：
 * 找同一輪裡最早一場「人都有空」的比賽，和前面某一場對調，讓它馬上上這面球場；其他球場不受影響
 */
export function findPull(ev, k) {
  const flow = courtFlow(ev);
  if (flow.courts[k] || !flow.pending.length) return null;
  const busy = busyPlayers(ev, flow);
  const now = courtKeys(flow);
  const cy = cycleOf(ev, flow.pending[0].ri);
  for (let qi = 0; qi < Math.min(flow.pending.length, 12); qi++) {
    const q = flow.pending[qi];
    if (cycleOf(ev, q.ri) !== cy) break;
    if (playersOf(ev.rounds[q.ri].matches[q.mi]).some((id) => busy.has(id))) continue;
    for (let ti = 0; ti < qi; ti++) {
      const t = flow.pending[ti];
      if (tooEarly(ev, ev.rounds[q.ri].matches[q.mi], t.ri)) continue;
      const trial = clone(ev.rounds);
      swapSlots(trial, t.ri, t.mi, q.ri, q.mi);
      const after = courtKeys(courtFlow({ rounds: trial }));
      if (after.every((key, j) => (j === k ? key === t.key : key === now[j]))) return { k, from: q, to: t };
    }
  }
  return null;
}

/**
 * 第 k 面球場空著，賽程裡也找不到人都有空的比賽：用場邊的人加打一場。
 * 挑人：這一輪打得最少的優先；一樣多時，挑接下來最晚才要上場的（不耽誤下一場）；晚到還沒輪到的不挑。
 * 分隊：盡量不要和這一輪已經搭過的人同隊。
 * 回傳要插入的那一批（放在這一輪最後面，不影響其他比賽的編號）
 */
export function planExtra(ev, k, now) {
  const flow = courtFlow(ev);
  if (flow.courts[k]) return null;
  const size = ev.mode === "singles" ? 2 : 4;
  const busy = busyPlayers(ev, flow);
  const at = flow.pending[0] || flow.courts.find(Boolean);
  const cy = at ? cycleOf(ev, at.ri) : Math.max(0, ...ev.rounds.map((r) => r.cycle || 0));
  const batch = flow.pending[0]?.ri ?? ev.rounds.length;
  const free = (ev.players || []).filter((p) => !p.left && !busy.has(p.id) && (p.fromRound || 0) <= batch).map((p) => p.id);
  if (free.length < size) return null;
  const games = {};
  const partner = {};
  ev.rounds.forEach((r, ri) => {
    if (cycleOf(ev, ri) !== cy) return;
    r.matches.forEach((m, mi) => {
      if (!isFinished(m) && !flow.courts.some((x) => x && x.key === `${ri}-${mi}`)) return;
      for (const id of playersOf(m)) games[id] = (games[id] || 0) + 1;
      for (const t of [m.a, m.b]) if (t.length === 2) partner[[...t].sort().join("|")] = 1;
    });
  });
  const nextUse = (id) => {
    const i = flow.pending.findIndex((q) => playersOf(ev.rounds[q.ri].matches[q.mi]).includes(id));
    return i < 0 ? Infinity : i;
  };
  const pick = free.sort((x, y) => (games[x] || 0) - (games[y] || 0) || nextUse(y) - nextUse(x)).slice(0, size);
  let a = pick.slice(0, size / 2);
  let b = pick.slice(size / 2);
  if (size === 4) {
    const [p, q, r, s] = pick;
    const splits = [[[p, q], [r, s]], [[p, r], [q, s]], [[p, s], [q, r]]];
    const cost = ([x, y]) => (partner[[...x].sort().join("|")] || 0) + (partner[[...y].sort().join("|")] || 0);
    [a, b] = splits.reduce((best, sp) => (cost(sp) < cost(best) ? sp : best));
  }
  const match = { id: newMatchId(), court: k + 1, a, b, sa: 0, sb: 0, done: false, addedAt: now };
  let insertAt = 0;
  ev.rounds.forEach((r, ri) => cycleOf(ev, ri) <= cy && (insertAt = ri + 1));
  const round = { matches: [match], rest: [], absent: [], cycle: cy, extra: true };
  // 試算：這面球場要真的打這場，其他球場不受影響
  const trial = clone(ev.rounds);
  trial.splice(insertAt, 0, clone(round));
  const tf = courtFlow({ rounds: trial });
  const ok = tf.courts.every((x, j) => {
    const m = x && trial[x.ri].matches[x.mi];
    if (j === k) return m?.id === match.id;
    const was = flow.courts[j];
    return was ? sameMatch(m, ev.rounds[was.ri].matches[was.mi]) : !m;
  });
  return ok ? { round, insertAt } : null;
}

// ---------- 雲端合併 ----------
// 要整份寫回雲端（重排、對調、下一輪）之前：雲端上同一場比賽已經有比分、本機卻還沒有的
// （別支手機剛記的），先抄過來，才不會被蓋掉
export function mergeRemoteScores(localRounds, remoteRounds) {
  const out = clone(localRounds);
  const remote = (remoteRounds || []).flatMap((r) => (r.matches || []).map((m) => ({ m, cy: r.cycle || 0 })));
  for (const r of out)
    for (const m of r.matches) {
      if (hasProgress(m)) continue;
      // 沒有編號的舊資料只在同一輪裡比對
      const o = remote.find((x) => sameMatch(x.m, m) && ((m.id && x.m.id) || x.cy === (r.cycle || 0)) && hasProgress(x.m))?.m;
      if (!o) continue;
      m.sa = o.sa || 0;
      m.sb = o.sb || 0;
      m.done = !!o.done;
      if (o.doneAt != null) m.doneAt = o.doneAt;
    }
  return out;
}

// 重排要花一點時間：算好之後，把這段時間內（自己或別支手機）記的比分抄回保留下來的比賽（前 upto 批）
export function copyScores(rounds, current, upto = rounds.length) {
  const src = current.flatMap((r) => r.matches.map((m) => ({ m, cy: r.cycle || 0 })));
  for (const r of rounds.slice(0, upto))
    for (const m of r.matches) {
      const o = src.find((x) => sameMatch(x.m, m) && (m.id || x.cy === (r.cycle || 0)))?.m;
      if (!o) continue;
      m.sa = o.sa || 0;
      m.sb = o.sb || 0;
      m.done = !!o.done;
      if (o.doneAt != null) m.doneAt = o.doneAt;
      else delete m.doneAt;
    }
  return rounds;
}

// 照位置找比賽；位置上已經不是同一場（重排過）就照編號找
// 舊資料沒有編號時，只在同一輪（cycle）裡找，才不會找到上一輪同樣兩隊的比賽
export function locateMatch(rounds, m, r, mi, cycle = null) {
  if (sameMatch(rounds[r]?.matches[mi], m)) return [r, mi];
  for (let i = 0; i < rounds.length; i++) {
    if (!m.id && cycle != null && (rounds[i].cycle || 0) !== cycle) continue;
    const j = rounds[i].matches.findIndex((x) => sameMatch(x, m));
    if (j >= 0) return [i, j];
  }
  return null;
}

// ---------- 其他 ----------
// 賽程裡任何人最多連續打幾批（多面球場時，同一批算一場）
export function maxPlayStreak(rounds) {
  const streak = {};
  let max = 0;
  for (const r of rounds) {
    const on = new Set(r.matches.flatMap(playersOf));
    for (const id of new Set([...Object.keys(streak), ...on])) {
      streak[id] = on.has(id) ? (streak[id] || 0) + 1 : 0;
      max = Math.max(max, streak[id]);
    }
  }
  return max;
}

// 第 k 面球場上一場打完的比賽
export function lastOnCourt(ev, flow, k) {
  let best = null;
  ev.rounds.forEach((r, ri) =>
    r.matches.forEach((m, mi) => {
      if (!isFinished(m) || flow.courtOf.get(`${ri}-${mi}`) !== k + 1) return;
      if (!best || (m.doneAt ?? 0) >= (best.m.doneAt ?? 0)) best = { ri, mi, m };
    })
  );
  return best;
}
