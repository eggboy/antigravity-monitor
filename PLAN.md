# Agy Monitor Implementation Plan

## Goal

Build `agy-monitor`, a macOS SwiftBar and xbar menu bar plugin that displays real-time session status across Antigravity (`agy`) and Jetski (`jetski`), modeled on [`eggboy/copilotcli-monitor`](https://github.com/eggboy/copilotcli-monitor). The plugin covers desktop IDE conversations, interactive CLI sessions, `agentapi` headless runs, subagents, and native swarms across `~/.gemini/jetski`, `~/.gemini/antigravity`, and `~/.gemini/antigravity-cli` with zero runtime npm dependencies.

## Acceptance Criteria

1. Discovers sessions across all existing `~/.gemini/{jetski,antigravity,antigravity-cli}` directories (plus `AGY_MONITOR_DIRS` override) and classifies each root session as `working`, `open` (idle in a live process), or `closed` without trusting stale lock files or crashed SQLite rows.
2. Completes a warm refresh inside `main()` in under 80 ms, and under 180 ms end-to-end (`scripts/agy-monitor.5s.sh` including bash wrapper + Node TypeScript startup + `lsof`), on a machine with 800+ historical conversations across three SQLite stores.
3. Tail-reads `transcript.jsonl` incrementally by `(inode, size, mtimeMs, lastOffset)` and caches derived stats, schema column sets, presence snapshots, and model names under `~/.gemini/.agy-monitor-cache/`.
4. Renders the core session view end-to-end first (workspace, git/CitC branch, surface tag, title, model, active duration, live context-window fill, token breakdown, compactions, turns, tool calls, `Other Sessions`, and `pin`/`unpin`), followed by conditional enrichment panels (API/quota alerts, sandbox blocks vs genuine tool failures, artifacts/checklists, native swarm roster and board lag, subagents, inbox, skills, background tasks, and rules/hooks/MCP).
5. Sanitizes every SwiftBar output label through a single `emit()` function that replaces `|` with `│` (`U+2502`) and strips `\p{Cc}` control characters, and sanitizes all `bash=` / `paramN=` values.
6. Rolls child subagents and swarm workers under their root session (`parent_conversation_id`, `swarm/members.json`, and `group_id`) so worker UUIDs never flood `Other Sessions`, while allowing click-to-pin on any child worker.
7. Passes `eslint`, `tsc --noEmit`, `shellcheck`, and hermetic `node --test` unit tests (running inside the standard sandbox via `AGY_MONITOR_DIRS` and `AGY_MONITOR_STATE_DIR` fixtures) covering UTF-8 chunk boundaries, stale lock rejection, `lsof` timeout fallback, pending-tool queue reconciliation, WAL read-only handling, swarm/subagent rollup, and SwiftBar pipe/newline injection safety.

---

## Reference Repo Review (`eggboy/copilotcli-monitor`)

`copilotcli-monitor` (`v1.1.0`, 1,629 lines in `scripts/copilot-menubar.ts` plus four shell scripts) establishes a tight architecture that `agy-monitor` preserves:

- **Two-layer execution (`copilot-monitor.5s.sh` -> `copilot-menubar.ts`)**: SwiftBar runs the bash wrapper every 5 seconds. The wrapper adds Homebrew and user bin directories to `PATH`, resolves symlinks back to the source checkout, exports `COPILOT_MENUBAR_PLUGIN` so click actions re-enter through the wrapper, probes runtimes, and exits `0` with a rendered diagnostic menu on missing dependencies so SwiftBar never shows an unformatted error badge.
- **Zero runtime `node_modules`**: All runtime imports come from Node/Bun built-ins (`node:fs`, `node:path`, `node:os`, `node:module`, `node:url`, `node:child_process`, `node:sqlite` / `bun:sqlite`). Dev dependencies (`eslint`, `typescript`, `typescript-eslint`, `@types/node`) exist strictly for linting and type-checking.
- **Incremental byte-range log parser (`parseEventsRange`)**: Reads JSONL logs in 1 MiB `Buffer` chunks starting at `cache.lastOffset`, splits on `0x0a` (`\n`) so multi-byte UTF-8 characters are never torn across chunk boundaries, and persists `(inode, size, mtimeMs, lastOffset, stats)` per session.
- **Live PID verification over lock-file existence**: Validates lock state against live OS processes rather than trusting files left behind by abnormal exits.
- **Single output choke point (`emit`)**: SwiftBar and xbar split each line at the first literal `|` with no escape syntax. `emit()` substitutes `│` in labels and strips control characters so session text cannot inject `bash=` actions or extra menu rows.
- **Import guard and error boundary**: `isEntrypoint` allows importing the module in tests without triggering `main()`, and a top-level `try/catch` renders a compact fallback menu with `Refresh` and the plugin version if `main()` throws.
- **Release hygiene**: `npm version <patch|minor|major>` runs `lint` + `typecheck`, syncs `<xbar.version>` in the shell wrapper, and extracts verbatim unwrapped paragraphs from `CHANGELOG.md` via `scripts/release-notes.sh`.

---

## Departures from `copilotcli-monitor`

> [!IMPORTANT]
> Per reference-implementation rules, every architectural departure from `copilotcli-monitor` is listed below before any code is written.

| Area | `copilotcli-monitor` | `agy-monitor` | Reason for Departure |
| :--- | :--- | :--- | :--- |
| **Runtime probe order** | `bun` -> `tsx` -> `npx tsx` | `node` (v22.18+ / v24+ native TS) -> `bun` -> `tsx` -> `npx tsx` | This machine runs Node `v26.13.0` with native TypeScript type-stripping and built-in `node:sqlite` (`DatabaseSync`), without `bun` or global `tsx`. Probing `node` (>= 22.18) first avoids a slow `npx --yes tsx` spawn every 5 seconds while preserving `bun` support. |
| **State roots** | Single `~/.copilot/session-state/` | Multi-root `~/.gemini/{jetski,antigravity,antigravity-cli}` + `AGY_MONITOR_DIRS` | Agy and Jetski partition desktop IDE, internal Jetski, and standalone CLI sessions into separate `<appDataDir>` directories that run concurrently on the same Mac. |
| **Session index & metadata** | Per-session `workspace.yaml` + directory scan | `<appDataDir>/conversation_summaries.db` (`conversation_summaries` table) + `.git/HEAD` / `.citc` | Agy/Jetski maintains an indexed SQLite table with `title`, `status`, `source`, `not_fully_idle`, `killed`, `parent_conversation_id`, `nesting_depth`, `agent_name`, `workspace_uris`, and `last_modified_time` (~1 ms per root). Git branch is read directly from `.git/HEAD` (no `git` subprocess). |
| **Liveness model** | Binary (`hasLock` via `inuse.<pid>.lock` filename PID) | Three-state (`working`, `open`, `closed`) via `lsof -b` open-FD map + SQLite tree status + cached TTL fallback | `<appDataDir>/presence/<convId>.lock` files are 0-byte files without PIDs in their names, and closed sessions leave `.lock` files behind (131 of 138 files in `jetski/presence` are historical). One `lsof -b -w -n -P -a -c '/^(jetski\|agy\|language_)/' -F pcn` call (~45 ms) maps open `.lock` FDs to live PIDs and process names (`jetski-cli`, `language_server`, `agy`). Intersecting open root locks with `not_fully_idle = 1` / `CASCADE_RUN_STATUS_RUNNING` across the root and its descendants separates active runs (`working`), idle open sessions (`open`), and closed/crashed sessions (`closed`). |
| **Context window & token accounting** | Cumulative `outputTokens` + subagent tokens only (context meter removed in `1.0.1`) | Live context window (`input_tokens + cache_read_tokens` on latest `PLANNER_RESPONSE`) + cache-hit % + compaction count (`CHECKPOINT`) + cumulative `input` / `cache_read` / `output` + child rollups | Every `PLANNER_RESPONSE` row in `transcript.jsonl` carries `input_tokens`, `cache_read_tokens`, and `output_tokens`, and `CHECKPOINT` rows mark compactions, enabling an exact live context meter from turn 1. |
| **Cost / billing** | Dollar & AIC totals from `~/.copilot/session-store.db` (`assistant_usage_events`) | Omitted as dollar figures; replaced by token/cache breakdown + quota/API error surfacing (`RESOURCE_EXHAUSTED`, `[quota]` warnings) | Agy and Jetski do not write local per-request billing rows on disk (Jetski draws from internal quota pools; Antigravity uses plan quotas). Reporting unverified estimated dollars would break `copilotcli-monitor`'s rule of reporting real billing units only. |
| **Subagents & Swarms** | `subagent.started` / `subagent.completed` events in parent log | `.system_generated/subagents/*.json` + `.system_generated/swarm/{swarm.json,members.json,board.jsonl}` + child `transcript.jsonl` rollup; children hidden from `Other Sessions` by default | Agy/Jetski spawns child conversations for `invoke_subagent` and native `swarm` workers (`nesting_depth >= 1`, `parent_conversation_id`). Rolling children under their coordinator keeps `Other Sessions` clean while surfacing worker phase, model, board sequence lag, and per-worker tokens/calls. |
| **Todos & Artifacts** | `todos` table in per-session `session.db` | Session Markdown artifacts (`<brain>/<convId>/*.md` + `*.md.metadata.json`) and workspace `PLAN.md` / `task.md` checkbox counts (`- [ ]`, `- [/]`, `- [x]`) | Agy/Jetski agents persist plans, checklists, and reports as Markdown files in `brain/<convId>/` (with `.metadata.json` sidecars) or the workspace rather than a SQLite `todos` table. |
| **Inbox & Background Tasks** | `inbox` table in `session.db` + `pendingTools` | `.system_generated/messages/*.json` + `read.json` + `.system_generated/tasks/task-*.log` + step-reconciled pending tools | Agent messages and background shell/schedule tasks live as JSON/log files under `.system_generated/`. |
| **Tool failure classification** | Single `toolFailures` counter and list | Split into `toolFailures` (code/command errors) and `sandboxBlocks` (`BypassSandbox` / Seatbelt denials) + `apiErrors` (`ERROR_MESSAGE`) | Seatbelt sandbox denials (`operation not permitted` prompting a `BypassSandbox` retry) are normal permission boundaries in Agy/Jetski rather than broken commands; separating them prevents false failure alarms. |
| **Instructions, Hooks & MCP** | `.github/copilot-instructions.md`, `CLAUDE.md`, `hook.start/end`, `session.info` MCP | `AGENTS.md`, `GEMINI.md`, `_agents/rules/*.md`, `.agents/rules/*.md`, `~/.gemini/config/{AGENTS.md,hooks.json,mcp_config.json}`, `<appDataDir>/mcp/*`, and CitC/Piper awareness | Matches the Jetski Customization System discovery hierarchy. |

---

## Verified Local Data Sources & Schemas

Empirical inspection on this machine verified the exact storage layout across all three roots:

### 1. App-Data Roots (`~/.gemini/<root>`)

- `~/.gemini/jetski`: Jetski desktop IDE and `jetski` CLI.
- `~/.gemini/antigravity`: Antigravity desktop app (`Antigravity.app` `language_server`) and `agy --hub` (`daemon/hub_<port>.json` holds `{ pid, httpsPort, httpPort, lsVersion }`).
- `~/.gemini/antigravity-cli`: Standalone `agy` CLI.

### 2. Cross-Session Summary Store (`<root>/conversation_summaries.db`)

- **Live WAL handling**: Open with `new DatabaseSync(path, { readOnly: true })` (or `bun:sqlite` `{ readonly: true }`), which reads active `-wal` frames via shared `-shm` locks in `0.6-1.3 ms` per root.
- **Avoid stale `?immutable=1` reads on live roots**: SQLite `immutable=1` ignores the `-wal` file and would serve stale `status` / `not_fully_idle` values if a host process is actively writing. Reserve `file:${path}?immutable=1` strictly as a fallback when `lsof` shows **no** live host process for `<root>` (for example, an uncheckpointed DB without `-shm` on a read-only path). On `SQLITE_BUSY` when a host is live, fall back to the last cached summary snapshot (`summaries.json` in `CACHE_DIR`) rather than `immutable=1`.
- **Schema resilience**: Inspect `PRAGMA table_info(conversation_summaries)` on open and project only existing columns (defaulting missing optional columns) so upstream column additions or renames never crash the query:

```sql
SELECT
  conversation_id,
  title,
  step_count,
  last_modified_time,
  workspace_uris,
  status,
  source,
  project_id,
  agent_name,
  parent_conversation_id,
  nesting_depth,
  not_fully_idle,
  killed,
  group_id
FROM conversation_summaries
ORDER BY last_modified_time DESC;
```

Verified parent-child and liveness invariants:
- Both `invoke_subagent` children and native `swarm` workers (verified on `duck-impl`) write `parent_conversation_id = <coordinatorId>` and `nesting_depth = 1`. Root resolution walks `parent_conversation_id`, then supplements from `.system_generated/swarm/members.json` and shared `group_id` so forked or peer workers still attach to their coordinator.
- When a root session delegates to a subagent, the root row's `status` transitions to `CASCADE_RUN_STATUS_IDLE` while `not_fully_idle` stays `1`, and the active child row has `status = 'CASCADE_RUN_STATUS_RUNNING'`. Rolling `not_fully_idle` and `status` across all descendants keeps the root marked `working`.

### 3. Presence Locks (`<root>/presence/<convId>.lock`)

- Host processes (`jetski-cli`, `language_server`, `agy`) hold an open read/write file descriptor (`FD` mode `u`) on `<root>/presence/<rootConvId>.lock` while a session is open, and leave the 0-byte `.lock` file behind on exit.
- Run a single FUSE-safe call: `execFileSync('lsof', ['-b', '-w', '-n', '-P', '-a', '-c', '/^(jetski|agy|language_)/', '-F', 'pcn'], { timeout: 500 })` (`-b` avoids blocking on kernel/CitC FUSE mounts).
- Persist the parsed presence map in `~/.gemini/.agy-monitor-cache/presence.json` (`{ ts, locks, liveRoots }`). If `lsof` times out or exits non-zero because `-b` skipped a blocked kernel call, reuse `presence.json` when `Date.now() - ts < 15_000` so the menu bar icon never flickers to `closed`.
- Headless fallback (`agy --print` / `agentapi` runs without an interactive lock): treat a lockless root session as `working` when `liveRoots.has(root)` AND `status === 'CASCADE_RUN_STATUS_RUNNING'` AND any of (`last_modified_time`, `transcript.jsonl` mtime, or active `.system_generated/tasks/task-*.log` mtime) updated within the last 600 seconds.

### 4. Model Identifier (`<root>/conversations/<convId>.db` + Fallbacks)

`transcript.jsonl` omits the model name on `PLANNER_RESPONSE` rows. Model resolution uses a cached three-tier lookup:
1. **Swarm member config**: If the session appears in `.system_generated/swarm/members.json`, read `applied_model || model` (for example `gemini-4-carbon-high`, `opus-5.5-high`).
2. **Per-conversation `gen_metadata` table**: Query `SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1` in `<root>/conversations/<convId>.db` only when `step_count` advanced since the cached value. Scan printable UTF-8 strings in the protobuf `Uint8Array` against an explicit allow-list pattern (`/\b(?:Gemini|Claude|GPT)[- ][A-Za-z0-9 .()-]+|\b(?:gemini|claude|opus|fable|sonnet|gpt)-[a-z0-9.-]+(?:@[a-z0-9_-]+)?/i`), falling back to `unknown` rather than raw bytes if no allow-listed token matches.
3. **CLI settings fallback**: For brand-new 0-turn CLI sessions, read `<root>/cli/settings.json` (`model`) or `<root>/settings.json`.

### 5. Streaming Transcript (`<root>/brain/<convId>/.system_generated/logs/transcript.jsonl`)

Parsed incrementally via 1 MiB byte-range chunks (`parseTranscriptRange`):
- `USER_INPUT`:
  - Clear `pendingTools` (a new user or system wakeup turn means prior synchronous tool calls have settled).
  - If `content` contains `<SYSTEM_MESSAGE>` without `<USER_REQUEST>`, classify as an internal wakeup notification rather than a human user turn.
  - Otherwise increment `turnCount.user`, extract slash commands and explicitly invoked skills, and capture `<USER_REQUEST>` as the fallback session summary when `title` is empty.
- `PLANNER_RESPONSE`:
  - Clear any leftover synchronous `pendingTools` from prior steps before enqueueing the new step's `tool_calls[]` (preventing FIFO drift if an earlier tool call was cancelled without emitting a `GENERIC` row).
  - Increment `turnCount.assistant`; accumulate `input_tokens`, `cache_read_tokens`, `output_tokens`; update `currentContextTokens = input_tokens + cache_read_tokens` (when non-zero) and `peakContextTokens`.
  - Record each entry in `tool_calls[]`: increment per-tool call counts, detect skill reads (`.../skills/<skillName>/SKILL.md`), track MCP calls (`call_mcp_tool` or `mcp_<server>_<tool>`), and enqueue into `pendingTools` keyed by `(step_index, ordinal)`.
- `GENERIC` (`source: "MODEL"`):
  - Shift the head of the current step's `pendingTools` queue.
  - Detect backgrounded commands (`Tool is running as a background task`).
  - Detect `run_command` non-zero exit codes (`Command exited with code (\d+)`) and tool `error` fields / `status === "ERROR"`.
  - Separate Seatbelt sandbox blocks (`sandbox errors that may or may not`, `operation not permitted`, `Permission denied for read_file`) into `sandboxBlocks` vs genuine `toolFailures`.
- `CHECKPOINT`:
  - Increment `compactions`.
- `ERROR_MESSAGE`:
  - Clear `pendingTools` and record `error` (`RESOURCE_EXHAUSTED` / quota / API errors) in `apiErrors`.
- **Render-time `Running Now` guard**: Display `pendingTools` only when the session's liveness state is `working` and the step timestamp is within 10 minutes (or backed by a modified `.system_generated/tasks/task-*.log`), preventing phantom stuck tools on idle or interrupted sessions.

### 6. Subagents, Swarms, Inbox, Tasks & Artifacts (`<root>/brain/<convId>/`)

- **Subagents**: `.system_generated/subagents/<childId>.json` (`typeName`, `role`, `state`, `spawnStepIndex`), enriched with child `conversation_summaries` status and cached child `transcript.jsonl` stats (duration, tool calls, tokens).
- **Native Swarms**: `.system_generated/swarm/{swarm.json,members.json,board.jsonl}` -> member role, model, live phase (`RUNNING`, `WAITING`, `STOPPED`, `KILLED`), board `headSeq`, `[stall]` / `[done]` markers, and per-member unread lag (`headSeq - last_read_seq`).
- **Inbox**: `.system_generated/messages/<msgId>.json` + `read.json` + `undelivered/`, filtering `hideFromUser: true` internal board wakeups while surfacing agent messages with unread bolding and sender resolution.
- **Background Tasks**: `.system_generated/tasks/task-*.log` combined with backgrounded `run_command` / `schedule` calls.
- **Artifacts & Checklists**: `<root>/brain/<convId>/*.md` paired with `*.md.metadata.json` (`{ summary, updatedAt, userFacing }`), plus workspace `PLAN.md` / `task.md` GFM task counts (`- [ ]`, `- [/]`, `- [x]`).
- **Customizations, Hooks & MCP**: Repo rules (`AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `.cursorrules`, `_agents/rules/*.md`, `.agents/rules/*.md`) and global configs (`~/.gemini/config/{AGENTS.md,rules/*.md,hooks.json,mcp_config.json}`, `<root>/mcp/*`).

---

## Menu Bar UX & SwiftBar Layout

### Menu Bar Icon States

| Session State | Health | Menu Bar Display | Meaning |
| :--- | :--- | :--- | :--- |
| `working` | Healthy | Custom 18x18 monochrome Agy/Jetski mark (`templateImage=...`) + count when `> 1` working | At least one root session (or its child subagent/swarm worker) is actively executing |
| `working` | Problem | Warning glyph + count | Active session hit an `ERROR_MESSAGE` (quota/API failure) or repeated MCP failure |
| `open` (idle) | Recently active (< 5m) | Active-recent indicator (`size=14`) | Open in terminal/IDE, finished a turn within the last 5 minutes |
| `open` (idle) | Idle (>= 5m) | Idle-open indicator (`size=14`) | Session window/CLI is open and waiting on user input |
| `closed` | All closed | Neutral grey dot (`size=14`) | No live open Agy/Jetski sessions (dropdown still shows latest or pinned session) |

### Dropdown Structure

```text
[Menu Bar Icon]
---
[Workspace / Repo (branch)] · [Surface Badge: Jetski CLI | Antigravity CLI | Agy App]
[Conversation Title or First Request Summary]
[Model Display Name]
[Active Duration · Wall Age · Short ID (eb3b51bc…)]
---
[Tool calls total (N failed · M sandbox retries)]
[Context window: current ctx (peak · cache hit % · N compactions)]
[Tokens: total (in + cached + out + child subagents/swarm)]
[Turns: U user / A assistant]
---
[API / Quota Alerts]                  (rendered only when apiErrors > 0)
[Recent Tool Failures (last 5)]       (rendered only when genuine toolFailures > 0; submenu for sandbox blocks)
[Plan & Artifacts (X/Y tasks done)]   (rendered when session artifacts or PLAN.md checklists exist; clickable links)
[Swarm: <title> (working/waiting/killed · board #seq)] (rendered when .system_generated/swarm exists; click worker to pin)
[Subagents (active + recent completed)]                (rendered when subagents exist; click child to pin)
[Skills Invoked (timestamp + skill name)]              (rendered when skills > 0)
[Inbox (unread bolded)]                                (rendered when visible messages > 0)
[Background Tasks & Schedules]                         (rendered when tasks or schedules exist)
[Rules, Hooks & MCP]                                   (repo + global rules, active hooks, configured/used MCP servers)
[Running Now]                                          (active pending tool calls when session is working)
---
Open Workspace Folder                 (bash="open" param1="<workspacePath>")
Open Session Brain                    (bash="open" param1="<brainDir>")
Focus Antigravity                     (rendered when surface is Antigravity.app)
Refresh                               (refresh=true)
[Pinned: Reset to Auto]               (rendered when ~/.gemini/.agy-monitor-primary is set)
---
Other Sessions (up to 15 root sessions, sorted by working -> open -> closed, then recency)
  -- [status dot] [repo] · [surface] · [model]         (click to pin)
  --    [updated X ago · calls · ctx/tokens · title]
---
Agy Monitor v0.1.0                    (href to CHANGELOG.md)
```

---

## Caching, Performance Budget & Safety

### Refresh Budget

| Step | Mechanism | Measured / Target Time |
| :--- | :--- | :--- |
| Wrapper + Node startup | `agy-monitor.5s.sh` + `node --no-warnings scripts/agy-menubar.ts` | ~60-90 ms |
| Live FD & PID scan | Single `lsof -b -w -n -P -a -c '/^(jetski\|agy\|language_)/' -F pcn` (500 ms cap + TTL cache) | ~45 ms |
| SQLite summary scan | Read `conversation_summaries.db` across 1-3 roots (`node:sqlite` / `bun:sqlite`) | ~3 ms total |
| Primary + 15 other sessions stats | On-disk JSON cache in `~/.gemini/.agy-monitor-cache/<root>__<id>.json`; tail-read appended bytes only | ~5-15 ms warm |
| Model & metadata enrichment | Cached per `(convId, stepCount)`; `gen_metadata` read only when `step_count` changes | < 2 ms warm |
| Render & sanitize | In-memory string assembly + `emit()` | < 2 ms |
| **Total inside `main()`** | | **~55-65 ms (< 80 ms target)** |
| **Total end-to-end process** | | **~125-155 ms (< 180 ms target)** |

### Reliability, Security & Sandbox Invariants

1. **No writes or deletes inside `~/.gemini/{jetski,antigravity,antigravity-cli}`**: Open SQLite databases strictly with `{ readOnly: true }` (note SQLite takes standard shared read locks on `-shm` when reading live WAL databases; never write, checkpoint, or create files inside `<appDataDir>`). Store all plugin state under `~/.gemini/.agy-monitor-cache/` and `~/.gemini/.agy-monitor-primary` (overridable via `AGY_MONITOR_STATE_DIR`; `RESERVED_CACHE_FILES = new Set(['presence.json', 'summaries.json'])` protected from `pruneCache()`).
2. **SwiftBar injection prevention**: Route 100% of stdout lines through `emit(label, params)` and `sep()`. Replace all `|` in labels with `│`, strip all Unicode `\p{Cc}` control characters, and strip `"` and `\` from `sanitizeParam()` arguments.
3. **Erasable TypeScript syntax**: Enforce `"erasableSyntaxOnly": true` in `tsconfig.json` (no `enum`, `namespace`, or parameter properties) so `node scripts/agy-menubar.ts` executes directly on Node 22.18+ / 24+ / 26+ without transpilation, while remaining compatible with `bun` and `tsx`.
4. **Dev-time sandbox rules (for coding agents in Jetski/Antigravity)**:
   - Keep `npm test`, `npm run lint`, and `npm run typecheck` 100% inside the standard sandbox by pointing tests at temporary directories via `AGY_MONITOR_DIRS`, `AGY_MONITOR_STATE_DIR`, and an injected/mocked `lsof` runner (`AGY_MONITOR_LSOF_OUTPUT` or function injection).
   - Run live verification commands with `BypassSandbox: true` from the start: `npm install` (network), `lsof`, live reads against `~/.gemini/**`, and end-to-end smoke runs of `./scripts/agy-monitor.5s.sh` against real local sessions.

---

## Planned Repository Structure

```text
agy-monitor/
├── .gitignore
├── CHANGELOG.md                  # Keep a Changelog format (unwrapped lines for GitHub releases)
├── LICENSE                       # MIT
├── PLAN.md                       # This implementation plan
├── README.md                     # Setup, architecture, surfaces covered, limitations, release guide
├── eslint.config.mjs             # ESLint v10 + typescript-eslint flat config
├── package.json                  # Zero runtime deps; lint, typecheck, test, release-notes, version scripts
├── tsconfig.json                 # Strict ES2022/NodeNext + erasableSyntaxOnly
├── scripts/
│   ├── agy-menubar.ts            # Main SwiftBar/xbar plugin helper
│   ├── agy-monitor.5s.sh         # SwiftBar wrapper (PATH setup, node/bun/tsx probing, xbar headers)
│   ├── install-menubar.sh        # Detects SwiftBar/xbar, symlinks wrapper, checks runtime
│   ├── uninstall-menubar.sh      # Removes plugin symlinks cleanly
│   └── release-notes.sh          # Extracts current version section from CHANGELOG.md
└── test/
    └── agy-menubar.test.ts       # Hermetic fixtures + unit tests via node:test
```

---

## Phased Implementation Checklist

> [!NOTE]
> Phases 1-3 deliver the complete end-to-end main spine (`wrapper -> discovery -> liveness -> core metrics -> Other Sessions -> pin/unpin`) before Phase 4 adds secondary enrichment panels.

- [x] **Phase 1: Project Scaffolding & Wrapper Scripts**
  - Initialize `git` repository, `.gitignore`, `LICENSE` (MIT), `package.json`, `tsconfig.json` (`"strict": true`, `"erasableSyntaxOnly": true`), and `eslint.config.mjs`.
  - Create `scripts/agy-monitor.5s.sh`, `scripts/install-menubar.sh`, `scripts/uninstall-menubar.sh`, and `scripts/release-notes.sh` with `node` (>= 22.18 native TS) -> `bun` -> `tsx` -> `npx tsx` probing.
- [x] **Phase 2: Multi-Root Discovery, WAL-Safe SQLite & Liveness**
  - Implement cross-runtime read-only `openDb()` (`node:sqlite` + `bun:sqlite`, `PRAGMA table_info` projection, `SQLITE_BUSY` cached-summary fallback, and offline `?immutable=1` fallback).
  - Implement `scanLivePresence()` (`lsof -b` with 500 ms timeout and 15s `presence.json` TTL cache) and `discoverSessions()` across `jetski`, `antigravity`, and `antigravity-cli`.
  - Implement parent-child tree rollup (`parent_conversation_id` + `swarm/members.json` + `group_id`), three-state liveness (`working`, `open`, `closed`), allow-listed `gen_metadata` model extraction, and `.git/HEAD` + `.citc` workspace resolver.
- [x] **Phase 3: Core `transcript.jsonl` Parser, Cache & End-to-End Spine Renderer**
  - Implement 1 MiB byte-offset `parseTranscriptRange()`, `loadStats()`, and `pruneCache()` (protecting `RESERVED_CACHE_FILES`) in `~/.gemini/.agy-monitor-cache/`.
  - Extract turns, live/peak context tokens, cached/uncached/output tokens, compactions, tool call counts, step-reconciled `pendingTools`, sandbox blocks vs genuine tool failures, and `ERROR_MESSAGE` API/quota alerts.
  - Implement `emit()`, `sanitizeLabel()`, `sanitizeParam()`, monochrome template icon, primary session header + core metrics view, `Open Workspace Folder` / `Open Session Brain` / `Focus Antigravity` actions, `pin` / `unpin`, and `Other Sessions` submenu; verify end-to-end SwiftBar output.
- [x] **Phase 4: Subagents, Swarms & Customization Panels**
  - Add child rollup and click-to-pin panels for `.system_generated/subagents/*.json` and `.system_generated/swarm/{swarm.json,members.json,board.jsonl}` (worker phase, model, board `#seq` lag, `[stall]`/`[done]`).
  - Add `.system_generated/messages/` + `read.json` inbox panel, `.system_generated/tasks/` background tasks, session/workspace Markdown artifact links and GFM task checklists, invoked skills, and repo/global rules, hooks, and MCP server summary.
- [x] **Phase 5: Hermetic Tests, Live Benchmark & Documentation**
  - Write hermetic unit tests in `test/agy-menubar.test.ts` (`node --test`): multi-byte UTF-8 chunk splits, stale `.lock` rejection, `lsof` timeout cache fallback, delegated subagent `not_fully_idle` rollup, step-reconciled `pendingTools`, allow-listed model parsing, and `|` / control-char injection escaping.
  - Run `npm run lint`, `npm run typecheck`, `npm test` (sandboxed), then benchmark cold vs warm latency against live `~/.gemini` roots (`BypassSandbox: true`).
  - Write `README.md` and `CHANGELOG.md` (`0.1.0`).

---

## Recorded Decisions

1. **Surface coverage**: Monitor all three local directories (`~/.gemini/jetski`, `~/.gemini/antigravity`, `~/.gemini/antigravity-cli`) across desktop IDE, interactive CLI, `agentapi`, subagents, and native swarms in one unified menu bar item.
2. **Zero runtime dependencies & native Node TypeScript**: Target Node `>= 22.18` / `24+` (`v26.13.0` on this machine) and `bun` natively using erasable TypeScript syntax and built-in SQLite (`node:sqlite` / `bun:sqlite`), keeping runtime `node_modules` empty.
3. **No synthetic dollar estimates**: Replace Copilot CLI's `session-store.db` AIC dollar panel with exact live context-window fill, cache-read ratio, input/output/child token breakdowns, compactions, and quota/API error alerts.
4. **Root-session grouping**: Roll subagents and swarm workers under their root conversation in the primary display and `Other Sessions` list, with click-to-pin drill-down onto individual child conversations.
