# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-16

Initial release of Agy Monitor for SwiftBar and xbar on macOS, monitoring Antigravity (`agy`) and Jetski (`jetski`) sessions across desktop IDE, interactive CLI, headless runs, subagents, and native swarms with zero runtime npm dependencies.

### Added

- **Multi-root session discovery** across `~/.gemini/jetski`, `~/.gemini/antigravity`, and `~/.gemini/antigravity-cli` (plus `AGY_MONITOR_DIRS`), using read-only `node:sqlite` and `bun:sqlite` queries with `PRAGMA table_info` schema projection, `SQLITE_BUSY` cached-summary fallback, and offline-only `?immutable=1` fallback.
- **Three-state liveness verification** (`working`, `open`, `closed`) combining a non-blocking `lsof -b` open file-descriptor scan (with a 15-second `presence.json` TTL cache) and descendant `not_fully_idle` / `CASCADE_RUN_STATUS_RUNNING` rollup, plus a 600-second headless run fallback.
- **Parent-child tree rollup** linking delegated subagents and native swarm workers to their root coordinator via `parent_conversation_id`, `.system_generated/swarm/members.json`, and `group_id` so worker UUIDs do not clutter `Other Sessions` while remaining clickable to pin.
- **Incremental 1 MiB byte-range `transcript.jsonl` parser and on-disk cache** in `~/.gemini/.agy-monitor-cache/`, preserving multi-byte UTF-8 sequences across chunk boundaries and tracking live and peak context tokens, prompt-cache hit ratio, input/cached/output token totals, `CHECKPOINT` compactions, user/assistant turns, and step-reconciled `pendingTools`.
- **Sandbox block vs tool failure separation** distinguishing macOS Seatbelt permission denials (`BypassSandbox` retries) from genuine command and tool errors, alongside `ERROR_MESSAGE` API and quota alerts.
- **Allow-listed model resolution** reading swarm member configs, `gen_metadata` protobuf blobs in per-conversation SQLite stores (cached by `step_count`), and CLI `settings.json` fallbacks.
- **Workspace and customization panels** covering Git `.git/HEAD` and worktree branches, CitC clients, Markdown session artifacts and GFM checklists, native swarm rosters and board lag, subagents, skills, agent inbox messages, background task logs, repository and global rule files, active hooks, and enabled, working MCP servers.
- **SwiftBar output sanitization** routing all menu lines through `emit()` and `sanitizeParam()` to replace literal `|` delimiters in labels with `│` and strip control characters, quotes, and backslashes.
- **Wrapper, installer, release tooling, and hermetic test suite** (`scripts/agy-monitor.5s.sh`, `install-menubar.sh`, `uninstall-menubar.sh`, `release-notes.sh`, and `test/agy-menubar.test.ts`).

[Unreleased]: https://github.com/eggboy/agy-monitor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eggboy/agy-monitor/releases/tag/v0.1.0
