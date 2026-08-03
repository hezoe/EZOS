# EZOS

🌐 **English** ・ [日本語](README.ja.md)

**Your own personal cockpit for running Claude Code from a browser.** With passkey authentication, you can drive `claude` interactively on your VPS from any device's browser — PC or phone.

> **EZOS** is the name of the whole app. It has three modes inside:
> **EZterminal** (terminal) / **EZbrowser** (built-in file manager) / **EZeditor** (file editing).
> To install it on a new server, see **[docs/manual/install.en.html](docs/manual/install.en.html)** (or [INSTALL.md](docs/INSTALL.md)) — hand the repo to Claude Code and it can set things up almost automatically.

- 🖥 **EZterminal**: xterm.js + WebSocket + node-pty + tmux. Your browser becomes the VPS terminal itself, where you run `claude` interactively. Sessions persist through tmux even after disconnects, and PC/phone can attach to the same session. File paths printed in the terminal or by Claude are **clickable and open directly in EZeditor** (works with the input toggle on or off; text selection-copy works too — hold Alt when you want to report the mouse to the app).
- 🔑 **Authentication**: WebAuthn passkeys (works with 1Password, etc.). The first registration requires a one-time unlock on the server (break-glass).
- 📱 **Mobile-optimized**: server-side UA detection switches the layout (`?view=mobile|desktop|auto`).
- 🌐 **Multilingual UI**: Japanese / English / Hebrew (with RTL), switchable from the ☰ menu.

## Documentation / Manual

- 📖 **User manual (multilingual: English / 日本語 / עברית)**: [docs/manual/index.html](docs/manual/index.html)
  Covers why EZOS exists, how every part of the GUI works, and the system architecture. You can also open it in-app from the header **☰ → Help & Manual** in your chosen language. After cloning from GitHub, the `docs/manual/*.html` files are self-contained and viewable directly (`file://`).
- 🛠 **Installation guide (separate booklet: English / 日本語 / עברית)**: [install.en.html](docs/manual/install.en.html) / [install.ja.html](docs/manual/install.ja.html) (Markdown version: [docs/INSTALL.md](docs/INSTALL.md))

## Requirements (in brief)

- **Server (host)**: Linux with systemd (verified on Debian 12/11; Ubuntu, etc. expected to work), Node.js 20+, **tmux** (required), `git`, a reverse proxy for TLS (**Caddy** recommended), and **Claude Code CLI installed globally and signed in with a Pro/Max account**. Public use needs a hostname + DNS, since passkeys require an HTTPS secure context.
- **Client (browser)**: a modern browser with WebAuthn/passkey support (Chrome / Edge / Safari / Firefox), over HTTPS.

See the [installation guide](docs/manual/install.en.html) for the full, detailed requirements.

## Architecture

Each installation is made of **one Node app + a systemd service + a Caddy site definition**. The table below is a reference deployment example from this repository (values differ per installation; the real values live in `app/data/config.json` and on the systemd/Caddy side).

| Item | Example |
|---|---|
| Repository | `github.com/hezoe/EZOS` |
| App | `app/` (Node 20, `type:module`) |
| systemd service | `ezos` (WorkingDirectory launches the working tree's `app/` directly) |
| Listen (localhost) | `127.0.0.1:3100` |
| Public domain | `ezos.example.com` (Caddy reverse-proxies, certificate automatic) |
| Auth config | `rpID` / `origin` / `port` / `setupKey` kept in `app/data/config.json` |

- **Data**: `app/data/*.json` (no database; excluded via `.gitignore`). `config.json` holds runtime settings such as the setup key.
- **Claude Code**: a global install + Pro/Max account authentication (`~/.claude/.credentials.json`) is assumed.

```
app/
  server.js        HTTP/WS server, routing, page rendering (UA detection)
  setup.js         initial setup (generates config.json, issues a setup key; values via env vars)
  lib/store.js     JSON storage, config loading
  lib/term.js      WebSocket <-> pty (tmux) bridge
  lib/termstate.js reads tmux session state
  lib/filemgr.js   backend for EZeditor (file operations)
  bin/ez-hook.sh   Claude Code hook -> heartbeat (target port taken from config.json)
  public/          frontend: EZterminal=term.js / EZbrowser=ezbrowser.js /
                   EZeditor=ezeditor.js (+ syntax highlighter ezhl.js, ezeditor.css) /
                   i18n.js, menu.js, tooltip.js, app.css, app.js, etc.
```

## Install / Deploy

- **New server**: see **[docs/manual/install.en.html](docs/manual/install.en.html)** (or [docs/INSTALL.md](docs/INSTALL.md)). It summarizes the values to confirm up front (IP, public hostname, DNS, passkey device, port/service name) and, given the repo, Claude Code can install it interactively and almost automatically.
- **Updating an existing instance**: edit the working tree directly → `sudo systemctl restart <service>` to apply → commit/push. When adding dependencies, run `cd app && npm install --omit=dev` then restart.

## Session state mapping (hook → state)

| Hook | State |
|--------|------|
| SessionStart / Stop | ⏳ idle |
| UserPromptSubmit / PostToolUse | ⚙️ working |
| PreToolUse (Bash-like) | ▶️ running |
| PreToolUse (other) | ⚙️ working |
| Notification | 🔔 waiting_user |
| SessionEnd | removed |
| working/running with no response for 6 min | 🛑 stopped (derived) |

## License

Released under the [MIT License](LICENSE). You are free to use, modify, and redistribute it. See the `LICENSE` file for details.
