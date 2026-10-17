# Claude Code hooks probe

The scripts behind `docs/claude-hooks-observed.md` (Phase V0 of the pipeline v2 plan). They drive the interactive `claude` TUI through a Python `pty` and record what inline `--settings` hooks, an inline stdio MCP server (`mcp_server.py`), the statusLine command and `--resume` actually do.

Rerun them after a Claude Code update, before trusting the pipeline v2 bridge on the new version.

- They always use `CLAUDE_CONFIG_DIR=~/.claude-account1` and `--model haiku`, set only launch flags, and never edit a settings file.
- `driver.py` removes inherited `CLAUDE*` variables (except `CLAUDE_CONFIG_DIR`); without that, Claude writes no session log.
- Run one test at a time from this folder, e.g. `python3 t1.py`. Raw output goes to `logs/` (not committed).
