# Compaction-survival hooks for Claude Code

Two hooks snapshot state before Claude Code compacts and re-hydrate it afterward.
Works today with zero server using local files. The DRAM MCP server is an optional
upgrade that the same hooks sync to once running.

## Files and where they go

- `pre-compact.sh`   -> `.claude/hooks/pre-compact.sh`
- `session-start.sh` -> `.claude/hooks/session-start.sh`
- `settings.json`    -> merge the `hooks` block into `.claude/settings.json`

## Install

1. Copy the files into the layout above.
2. Make the hooks executable:

   ```
   chmod +x .claude/hooks/pre-compact.sh .claude/hooks/session-start.sh
   ```

3. Restart Claude Code, then run `/hooks` to confirm both are registered.

Prerequisites: `bash` and `curl`. `jq` is recommended (cleaner JSON output) but
not required — the scripts fall back to a jq-free path.

## How it works

- `pre-compact.sh` (PreCompact, matcher `auto`) snapshots the full uncompressed
  transcript into `.claude/state/recovery/` before automatic compaction and keeps
  the 5 newest. Local disk is immune to compaction — that is the backstop.
- The model maintains `.claude/state/scratchpad.md` itself (per `CLAUDE.md`):
  distilled task, decisions, current step. Because it's a file, it survives.
- `session-start.sh` (SessionStart, sources `compact`/`resume`) injects a
  directive telling the freshly-woken model to re-read `scratchpad.md` — and call
  `restore()` if the DRAM server is connected — before doing anything, and
  inlines the scratchpad so the state is present immediately. On a clean startup
  it stays silent.

## Optional: wire the DRAM MCP server

Point the hooks at the server so they sync to it:

```
export MEMORY_SERVER_URL="http://localhost:3577"
```

The hooks will POST snapshot metadata to the server on compaction and fetch
scratchpad state on resume.

If `MEMORY_SERVER_URL` is unset, the hooks use local files only and are fully
functional.

## Test it

- Run `/compact`, or let the context fill until auto-compaction fires, then check:
  - a new file appears under `.claude/state/recovery/`
  - on the next turn, the re-hydration directive plus your `scratchpad.md`
    contents show up in context (run with `--verbose` or inspect the transcript
    to see injected context)
- Note: the PreCompact hook is matched to `auto`; a manual `/compact` may not
  fire it on some versions. Change the matcher to `manual` (or remove it) to
  cover both.

## Caveats

This is a large reliability boost, not the API's hard guarantee. On Claude Code
you cannot mark content "do not summarize," the hook cannot force the model to
act mid-compaction, and post-compaction re-reading is occasionally missed even
with the directive. The durability comes from keeping the real state on disk and
re-reading it, not from trusting the summary.
