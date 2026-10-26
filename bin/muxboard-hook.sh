#!/bin/sh
# Claude Code hook: report this session's state to Muxboard. Registered for
# SessionStart, UserPromptSubmit, PostToolUse, Notification, Stop and
# SessionEnd. Prints nothing (stdout from some hooks reaches the model) and
# always exits 0, so a missing Muxboard never disturbs a session.
[ -n "$TMUX_PANE" ] || exit 0
sock="${XDG_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/muxboard}/muxboard.sock"
[ -S "$sock" ] || exit 0
pane=$(printf %s "$TMUX_PANE" | sed 's/%/%25/')
# Only three fields leave: a PostToolUse payload carries the tool's whole output.
jq -c '{hook_event_name, session_id, notification_type}' 2>/dev/null |
  curl -s -m 1 --unix-socket "$sock" -H 'Content-Type: application/json' \
    --data-binary @- "http://muxboard/event?pane=$pane" >/dev/null 2>&1
exit 0
