# dsh-turn-chime

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)

[English](README.md) | [简体中文](README.zh-CN.md)

Plays a chime when a conversation task **actually finishes**. The decision is made on the host side, the sound is emitted in the client, and the tone is synthesized on the fly with Web Audio — no audio files involved.

## What it solves

DeepSeek Harness's `api-session/status` only tells you whether the agent is busy right now. Using it directly as a completion signal runs into two problems:

- **It can't tell "finished" from "interrupted".** When the user hits stop, a run exits with an error, or a hook blocks it, the status flips back to idle all the same.
- **A single task can consist of multiple drivers.** Subagents feeding results back, goal rounds continuing the run — every driver that stops flips idle once, so one stretch of work chimes several times.

This plugin moves the decision to the host side, so it chimes exactly once, and only when a user-initiated task finishes normally.

## Install

Put the repository in any directory, then:

```powershell
node install.mjs                  # install into %DSH_HOME%\profiles\desktop
node install.mjs web              # install into the named profile (multiple allowed)
node install.mjs D:\path\to\profile
```

The script does three things: writes a `file:` dependency into the profile's `package.json`, adds the plugin name to `dsh.profile.bundles`, and creates a junction under `node_modules/<plugin>` pointing at this repository (so source edits take effect immediately, with no copy to re-sync).

**DSH must be restarted after installing** — the client module manifest is generated at startup, so the plugin won't load without a restart.

To uninstall: remove that line from `dsh.profile.bundles`, then delete `node_modules/dsh-turn-chime`.

## Usage

Settings → **Chime**:

| Item | Description |
|---|---|
| Enable chime | Master switch |
| Voice | Crisp ding / Bell / Short pluck / Short beep / Water drop / Xylophone / Retro two-tone / Soft bass / Muted |
| Volume | 0–100%, previews automatically when you release the slider |
| Ignore subagent sessions | On by default. A subagent finishing doesn't count as "the thing the user is waiting for" |
| Event channel | Shows whether SSE is connected and how many times it has chimed so far |

The configuration is stored in the browser's `localStorage` (`dsh-turn-chime:config:v1`).

## When it fires

All three conditions must hold:

1. `session/event`'s `user/message`, with `source.kind === "user"` — the user really sent a message (time-context injection, subagent feedback, and hook injection don't count);
2. `session/event`'s `turn/end`, with `reason.kind === "completed"` — finished normally. Interrupted (`aborted`), errored (`error`), blocked by a hook (`blocked`), and hitting `max-tokens` all stay silent;
3. `agent/status` flipping to `idle` — one driver has come to a full stop.

One user message chimes once: the `pending` flag is consumed on the first ring, so automatic continuation of the same task doesn't ring again.

The verdict is pushed to the client over SSE at `/dsh-turn-chime/events`.

## Troubleshooting

Host-side diagnostic log:

```
%DSH_HOME%\logs\dsh-turn-chime.log
```

A normal wrap-up looks like this:

```
client-ready {"hasSessions":false,"audio":true,"sse":true,...}
sse-open
chime        {"sessionId":"...","clients":1}
play         {"sessionId":"...","voice":"chime","ok":true,"count":1}
```

| What you see in the log | Meaning |
|---|---|
| No `client-ready` | The client plugin didn't load; restart DSH |
| `sse:false` | The browser has no `EventSource`, so completion events don't arrive |
| `client-ready` but no `sse-open` | SSE never connected; check the event channel in the settings panel |
| Only `skip-turn-end` | That turn's reason wasn't `completed` |
| No `chime` line at all | The host didn't pass its check: that message wasn't sent by the user |
| `play ok:false` | The voice is "Muted", or the audio context is suspended by policy |

Three routes from the same source:

- `GET  /dsh-turn-chime/events` — SSE completion event stream
- `GET  /dsh-turn-chime/log` — reads back the last 120 lines
- `POST /dsh-turn-chime/clear` — clears the log

Debug entry points in the browser console:

```js
__dshTurnChime.play('chime', 0.6)  // preview manually
__dshTurnChime.status()            // { connected, chimes, config }
__dshTurnChime.onChime('x')        // simulate a completion event → should chime once
```

## Why it's split this way

**Sound can only come from the renderer process.** Playing audio in the host means either spawning a PowerShell/player process (hundreds of milliseconds of cold start, plus process reaping to manage), or using Electron's `shell.beep()` (no choice of tone). Web Audio is zero-dependency, zero-latency, cross-platform, and can synthesize tones on the fly.

**The decision can only live in the host.** The `api-session/status` the client receives is a boolean, so it can't show whether this turn ended normally or someone pressed stop; the `turn/end` reason and the `user/message` source exist only on the host event bus.

## Files

| File | Purpose |
|---|---|
| `lib/index.js` | Host: completion decision + the four routes `/dsh-turn-chime/{events,diag,log,clear}` |
| `lib/client.js` | Client: SSE subscription, Web Audio synthesis, settings panel, diagnostics reporting |
| `cordis.patch.yml` | Bundle patch; a single insert line activates the plugin |
| `install.mjs` | Idempotent install script |
| `test/test-logic.mjs` | Decision-logic tests (replays event sequences against a fake ctx) |

## Tests

```powershell
node test/test-logic.mjs   # or npm test
```

Covers six scenarios: normal finish → chime; user interrupt → silent; time-context injection only → silent; one message with two drivers → chime once; error → silent; interrupt followed by a new message that finishes → chime.

## Known limitations

- The chime only plays in the browser renderer process, so there is no sound while DSH is fully closed.
- The decision depends on DSH internal events (`session/event`, `agent/status`). If their shape changes in a major DSH upgrade, `lib/index.js` needs a matching update.
- It only chimes on `reason.kind === "completed"`; a turn that errors out is silent. To make errors ring as well (with a different sound), change `CHIME_REASON` in `lib/index.js`.

## License

MIT
