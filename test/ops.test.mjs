import { test } from "node:test";
import assert from "node:assert/strict";
import { courtFlow } from "../js/flow.js";
import { buildCycle, standings } from "../js/scheduler.js";
import {
  keepForReschedule, pendingCount, findSwap, findPull, planExtra, swapSlots, mergeRemoteScores, copyScores,
  locateMatch, maxPlayStreak, lastOnCourt, withIds, sameMatch,
} from "../js/ops.js";

const M = (a, b, extra = {}) => ({ a, b, sa: 0, sb: 0, done: false, ...extra });
const keys = (f) => f.courts.map((c) => c && c.key);
const finish = (m, t) => Object.assign(m, { done: true, doneAt: t, sa: 11, sb: 5 });
const playersIn = (rounds) => rounds.flatMap((r) => r.matches.flatMap((m) => [...m.a, ...m.b]));

test("重排：同一批裡還沒打的比賽要拿出來重排（有人離開時不會留著他）", () => {
  // 2 面球場：場地 1 先打完，下一批的第 1 場先上場；同一批的第 2 場還在等（E、G 在場地 2）
  const ev = {
    rounds: [
      { matches: [M(["A", "B"], ["C", "D"]), M(["E", "F"], ["G", "H"])], rest: ["I", "J"] },
      { matches: [M(["A", "C"], ["I", "J"]), M(["B", "D"], ["E", "G"])], rest: ["F", "H"] },
    ],
  };
  finish(ev.rounds[0].matches[0], 100);
  assert.deepEqual(keys(courtFlow(ev)), ["1-0", "0-1"]);
  const keep = keepForReschedule(ev);
  assert.equal(keep.length, 2);
  assert.equal(keep[1].matches.length, 1); // 只留場上那場
  assert.ok(!playersIn([{ matches: keep[1].matches }]).includes("B"));
  assert.ok(keep[1].rest.includes("B")); // 拿掉那場的人變成那一批的休息
  assert.equal(pendingCount(ev), 1);

  // B 離開 → 重排：B 不會再出現在還沒打的比賽裡
  const players = "ACDEFGHIJ".split("").map((id) => ({ id }));
  const all = buildCycle({ players, mode: "doubles", courts: 2, keep, seed: 3 });
  assert.ok(!playersIn(all.slice(keep.length)).includes("B"));
});

test("重排：整批都還沒打（被後面先上的比賽跳過）時，整批拿出來重排", () => {
  const ev = {
    rounds: [
      { matches: [M(["A", "B"], ["C", "D"]), M(["E", "F"], ["G", "H"])] },
      { matches: [M(["A", "E"], ["I", "J"])] }, // E 還在場地 2 → 等
      { matches: [M(["B", "C"], ["K", "L"])] }, // 人都有空 → 先上
    ],
  };
  finish(ev.rounds[0].matches[0], 100);
  assert.deepEqual(keys(courtFlow(ev)), ["2-0", "0-1"]);
  const keep = keepForReschedule(ev);
  assert.deepEqual(keep.map((r) => r.matches.length), [2, 1]);
  assert.deepEqual(keep[1].matches[0].a, ["B", "C"]);
});

test("有人還沒到：換成後面第一場沒有他的比賽", () => {
  const ev = {
    rounds: [
      { matches: [M(["A", "B"], ["C", "D"])] },
      { matches: [M(["A", "E"], ["B", "C"])] },
      { matches: [M(["B", "E"], ["C", "D"])] },
    ],
  };
  const s = findSwap(ev, 0, 0, "A");
  assert.equal(s.rj, 2); // 第 2 場也有 A → 跳過
  swapSlots(ev.rounds, 0, 0, s.rj, s.mj);
  assert.ok(![...ev.rounds[0].matches[0].a, ...ev.rounds[0].matches[0].b].includes("A"));
  // 整場延後：就是下一場
  const ev2 = { rounds: [{ matches: [M(["A", "B"], ["C", "D"])] }, { matches: [M(["A", "E"], ["B", "C"])] }] };
  assert.equal(findSwap(ev2, 0, 0).rj, 1);
  // 後面每一場都有他 → 換不了
  assert.equal(findSwap(ev2, 0, 0, "A"), null);
  // 晚到的人（第 3 批才到）不會被換到前面來
  const ev3 = {
    players: [{ id: "E", fromRound: 2 }],
    rounds: [{ matches: [M(["A", "B"], ["C", "D"])] }, { matches: [M(["A", "E"], ["B", "C"])] }, { matches: [M(["B", "E"], ["C", "D"])] }],
  };
  assert.equal(findSwap(ev3, 0, 0, "D"), null);
});

test("空著的球場：場邊有人可以打時，把那場提前上場，其他球場不受影響", () => {
  const ev = {
    rounds: [
      { matches: [M(["A", "B"], ["C", "D"]), M(["E", "F"], ["G", "H"])] },
      { matches: [M(["A", "E"], ["I", "J"]), M(["B", "F"], ["C", "G"])] },
      { matches: [M(["A", "E"], ["B", "F"])] },
      { matches: [M(["I", "J"], ["K", "L"])] }, // 場邊 4 人都有空，但排得比較後面
    ],
  };
  finish(ev.rounds[0].matches[0], 100);
  assert.deepEqual(keys(courtFlow(ev)), [null, "0-1"]); // 場地 1 在等
  const p = findPull(ev, 0);
  assert.ok(p);
  assert.equal(p.from.key, "3-0");
  swapSlots(ev.rounds, p.to.ri, p.to.mi, p.from.ri, p.from.mi);
  const f = courtFlow(ev);
  assert.equal(keys(f)[1], "0-1"); // 場地 2 不變
  const on = ev.rounds[f.courts[0].ri].matches[f.courts[0].mi];
  assert.deepEqual([...on.a, ...on.b].sort(), ["I", "J", "K", "L"]);
  // 沒有人可以先打時：沒有建議
  const ev2 = { rounds: [{ matches: [M(["A", "B"], ["C", "D"]), M(["E", "F"], ["G", "H"])] }, { matches: [M(["A", "E"], ["B", "F"])] }] };
  finish(ev2.rounds[0].matches[0], 100);
  assert.equal(findPull(ev2, 0), null);
});

test("加打一場：賽程裡找不到人都有空的比賽時，用場邊的人加一場", () => {
  const players = "ABCDEFGHIJ".split("").map((id) => ({ id }));
  const ev = {
    mode: "doubles",
    players,
    rounds: [
      { matches: [M(["A", "B"], ["C", "D"], { id: "m1" }), M(["E", "F"], ["G", "H"], { id: "m2" })], rest: ["I", "J"] },
      { matches: [M(["A", "E"], ["I", "J"], { id: "m3" }), M(["B", "F"], ["C", "G"], { id: "m4" })], rest: ["D", "H"] },
    ],
  };
  finish(ev.rounds[0].matches[1], 100); // 2 號球場先打完；下一批每場都有人還在 1 號球場
  assert.deepEqual(keys(courtFlow(ev)), ["0-0", null]);
  assert.equal(findPull(ev, 1), null);
  const plan = findPull(ev, 1) || planExtra(ev, 1, 200);
  assert.ok(plan);
  const m = plan.round.matches[0];
  const who = [...m.a, ...m.b].sort();
  assert.ok(who.includes("I") && who.includes("J")); // 這一輪還沒打的人優先
  assert.ok(!who.includes("E")); // 下一場就要上的人不挑
  ev.rounds.splice(plan.insertAt, 0, plan.round);
  const f = courtFlow(ev);
  assert.equal(keys(f)[0], "0-0"); // 1 號球場不受影響
  assert.equal(ev.rounds[f.courts[1].ri].matches[f.courts[1].mi].id, m.id);
  // 加場打完後，2 號球場接著排好的比賽；1 號球場打完也照常
  finish(m, 300);
  finish(ev.rounds[0].matches[0], 310);
  const f2 = courtFlow(ev);
  assert.deepEqual(f2.courts.map((x) => x && ev.rounds[x.ri].matches[x.mi].id).sort(), ["m3", "m4"]);
});

test("加場的時間點之前，推算時當作不存在", () => {
  const ev = {
    rounds: [
      { matches: [M(["A", "B"], ["C", "D"]), M(["E", "F"], ["G", "H"])] },
      { matches: [M(["A", "E"], ["I", "J"])] },
      { matches: [M(["K", "L"], ["M", "N"], { addedAt: 500 })], extra: true },
    ],
  };
  finish(ev.rounds[0].matches[1], 100);
  // 時間 100 時加場還不存在 → 2 號球場在等；推算到 500 才放上去
  const f = courtFlow(ev);
  assert.deepEqual(keys(f), ["0-0", "2-0"]);
  ev.rounds[2].matches[0].addedAt = 50; // 加場比 2 號球場打完還早：等球場空了才上
  assert.deepEqual(keys(courtFlow(ev)), ["0-0", "2-0"]);
});

test("雲端合併：別支手機剛記的比分不會被整份寫回蓋掉", () => {
  const local = [{ cycle: 0, matches: [M(["A"], ["B"], { id: "x" }), M(["C"], ["D"], { id: "y", sa: 4 })] }];
  const remote = [{ cycle: 0, matches: [M(["C"], ["D"], { id: "y", sa: 9 }), M(["A"], ["B"], { id: "x", sa: 7, sb: 3, done: true, doneAt: 50 })] }];
  const out = mergeRemoteScores(local, remote);
  assert.deepEqual([out[0].matches[0].sa, out[0].matches[0].done, out[0].matches[0].doneAt], [7, true, 50]);
  assert.equal(out[0].matches[1].sa, 4); // 本機已經有比分的不動
  assert.equal(local[0].matches[0].sa, 0); // 不改原本的
  // 舊資料沒有編號：上一輪同樣兩隊的比分不能抄到這一輪
  const old = [{ cycle: 0, matches: [M(["A"], ["B"], { sa: 11, done: true })] }, { cycle: 1, matches: [M(["A"], ["B"])] }];
  assert.equal(mergeRemoteScores(old, old)[1].matches[0].sa, 0);
});

test("重排算好後，把算的時候記的比分抄回保留的比賽", () => {
  const rounds = [{ matches: [M(["A"], ["B"], { id: "x" })] }, { matches: [M(["A"], ["B"])] }];
  const current = [{ matches: [M(["A"], ["B"], { id: "x", sa: 6, sb: 2 })] }];
  copyScores(rounds, current, 1);
  assert.equal(rounds[0].matches[0].sa, 6);
  assert.equal(rounds[1].matches[0].sa, 0); // 新排的不動
});

test("照編號找比賽：位置變了（重排、對調）也找得到", () => {
  const rounds = withIds([{ matches: [M(["A"], ["B"]), M(["C"], ["D"])] }]);
  const target = { ...rounds[0].matches[1] };
  rounds[0].matches.reverse();
  assert.deepEqual(locateMatch(rounds, target, 0, 1), [0, 0]);
  assert.ok(sameMatch(rounds[0].matches[0], target));
  assert.equal(locateMatch(rounds, { id: "nope", a: ["X"], b: ["Y"] }, 0, 0), null);
});

test("連打場數與上一場", () => {
  const rounds = [{ matches: [M(["A"], ["B"])] }, { matches: [M(["A"], ["C"])] }, { matches: [M(["A"], ["B"])] }, { matches: [M(["B"], ["C"])] }];
  assert.equal(maxPlayStreak(rounds), 3);
  const ev = { rounds };
  finish(rounds[0].matches[0], 10);
  finish(rounds[1].matches[0], 20);
  assert.deepEqual(lastOnCourt(ev, courtFlow(ev), 0).m.a, ["A"]);
  assert.equal(lastOnCourt(ev, courtFlow(ev), 0).ri, 1);
});

test("排名：成績一樣名次相同；還沒打的排最後；場數不同時比勝率", () => {
  const players = ["p0", "p1", "p2", "p3", "p4"].map((id) => ({ id, name: id }));
  const rounds = [{ matches: [M(["p0", "p1"], ["p2", "p3"], { sa: 11, sb: 5, done: true })] }];
  const s = standings(players, rounds);
  assert.deepEqual(s.map((r) => [r.id, r.rank]), [["p0", 1], ["p1", 1], ["p2", 3], ["p3", 3], ["p4", null]]);
  // p0 再輸一場：1 勝 1 敗；p1 1 勝 0 敗 → p1 勝率高排前面
  rounds.push({ matches: [M(["p0", "p2"], ["p3", "p4"], { sa: 9, sb: 11, done: true })] });
  const s2 = standings(players, rounds);
  assert.deepEqual(s2.map((r) => r.id), ["p1", "p4", "p0", "p3", "p2"]); // p1 +6/場 > p4 +2/場；p0 和 p3 都 1 勝 1 敗，p0 平均淨勝分較高
  assert.equal(s2[0].rank, 1);
});
