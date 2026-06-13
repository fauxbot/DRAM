#!/usr/bin/env bash
# SessionStart hook — runs when a session starts, resumes, or wakes after a
# compaction. On compact/resume it tells the freshly-woken model to re-hydrate
# its working state BEFORE doing anything else, and inlines the scratchpad so
# the state is present immediately. On a clean startup it does nothing.
#
# Output: hookSpecificOutput.additionalContext is silently injected into the
# model's context (Claude Code 2.x). Falls back to plain stdout (also injected
# for SessionStart) when jq is unavailable. Always exits 0.

INPUT="$(cat)"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="$PROJECT_DIR/.claude/state"
SCRATCHPAD_FILE="$STATE_DIR/scratchpad.md"

if command -v jq >/dev/null 2>&1; then
  SOURCE="$(printf '%s' "$INPUT" | jq -r '.source // "startup"')"
else
  SOURCE="$(printf '%s' "$INPUT" \
    | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [ -z "$SOURCE" ] && SOURCE="startup"
fi

# Only re-hydrate when waking into ongoing work. A fresh startup needs nothing.
case "$SOURCE" in
  compact|resume) ;;
  *) exit 0 ;;
esac

DIRECTIVE="You are resuming a task after a context ${SOURCE}; the conversation history was summarized and may be lossy. Before ANY other action, re-hydrate your working state: if the memory tool is connected, call restore(); always read .claude/state/scratchpad.md. Re-establish the task, the decisions already made, and the current step from that state before continuing. Do not re-plan or re-decide anything already recorded."

SCRATCH=""
[ -f "$SCRATCHPAD_FILE" ] && SCRATCH="$(cat "$SCRATCHPAD_FILE")"

if [ -n "$SCRATCH" ]; then
  CONTEXT="$DIRECTIVE

--- Current working state (.claude/state/scratchpad.md) ---
$SCRATCH"
else
  CONTEXT="$DIRECTIVE"
fi

if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$CONTEXT" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
else
  printf '%s\n' "$CONTEXT"
fi

exit 0
