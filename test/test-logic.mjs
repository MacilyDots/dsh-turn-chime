/* 用假 ctx 直接驱动宿主半的判定逻辑，验证「什么时候该响」。
 * 不启动 DSH、不需要模型，纯事件序列回放。
 *
 *   node test/test-logic.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 诊断日志落到临时目录，别污染真实的 %DSH_HOME%
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-turn-chime-test-"));

const { apply } = await import("../lib/index.js");

const handlers = new Map();
const routes = new Map();

function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, []);
  handlers.get(name).push(fn);
}
function emit(name, ...args) {
  for (const fn of handlers.get(name) ?? []) fn(...args);
}

const frames = [];
const fakeRes = {
  writeHead() {},
  flushHeaders() {},
  write(chunk) {
    for (const line of String(chunk).split("\n")) {
      if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
    }
    return true;
  },
  end() {},
  on() {}
};
const fakeReq = { method: "GET", headers: {}, on() {} };

const ctx = {
  on,
  effect(fn) {
    return fn();
  },
  inject(_deps, cb) {
    cb({
      effect(fn) {
        return fn();
      },
      webServer: {
        register({ path, handler }) {
          routes.set(path, handler);
          return () => routes.delete(path);
        }
      }
    });
  }
};

apply(ctx);

if (typeof routes.get("/dsh-turn-chime/events") !== "function") throw new Error("SSE route missing");
routes.get("/dsh-turn-chime/events")(fakeReq, fakeRes);

const sessionEvent = (id, type, data) => emit("session/event", { id }, { type, data });
const idle = (id) => emit("agent/status", { agent: { id }, status: "idle" });
const running = (id) => emit("agent/status", { agent: { id }, status: "running" });
const userMsg = (id, kind = "user") => sessionEvent(id, "user/message", { source: { kind } });
const turnEnd = (id, kind) => sessionEvent(id, "turn/end", { reason: { kind } });

// 1. 正常跑完 → 响
userMsg("s1");
turnEnd("s1", "completed");
idle("s1");

// 2. 用户中断 → 不响
userMsg("s2");
turnEnd("s2", "aborted");
idle("s2");

// 3. 只有 time-context 注入，没有真实用户消息 → 不响
userMsg("s3", "time-context");
turnEnd("s3", "completed");
idle("s3");

// 4. 一次用户消息、两个 driver（自动续跑）→ 只响第一次
userMsg("s4");
turnEnd("s4", "completed");
idle("s4");
running("s4");
turnEnd("s4", "completed");
idle("s4");

// 5. 报错结束 → 不响
userMsg("s5");
turnEnd("s5", "error");
idle("s5");

// 6. 中断后又发一条并正常跑完 → 响
userMsg("s6");
turnEnd("s6", "aborted");
idle("s6");
userMsg("s6");
turnEnd("s6", "completed");
idle("s6");

const got = frames.map((f) => f.sessionId);
const expected = ["s1", "s4", "s6"];
const pass = JSON.stringify(got) === JSON.stringify(expected);
console.log(
  JSON.stringify(
    {
      frames: got,
      expected,
      pass,
      sample: frames[0] ?? null
    },
    null,
    2
  )
);
// 插件里的 SSE 心跳定时器会让事件循环一直活着，测完直接退。
process.exit(pass ? 0 : 1);
