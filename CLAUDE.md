# muxboard

A zero-dependency Node server (`server.mjs`) plus a vanilla PWA (`public/`) that
manages Claude Code sessions living in tmux. No build step — the server serves
the working tree directly.

## Ship a change

1. Edit. For any frontend change (`public/`), bump `VERSION` in `public/sw.js` —
   installed PWAs cache the app shell, and users pick up the new version by
   closing and reopening the app once.
2. Restart however the deployment runs it (commonly
   `systemctl --user restart muxboard`).
3. Commit.

If this repo is deployed as a systemd user service that spawns tmux, the unit
must keep `KillMode=process`. Without it, restarting the service kills the tmux
server in its cgroup — and with it every running Claude session.

## How it works

Each session is one tmux session running `claude --remote-control` (details in
README.md). The server drives everything through the tmux CLI: `list-panes` for
discovery, `capture-pane` for the terminal screen, `send-keys` for input
injection (pane targets use the `=name:` exact-match form). Session and Claude
version detection read `/proc`, which is why this is Linux-only.

The peek filter in `server.mjs` (`peek()` / `isChromeFooter()`) strips Claude
Code's TUI chrome and infers status from rendered text — it is inherently
sensitive to Claude Code's TUI layout. If peeks turn noisy or status detection
misbehaves after a Claude Code update, that's where to look.

User-tailored settings (repo roots, send-key shortcuts) belong in
`~/.config/muxboard/config.json`, never hardcoded — the app has a settings
sheet for editing them.

## Testing UI changes

`node scripts/demo.mjs` serves the real UI backed by invented sessions on
port 8801, so the frontend can be exercised without touching live sessions.

If a `CLAUDE.local.md` exists next to this file, read it too — it holds
deployment specifics for this particular machine.
