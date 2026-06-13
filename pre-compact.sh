#!/usr/bin/env bash
# PreCompact hook — fires right before Claude Code compacts the conversation.
# Deterministic backstop: snapshot the full, uncompressed transcript to local
# disk (which is immune to compaction) and, if configured, ping the memory
# server. Always exits 0 so it can never block or interfere with compaction.

INPUT="$(cat)"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="$PROJECT_DIR/.claude/state"
RECOVERY_DIR="$STATE_DIR/recovery"
MEMORY_SERVER_URL="${MEMORY_SERVER_URL:-}"
mkdir -p "$RECOVERY_DIR"

# Pull a string field out of the stdin JSON. Uses jq when present, otherwise a
# best-effort grep/sed fallback so the hook still works without jq installed.
extract() { # extract <json> <key>
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -r --arg k "$2" '.[$k] // empty'
  else
    printf '%s' "$1" \
      | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
      | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
  fi
}

TRANSCRIPT="$(extract "$INPUT" transcript_path)"
SESSION_ID="$(extract "$INPUT" session_id)"
STAMP="$(date +%Y%m%d-%H%M%S)"
SNAPSHOT="$RECOVERY_DIR/transcript-$STAMP.jsonl"

# 1. Snapshot the uncompressed transcript — nothing is lost even if the model's
#    own scratchpad was stale at the moment compaction fired.
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  cp "$TRANSCRIPT" "$SNAPSHOT" 2>/dev/null || true
fi

# 2. Keep only the 5 newest snapshots (bounded growth, archive-then-GC).
ls -1t "$RECOVERY_DIR"/transcript-*.jsonl 2>/dev/null \
  | tail -n +6 | while read -r f; do rm -f "$f"; done

# 3. Update the pointer that session-start.sh reads on wake-up.
printf '{ "session_id": "%s", "snapshot": "%s", "at": "%s" }\n' \
  "$SESSION_ID" "$SNAPSHOT" "$STAMP" > "$STATE_DIR/latest-recovery.json"

# 4. Optional best-effort sync to the memory server (short timeout, never fatal).
if [ -n "$MEMORY_SERVER_URL" ]; then
  curl -fsS -m 5 -X POST "$MEMORY_SERVER_URL/checkpoint" \
    -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"$SESSION_ID\",\"reason\":\"pre_compact\",\"snapshot\":\"$SNAPSHOT\"}" \
    >/dev/null 2>&1 || true
fi

exit 0
