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
injection (pane targets use the `=name:` exact-match form; named keys such as
arrows go through the `KEYS` whitelist in `server.mjs`). Session and Claude
version detection read `/proc`, which is why this is Linux-only.

The client is a list → detail UI: `#rows` in the list pane, one `#detailBody`
for the selected session, `data-view` on the shell switching panes on narrow
screens and a media query showing both on wide ones. Selection lives in the
URL hash so back/forward and reloads behave.

The peek filter in `server.mjs` (`peek()` / `isChromeFooter()`) strips Claude
Code's TUI chrome and infers status from rendered text — it is inherently
sensitive to Claude Code's TUI layout. If peeks turn noisy or status detection
misbehaves after a Claude Code update, that's where to look.

Session rollover (the **fresh** button) leans on a second internal Claude Code
surface: `~/.claude/sessions/<pid>.json`, which maps a running process to its
transcript UUID. `sessionUuid()` validates it (cwd match, process start time)
and refuses rather than guesses — if rollover starts failing with "could not
identify the session transcript" after a Claude Code update, that file's
schema is the suspect.

Warm handoff (`handoffTick()`, once a minute) adds a third: the transcript
JSONL itself. `readTail()` reads only the last 256 KB and takes the last
non-sidechain, non-synthetic `assistant` record's `timestamp` and `usage`
(idle time and context size) and the `user` records that carry a `promptId`
and a human or absent `origin` (real prompts — tool results, task
notifications and `isMeta` skill text are not). `promptDraft()` reads the input
box between the last two `─` rules from an escaped capture, ignoring dim
suggestion text. If either format shifts, the feature goes quiet rather than
misfiring: a missing record or an unfound input box means no send.

Accounts: Claude Code keeps credentials, `sessions/` and `projects/` under
`CLAUDE_CONFIG_DIR` (default `~/.claude`). `processConfigDir()` reads that one
variable from `/proc/<pid>/environ` (everything else is discarded) and caches
it per pid; `sessionUuid()`, `projectDir()` and `hasConversation()` take the
session's own account home, so rollover, warm handoff and the rolling restart
work in any account. The rolling restart and reboot restore pin the session's
old account; a new session gets whatever the zsh login shell sets, which
`cachedActiveAccount()` reads the same way (`zsh -lc`, cached 10 s, refreshed
in the background, never spawned for a single-account setup). `reopen()` runs
every check that can fail first, then kills an idle session and recreates it
under the same name in the active account: `--resume <uuid>` for a small
context the new account can see, otherwise fresh plus the restore command once
`waitForPrompt()` sees an empty input box. A failed relaunch is retried once
in the old account. `accounts.list`, `use`, `dir` and `add` run programs, so
only the config file on disk sets them; `saveConfig()` ignores the client's
values and takes only `accounts.labels` (display names) from it.

Account management is optional and stays a no-op without a working account
tool. `accountsAvailable()` is true only once `accounts.list` has run cleanly
for the current config; until then the accounts tab is hidden and no `dir`,
`auth status` or login process is spawned. A failing `list` is logged once per
config and retried every five minutes. The same run builds the dir → name map
(`accounts.dir` per name) that `accountName()` uses for badges and the active
account, falling back to `accountLabel()`. `authStatus()` runs `claude auth
status` per config dir, cached 60 s, and only `loggedIn`, `email` and
`subscriptionType` leave the server. Login runs `claude auth login --claudeai`
(with `BROWSER=true`) in a tmux session named `muxboard-login-<name>`, which
`listSessions()` skips, so the list, rolling restart, snapshot, restore and
warm handoff never see it; a server holding only login sessions reports
`tmuxRunning: false`, so a login after a reboot can't overwrite the restore
offer. Login sessions with no entry in `logins` are killed by `listSessions()`,
and all of them at startup. The session routes refuse them and
`createSession()` refuses the prefix. The sign-in code is a secret:
`pasteSecret()` hands it to `tmux load-buffer` on stdin (never in an argv) and
pastes it, failures get fixed messages, any pane line holding part of it is
dropped, and it is never logged or stored.

User-tailored settings (repo roots, send-key shortcuts) belong in
`~/.config/muxboard/config.json`, never hardcoded — the app has a settings
sheet for editing them. That file is sent to the client on every poll, so
nothing secret may go in it: the optional password hash and session secret live
in `auth.json` beside it, mode 0600, and are never serialised into a response.

## Testing UI changes

`node scripts/demo.mjs` serves the real UI backed by invented sessions on
port 8801, so the frontend can be exercised without touching live sessions.
