/* dsh-turn-chime — client half.
 *
 * 订阅宿主侧插件的事件流 `/dsh-turn-chime/events`（SSE），收到 chime 事件时用
 * Web Audio 合成一声提示音。
 *
 * 判定「算不算任务跑完」不在这里：客户端只看得到 `api-session/status` 的忙/闲
 * 布尔值，分不出「正常完成」和「被用户中断」，而宿主侧同时能看到 user/message、
 * turn/end 的 reason 和 agent/status 的翻转，判定通过才把事件推过来。
 *
 * 发声放渲染进程的理由：宿主里播声音只能 spawn 一个 PowerShell/播放器进程，
 * 冷启动几百毫秒还要管进程回收；Web Audio 零依赖、零延迟，音色现场合成，
 * 不需要附带音频文件。
 */
window.__ModuleLoader__.load({
  id: "dsh-turn-chime",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    // ── 配置 ────────────────────────────────────────────────────────────
    var STORAGE_KEY = "dsh-turn-chime:config:v1";
    var DEFAULTS = {
      enabled: true,
      voice: "chime",
      volume: 0.55,
      onlyUserSessions: true,
      debounceMs: 350
    };

    var VOICE_LIST = [
      { id: "chime", label: "清脆叮声（默认）" },
      { id: "bell", label: "钟声（长尾）" },
      { id: "codex", label: "短促清音（Codex 风）" },
      { id: "ping", label: "短促提示" },
      { id: "drop", label: "水滴" },
      { id: "marimba", label: "木琴" },
      { id: "arcade", label: "复古双音" },
      { id: "soft", label: "柔和低音" },
      { id: "none", label: "静音" }
    ];

    function clamp(v, lo, hi) {
      var n = Number(v);
      if (!isFinite(n)) return lo;
      return n < lo ? lo : n > hi ? hi : n;
    }

    function normalize(raw) {
      var src = raw && typeof raw === "object" ? raw : {};
      var voice = typeof src.voice === "string" ? src.voice : DEFAULTS.voice;
      var known = false;
      for (var i = 0; i < VOICE_LIST.length; i++) if (VOICE_LIST[i].id === voice) known = true;
      return {
        enabled: src.enabled === undefined ? DEFAULTS.enabled : src.enabled !== false,
        voice: known ? voice : DEFAULTS.voice,
        volume: clamp(src.volume === undefined ? DEFAULTS.volume : src.volume, 0, 1),
        onlyUserSessions: src.onlyUserSessions === undefined ? DEFAULTS.onlyUserSessions : src.onlyUserSessions !== false,
        debounceMs: clamp(src.debounceMs === undefined ? DEFAULTS.debounceMs : src.debounceMs, 0, 5000)
      };
    }

    function readStored() {
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY);
        return raw === null ? normalize(null) : normalize(JSON.parse(raw));
      } catch (e) {
        return normalize(null);
      }
    }

    var config = readStored();
    var configListeners = new Set();

    function updateConfig(patch) {
      config = normalize(Object.assign({}, config, patch));
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      } catch (e) {
        /* 隐私模式 / 配额满：配置退化为进程内有效，不影响播放 */
      }
      configListeners.forEach(function (fn) {
        try {
          fn(config);
        } catch (e) {
          /* 单个订阅者出错不影响其它订阅者 */
        }
      });
      return config;
    }

    // ── 诊断上报 ────────────────────────────────────────────────────────
    // 客户端插件静默失效时浏览器里没有可见线索，唯一观测面是宿主日志。
    var diagSent = 0;
    function diagUrl(path) {
      var rel = String(path).replace(/^\/+/, "");
      try {
        return new URL(rel, document.baseURI).pathname;
      } catch (e) {
        return "/" + rel;
      }
    }

    function diag(entry) {
      if (diagSent > 400) return; // 上限：正常使用远到不了，异常循环也不会打爆日志
      diagSent++;
      try {
        var payload = Object.assign({ t: Date.now(), src: "client" }, entry);
        fetch(diagUrl("/dsh-turn-chime/diag"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }).catch(function () {
          /* 宿主不可达（例如纯静态托管）时静默 */
        });
      } catch (e) {
        /* ignore */
      }
    }

    // ── 音频引擎 ────────────────────────────────────────────────────────
    var audioCtx = null;
    var masterGain = null;

    function audio() {
      if (audioCtx !== null) {
        if (audioCtx.state === "suspended") {
          var resumed = audioCtx.resume();
          if (resumed && typeof resumed.catch === "function") resumed.catch(function () {});
        }
        return audioCtx;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (typeof AC !== "function") return null;
      try {
        audioCtx = new AC();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 1;
        masterGain.connect(audioCtx.destination);
      } catch (e) {
        audioCtx = null;
        masterGain = null;
        return null;
      }
      if (audioCtx.state === "suspended") {
        var r = audioCtx.resume();
        if (r && typeof r.catch === "function") r.catch(function () {});
      }
      return audioCtx;
    }

    /** One enveloped oscillator partial. Exponential ramps never touch zero. */
    function blip(ac, out, o) {
      var t0 = ac.currentTime + (o.delay || 0);
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      var attack = o.attack === undefined ? 0.006 : o.attack;
      var dur = o.dur === undefined ? 0.5 : o.dur;
      osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(o.freq, t0);
      if (o.freqTo) osc.frequency.exponentialRampToValueAtTime(o.freqTo, t0 + (o.sweep || dur));
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(o.gain, 0.0005), t0 + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }

    var VOICES = {
      chime: function (ac, out, v) {
        blip(ac, out, { freq: 1318.51, type: "sine", dur: 0.85, gain: 0.5 * v, attack: 0.004 });
        blip(ac, out, { freq: 1760, type: "sine", dur: 0.45, gain: 0.14 * v, attack: 0.004 });
      },
      bell: function (ac, out, v) {
        blip(ac, out, { freq: 659.25, type: "sine", dur: 1.7, gain: 0.42 * v, attack: 0.005 });
        blip(ac, out, { freq: 1318.51, type: "sine", dur: 1.0, gain: 0.16 * v, attack: 0.005 });
        blip(ac, out, { freq: 1975.53, type: "sine", dur: 0.55, gain: 0.07 * v, attack: 0.005 });
      },
      codex: function (ac, out, v) {
        blip(ac, out, { freq: 1046.5, type: "sine", dur: 0.2, gain: 0.5 * v, attack: 0.003 });
        blip(ac, out, { freq: 1567.98, type: "sine", dur: 0.13, gain: 0.22 * v, attack: 0.003 });
      },
      ping: function (ac, out, v) {
        blip(ac, out, { freq: 1760, type: "sine", dur: 0.28, gain: 0.5 * v, attack: 0.004 });
      },
      drop: function (ac, out, v) {
        blip(ac, out, { freq: 1500, freqTo: 620, sweep: 0.16, type: "sine", dur: 0.42, gain: 0.5 * v, attack: 0.004 });
      },
      marimba: function (ac, out, v) {
        blip(ac, out, { freq: 880, type: "triangle", dur: 0.5, gain: 0.45 * v, attack: 0.003 });
        blip(ac, out, { freq: 1320, type: "sine", dur: 0.3, gain: 0.15 * v, attack: 0.003 });
      },
      arcade: function (ac, out, v) {
        blip(ac, out, { freq: 783.99, type: "square", dur: 0.12, gain: 0.2 * v, attack: 0.002 });
        blip(ac, out, { freq: 1046.5, type: "square", dur: 0.22, gain: 0.2 * v, attack: 0.002, delay: 0.1 });
      },
      soft: function (ac, out, v) {
        blip(ac, out, { freq: 587.33, type: "sine", dur: 0.9, gain: 0.5 * v, attack: 0.02 });
        blip(ac, out, { freq: 880, type: "sine", dur: 0.7, gain: 0.18 * v, attack: 0.02, delay: 0.06 });
      }
    };

    /** Play one voice; returns false when the audio path is unavailable. */
    function play(voice, volume) {
      if (voice === "none") return false;
      var voiceFn = VOICES[voice];
      if (typeof voiceFn !== "function") return false;
      var ac = audio();
      if (ac === null || masterGain === null) return false;
      try {
        voiceFn(ac, masterGain, clamp(volume, 0, 1));
        return true;
      } catch (e) {
        diag({ ev: "play-error", voice: voice, error: String((e && e.message) || e) });
        return false;
      }
    }

    // ── 设置面板 ────────────────────────────────────────────────────────
    var S = {
      root: { display: "flex", flexDirection: "column", gap: "12px", padding: "2px 0 8px" },
      row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      label: { fontSize: "12px", fontWeight: 600, minWidth: "72px", color: "inherit" },
      muted: { fontSize: "11px", color: "var(--dsw-alias-label-secondary,#64748b)", lineHeight: "1.6" },
      select: {
        padding: "4px 8px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))",
        background: "var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))",
        color: "inherit",
        fontSize: "12px",
        minWidth: "160px"
      },
      range: { width: "180px" },
      btn: {
        padding: "4px 12px",
        borderRadius: "6px",
        border: "1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))",
        background: "var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))",
        color: "inherit",
        fontSize: "12px",
        cursor: "pointer"
      },
      check: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" },
      ok: { fontSize: "11px", color: "#16a34a" },
      err: { fontSize: "11px", color: "#e5534b" }
    };

    function ChimeSettings() {
      var pair = react.useState(config);
      var current = pair[0];
      var setCurrent = pair[1];
      var note = react.useState(null);
      var noteText = note[0];
      var setNote = note[1];
      var sse = react.useState({ connected: false, chimes: 0 });
      var sseInfo = sse[0];
      var setSseInfo = sse[1];

      react.useEffect(function () {
        var read = function () {
          var api = window.__dshTurnChime;
          if (!api || typeof api.status !== "function") return;
          var s = api.status();
          setSseInfo({ connected: s.connected === true, chimes: typeof s.chimes === "number" ? s.chimes : 0 });
        };
        read();
        var timer = window.setInterval(read, 1500);
        return function () {
          window.clearInterval(timer);
        };
      }, []);

      react.useEffect(function () {
        var listener = function (next) {
          setCurrent(next);
        };
        configListeners.add(listener);
        return function () {
          configListeners.delete(listener);
        };
      }, []);

      var voiceOptions = VOICE_LIST.map(function (v) {
        return h("option", { key: v.id, value: v.id }, v.label);
      });

      function onPreview() {
        var ok = play(current.voice, current.volume);
        if (ok) {
          setNote({ kind: "ok", text: "已播放" });
        } else if (current.voice === "none") {
          setNote({ kind: "err", text: "当前是静音音色" });
        } else {
          setNote({ kind: "err", text: "浏览器音频不可用（Web Audio 被禁用？）" });
        }
        window.setTimeout(function () {
          setNote(null);
        }, 2500);
      }

      return h(
        "div",
        { style: S.root },
        h(
          "label",
          { style: S.check },
          h("input", {
            type: "checkbox",
            checked: current.enabled,
            onChange: function (e) {
              updateConfig({ enabled: e.target.checked });
            }
          }),
          "对话任务完成时播放提示音"
        ),
        h(
          "div",
          { style: S.row },
          h("span", { style: S.label }, "音色"),
          h(
            "select",
            {
              style: S.select,
              value: current.voice,
              onChange: function (e) {
                updateConfig({ voice: e.target.value });
                play(e.target.value, current.volume);
              }
            },
            voiceOptions
          ),
          h(
            "button",
            { style: S.btn, type: "button", onClick: onPreview },
            "试听"
          ),
          noteText ? h("span", { style: noteText.kind === "ok" ? S.ok : S.err }, noteText.text) : null
        ),
        h(
          "div",
          { style: S.row },
          h("span", { style: S.label }, "音量"),
          h("input", {
            type: "range",
            min: "0",
            max: "100",
            step: "1",
            style: S.range,
            value: String(Math.round(current.volume * 100)),
            onChange: function (e) {
              updateConfig({ volume: Number(e.target.value) / 100 });
            },
            onMouseUp: function () {
              play(current.voice, current.volume);
            },
            onTouchEnd: function () {
              play(current.voice, current.volume);
            }
          }),
          h("span", { style: S.muted }, Math.round(current.volume * 100) + "%")
        ),
        h(
          "label",
          { style: S.check },
          h("input", {
            type: "checkbox",
            checked: current.onlyUserSessions,
            onChange: function (e) {
              updateConfig({ onlyUserSessions: e.target.checked });
            }
          }),
          "忽略子代理（subagent）会话，只在主对话结束时响"
        ),
        h(
          "div",
          { style: S.muted },
          "只在任务正常跑完时响：被中断、报错、被 hook 拦下、撞上 max-tokens 都不响。",
          "提示音在渲染进程里用 Web Audio 合成，不依赖任何音频文件。"
        ),
        h(
          "div",
          { style: S.muted },
          "事件通道：",
          h("span", { style: sseInfo.connected ? S.ok : S.err }, sseInfo.connected ? "已连接" : "未连接"),
          "　本次已响 " + sseInfo.chimes + " 次　诊断日志：",
          h("code", { style: { fontSize: "11px" } }, "%DSH_HOME%\\logs\\dsh-turn-chime.log")
        )
      );
    }

    // ── 主逻辑 ──────────────────────────────────────────────────────────
    var inject = ["slots"];

    function apply(ctx) {
      var eventSource = null;
      var connected = false;
      var lastPlayAt = 0;
      var chimeCount = 0;

      /* `sessions` 由 dsh-api-session-controller 在 rootCtx 上 provide，而本插件
       * 声明了 immediately，apply 时它可能还没就绪 —— 所以每次现取，不缓存。 */
      function sessionsService() {
        try {
          return ctx.get("sessions");
        } catch (e) {
          return undefined;
        }
      }

      function sessionRows() {
        var svc = sessionsService();
        if (!svc || !svc.list || typeof svc.list.getSnapshot !== "function") return null;
        var snap = svc.list.getSnapshot();
        return snap && snap.byId ? snap.byId : null;
      }

      /** 排除子代理会话：它们的完成不代表用户等待的那件事结束了。 */
      function isUserSession(sessionId) {
        try {
          var rows = sessionRows();
          if (rows === null) return true; // 拿不到目录时按用户会话处理，宁可多响一次
          var row = rows[sessionId];
          if (!row) return true;
          if (row.origin === "subagent") return false;
          if (row.parentSessionId !== undefined && row.parentSessionId !== null) return false;
          return true;
        } catch (e) {
          return true;
        }
      }

      /** 宿主已判定「任务正常跑完」，这里只负责过滤与发声。 */
      function onChime(sessionId) {
        if (!config.enabled) return;
        if (config.onlyUserSessions && !isUserSession(sessionId)) {
          diag({ ev: "skip-subagent", sessionId: sessionId });
          return;
        }
        var now = Date.now();
        if (now - lastPlayAt < config.debounceMs) {
          diag({ ev: "skip-debounce", sessionId: sessionId });
          return;
        }
        lastPlayAt = now;
        chimeCount++;
        var ok = play(config.voice, config.volume);
        diag({ ev: "play", sessionId: sessionId, voice: config.voice, volume: config.volume, ok: ok, count: chimeCount });
      }

      /** 订阅宿主的完成事件流。EventSource 自带断线重连，不需要自己轮询。 */
      function connect() {
        if (typeof EventSource !== "function") {
          diag({ ev: "sse-unsupported" });
          return;
        }
        try {
          eventSource = new EventSource(diagUrl("/dsh-turn-chime/events"));
        } catch (e) {
          diag({ ev: "sse-error", error: String((e && e.message) || e) });
          return;
        }
        eventSource.onopen = function () {
          connected = true;
          diag({ ev: "sse-open" });
        };
        eventSource.onerror = function () {
          if (connected) diag({ ev: "sse-closed" });
          connected = false;
        };
        eventSource.onmessage = function (ev) {
          var data;
          try {
            data = JSON.parse(ev.data);
          } catch (e) {
            return;
          }
          if (!data || data.type !== "chime") return;
          onChime(String(data.sessionId === undefined ? "" : data.sessionId));
        };
      }

      ctx.effect(function () {
        connect();
        diag({
          ev: "client-ready",
          hasSessions: sessionRows() !== null,
          audio: typeof (window.AudioContext || window.webkitAudioContext) === "function",
          sse: typeof EventSource === "function",
          config: config
        });
        return function () {
          try {
            if (eventSource !== null) eventSource.close();
          } catch (e) {
            /* ignore */
          }
          eventSource = null;
          connected = false;
        };
      }, "dsh-turn-chime: completion stream subscription");

      // 调试/自测入口：可在控制台手动试听或模拟一次完成事件。
      try {
        window.__dshTurnChime = {
          play: function (voice, volume) {
            return play(voice === undefined ? config.voice : voice, volume === undefined ? config.volume : volume);
          },
          onChime: onChime,
          status: function () {
            return { connected: connected, chimes: chimeCount, config: config };
          },
          config: function () {
            return config;
          },
          updateConfig: updateConfig,
          logUrl: "/dsh-turn-chime/log"
        };
      } catch (e) {
        /* ignore */
      }

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: "turn-chime", order: 19, label: "提示音" },
          function () {
            return h(ChimeSettings, null);
          }
        );
      });
    }

    exports.name = "dsh-turn-chime";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
