# dsh-turn-chime

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

[English](README.md) | [简体中文](README.zh-CN.md)

对话任务**真正跑完**时播放一声提示音。判定在宿主侧、发声在客户端，音色用 Web Audio 现场合成，不带任何音频文件。

## 它解决什么

DeepSeek Harness 的 `api-session/status` 只告诉你「agent 现在忙不忙」。直接拿它当完成信号会踩两个坑：

- **分不出「跑完」和「被中断」**。用户按下停止、报错退出、被 hook 拦下，状态同样会翻回 idle。
- **一个任务可能由多个 driver 组成**。子代理回灌结果、goal 轮次续跑，每个 driver 停下都会翻一次 idle，于是一段任务响好几次。

这个插件把判定挪到宿主侧，只有「用户发起的任务正常跑完」才响一次。

## 安装

把仓库放在任意目录，然后：

```powershell
node install.mjs                  # 装进 %DSH_HOME%\profiles\desktop
node install.mjs web              # 装进指定 profile（可给多个）
node install.mjs D:\path\to\profile
```

脚本做三件事：往 profile 的 `package.json` 写 `file:` 依赖、往 `dsh.profile.bundles` 加插件名、在 `node_modules/<插件>` 建一个指向本仓库的 junction（所以改源码立即生效，不用再同步副本）。

**装完必须重启 DSH** —— 客户端模块清单在启动时生成，不重启不会加载。

卸载：从 `dsh.profile.bundles` 里删掉这一行，再删掉 `node_modules/dsh-turn-chime`。

## 使用

设置 → **提示音**：

| 项 | 说明 |
|---|---|
| 启用提示音 | 总开关 |
| 音色 | 清脆叮声 / 钟声 / 短促清音 / 短促提示 / 水滴 / 木琴 / 复古双音 / 柔和低音 / 静音 |
| 音量 | 0–100%，拖完自动试听 |
| 忽略子代理会话 | 默认开。子代理跑完不算「用户等的那件事」 |
| 事件通道 | 显示 SSE 是否连着，以及本次已响几次 |

配置存在浏览器 `localStorage`（`dsh-turn-chime:config:v1`）。

## 触发时机

三个条件同时满足才响：

1. `session/event` 的 `user/message`，且 `source.kind === "user"` —— 用户真的发过一条消息（time-context 注入、子代理回灌、hook 注入都不算）；
2. `session/event` 的 `turn/end`，且 `reason.kind === "completed"` —— 正常跑完。被中断（`aborted`）、报错（`error`）、被 hook 拦下（`blocked`）、撞上 `max-tokens` 都不响；
3. `agent/status` 翻到 `idle` —— 一个 driver 彻底停下。

一次用户消息只响一次：`pending` 标记在第一次响铃时消费掉，之后同一任务的自动续跑不再重复响。

判定结果经 SSE `/dsh-turn-chime/events` 推给客户端。

## 排查

宿主侧诊断日志：

```
%DSH_HOME%\logs\dsh-turn-chime.log
```

正常的一次收尾长这样：

```
client-ready {"hasSessions":false,"audio":true,"sse":true,...}
sse-open
chime        {"sessionId":"...","clients":1}
play         {"sessionId":"...","voice":"chime","ok":true,"count":1}
```

| 日志里看到什么 | 说明 |
|---|---|
| 没有 `client-ready` | 客户端插件没加载，重启 DSH |
| `sse:false` | 浏览器没有 `EventSource`，收不到完成事件 |
| 有 `client-ready` 但没有 `sse-open` | SSE 没连上，看设置面板的事件通道 |
| 只有 `skip-turn-end` | 那次结束的 reason 不是 `completed` |
| 完全没有 `chime` 行 | 宿主没判定通过：那条消息不是用户发的 |
| `play ok:false` | 音色是「静音」，或音频上下文被策略挂起 |

三条同源路由：

- `GET  /dsh-turn-chime/events` —— SSE 完成事件流
- `GET  /dsh-turn-chime/log` —— 读回最近 120 行
- `POST /dsh-turn-chime/clear` —— 清空日志

浏览器控制台里的调试入口：

```js
__dshTurnChime.play('chime', 0.6)  // 手动试听
__dshTurnChime.status()            // { connected, chimes, config }
__dshTurnChime.onChime('x')        // 模拟一次完成事件 → 应当响一声
```

## 为什么这么分

**发声只能在渲染进程。** 宿主里播声音要么 spawn 一个 PowerShell/播放器进程（冷启动几百毫秒，还要管进程回收），要么用 Electron 的 `shell.beep()`（音色不可选）。Web Audio 零依赖、零延迟、跨平台，音色还能现场合成。

**判定只能在宿主。** 客户端拿到的 `api-session/status` 是个布尔值，看不出这次结束是正常跑完还是被按了停止；`turn/end` 的 reason 和 `user/message` 的来源都只存在于宿主事件总线里。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主：完成判定 + `/dsh-turn-chime/{events,diag,log,clear}` 四条路由 |
| `lib/client.js` | 客户端：SSE 订阅、Web Audio 合成、设置面板、诊断上报 |
| `cordis.patch.yml` | bundle 补丁，一条 insert 行激活插件 |
| `install.mjs` | 幂等安装脚本 |
| `test/test-logic.mjs` | 判定逻辑测试（假 ctx 回放事件序列） |

## 测试

```powershell
node test/test-logic.mjs   # 或 npm test
```

覆盖六个场景：正常跑完→响、用户中断→不响、只有 time-context 注入→不响、一次消息两个 driver→只响一次、报错→不响、中断后再发消息跑完→响。

## 已知限制

- 提示音只在浏览器渲染进程里响，DSH 完全关闭时不会有声音。
- 判定依赖 DSH 的内部事件（`session/event`、`agent/status`）。DSH 大版本升级后如果事件形状变了，`lib/index.js` 需要同步调整。
- 只在 `reason.kind === "completed"` 时响，出错的结束是静音的。想让出错也响（换一种声音），改 `lib/index.js` 里的 `CHIME_REASON`。

## License

MIT
