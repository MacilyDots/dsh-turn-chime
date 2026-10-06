/* dsh-turn-chime — host half.
 *
 * 判定「这一轮到底算不算任务跑完」需要宿主侧才有的信息：
 *   - `session/event` 的 `user/message`：只有 source.kind === 'user' 才是用户真的发了消息；
 *   - `session/event` 的 `turn/end`：带结束原因（completed / aborted / error / blocked / max-tokens）；
 *   - `agent/status` 的 idle：一个 driver（可能连着跑好几个 turn）彻底停下。
 *
 * 客户端只有 `api-session/status` 的忙/闲布尔值，看不出「被用户中断」和「正常完成」的区别，
 * 所以判定放这里，判定通过再经 SSE 通知客户端发声。
 *
 * 路由：
 *   GET  /dsh-turn-chime/events   SSE，推 {"type":"chime","sessionId":...}
 *   POST /dsh-turn-chime/diag     客户端诊断上报
 *   GET  /dsh-turn-chime/log      读回最近日志
 *   POST /dsh-turn-chime/clear    清空日志
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-turn-chime";

const ROUTE_PREFIX = "/dsh-turn-chime";
const MAX_LOG_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const HEARTBEAT_MS = 25000;

/** 只有正常跑完才响；中断、报错、被 hook 拦下、撞上 max-tokens 都不算「任务跑完」。 */
const CHIME_REASON = "completed";

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function logDir() {
  return join(dshHome(), "logs");
}

function logPath() {
  return join(logDir(), "dsh-turn-chime.log");
}

/** Append one line, rotating the file once it grows past the cap. Never throws. */
function appendLog(line) {
  const file = logPath();
  try {
    mkdirSync(logDir(), { recursive: true });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + ".1");
    } catch {
      /* missing file or rename race — appending below still works */
    }
    appendFileSync(file, line + "\n");
  } catch {
    /* logging must never break the plugin */
  }
}

function readTail(maxLines) {
  try {
    const text = readFileSync(logPath(), "utf8");
    return text.split("\n").filter((l) => l !== "").slice(-maxLines);
  } catch {
    return [];
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  const host = req.headers.host;
  if (typeof host !== "string" || host === "") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function apply(ctx) {
  /** 打开着的页面各一条 SSE 连接。 */
  const streams = new Set();

  /**
   * 每会话状态：
   *   pending    —— 用户发过一条消息，且这次任务还没响过铃
   *   lastReason —— 最近一次 turn/end 的 reason（turn/end 先于 agent/status idle 落盘）
   */
  const state = new Map();

  function stateOf(sessionId) {
    let entry = state.get(sessionId);
    if (entry === undefined) {
      entry = { pending: false, lastReason: null };
      state.set(sessionId, entry);
    }
    return entry;
  }

  function broadcast(payload) {
    const frame = "data: " + JSON.stringify(payload) + "\n\n";
    for (const res of streams) {
      try {
        res.write(frame);
      } catch {
        streams.delete(res);
      }
    }
  }

  ctx.on("session/event", (session, event) => {
    const type = event?.type;
    if (type === "user/message") {
      // 只认真正的用户输入：time-context、子代理回灌、hook 注入都不算。
      if (event.data?.source?.kind !== "user") return;
      stateOf(session.id).pending = true;
      return;
    }
    if (type === "turn/end") {
      stateOf(session.id).lastReason = event.data?.reason ?? null;
    }
  });

  ctx.on("session/disposed", (session) => {
    state.delete(session.id);
  });

  ctx.on("agent/status", ({ agent, status }) => {
    if (status !== "idle" || !agent) return;
    const entry = stateOf(agent.id);
    const reason = entry.lastReason;
    entry.lastReason = null;
    if (!entry.pending) return; // 自动续跑的 driver（子代理回灌、goal 轮次）不再重复响
    entry.pending = false;
    const kind = reason?.kind ?? null;
    if (kind !== CHIME_REASON) {
      appendLog(new Date().toISOString() + " skip-turn-end " + JSON.stringify({ sessionId: agent.id, reason: kind }));
      return;
    }
    broadcast({ type: "chime", sessionId: agent.id, reason: kind, at: Date.now() });
    appendLog(new Date().toISOString() + " chime " + JSON.stringify({ sessionId: agent.id, clients: streams.size }));
  });

  // 作用域注入：没有 webServer 的宿主不该让整个插件加载失败。
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      const disposers = [];
      const beats = new Set();

      const eventsHandler = (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        res.write(": connected\n\n");
        streams.add(res);

        // 心跳：长连接被中间层或空闲超时掐断前保活。
        const beat = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            /* closed */
          }
        }, HEARTBEAT_MS);
        beats.add(beat);

        const drop = () => {
          clearInterval(beat);
          beats.delete(beat);
          streams.delete(res);
        };
        req.on("close", drop);
        req.on("error", drop);
        res.on("error", drop);
      };

      const diagHandler = async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: "forbidden" });
          return;
        }
        try {
          const entry = JSON.parse(await readBody(req));
          const ev = typeof entry?.ev === "string" ? entry.ev : "?";
          appendLog(new Date().toISOString() + " " + ev + " " + JSON.stringify(entry));
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String(err?.message ?? err) });
        }
      };

      const logHandler = async (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        sendJson(res, 200, { ok: true, path: logPath(), clients: streams.size, lines: readTail(120) });
      };

      const clearHandler = async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        try {
          writeFileSync(logPath(), "");
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String(err?.message ?? err) });
        }
      };

      disposers.push(host.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/events", handler: eventsHandler }));
      disposers.push(host.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/diag", handler: diagHandler }));
      disposers.push(host.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/log", handler: logHandler }));
      disposers.push(host.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/clear", handler: clearHandler }));

      appendLog(new Date().toISOString() + " host-ready " + JSON.stringify({ routes: 4, log: logPath() }));

      return () => {
        for (const beat of beats) clearInterval(beat);
        beats.clear();
        for (const res of streams) {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
        streams.clear();
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
      };
    }, "dsh-turn-chime: routes and turn-completion judgement");
  });
}
