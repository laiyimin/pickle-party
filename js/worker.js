// 在背景排賽程：人多時要算好幾秒，放在這裡算畫面才不會卡住
import { buildCycle } from "./scheduler.js";

self.onmessage = (e) => {
  const { id, args } = e.data;
  try {
    self.postMessage({ id, rounds: buildCycle(args) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
