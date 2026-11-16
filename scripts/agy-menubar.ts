#!/usr/bin/env node
/**
 * Agy Monitor -- SwiftBar/xbar menu bar plugin helper for Antigravity and Jetski.
 *
 * Discovers sessions across ~/.gemini/{jetski,antigravity,antigravity-cli},
 * verifies live open presence locks via lsof, parses transcript.jsonl incrementally
 * with an on-disk byte-offset cache, and renders SwiftBar-formatted output.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const requireSync = createRequire(import.meta.url);
const MODULE_PATH = fileURLToPath(import.meta.url);

export const VERSION: string = (() => {
  try {
    const pkg = requireSync('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'dev';
  } catch {
    return 'dev';
  }
})();

export const CHANGELOG_URL = 'https://github.com/eggboy/agy-monitor/blob/main/CHANGELOG.md';

// Official Antigravity macOS trayTemplate@2x.png (44x44px @ 144 DPI = 22x22pt Retina templateImage).
export const AGY_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAACXBIWXMAABYlAAAWJQFJUiTwAAACPUlEQVR4nO2XvWsUYRCHn71NsIhFiE0EQ0ilGALRIoWQ0kqxkEBSGQsRPTAJ+IH5K2yshPQ2EtHKwiAIQkiRFIlBUNQ0gRQKQoTkvsLCjAzDedxddvdOeR8YXtjdmfd38/HeLgQCgUDgfyICYqBHLJZrXUnhL+KibhStgk4BD4Fl4CVwH+g3P6grUCFngW2gBlTEasAGMCTPdDzTKqAPWBOBB0BJ7FCuvQdOOJ+OkAxVwqIRW3N2KOu888kdzdQA8M20ghdckfUTcNL55opm6oYIKtcRW3Oip5xvR4btVROCS7I+d765iz0D/BQx1SYyvCtHX+5toSWdadC71qrmmSsuRq6Cn7mSN7KyrE/yFqylTM7Vj3UyXBFxar4t1k2MKM/+nTAiqmL1Bq9s7ms1xlysTNFSPjICbI9uAi/kfWLLZNf+oHsuVqZoGd+6/t0HbjkRPUAR+O2efZ1XhnWDcyLQ9ua03IudJdx0g/dDjsTM+1gFLLh3h6dyvdcJiCTLCUvO57aLmTp2sj+YodoBBt0z9aoyDOwZv5UGPqmgmbjs+vGuu9/I94HznWzCt200U29Mlt41uVlkzu5V47/sYqeG9uGsOXd/ARda2LAg6yU5Nfyw6h7HRje6KNOtfwCJ+FbLGct6x2Q5eSEadXsdW+wI8NUcY8U2xOJ8HhvRn4HTaQyhlmlOAn8BrrqN2yGW9TrwXWJfSyHuH5JPm/GUP9kL5hPrfJo9bIlSnug4q3NYhUb/QBICgUAgQHYcAQWt04kND889AAAAAElFTkSuQmCC';

export const MAX_OTHER_SESSIONS = 15;
export const READ_CHUNK_BYTES = 1 << 20; // 1 MiB
export const PRESENCE_TTL_MS = 15_000;
export const HEADLESS_ACTIVE_WINDOW_MS = 600_000;
export const RUNNING_NOW_MAX_AGE_MS = 600_000;
export const RECENT_IDLE_MAX_AGE_MS = 300_000;
export const ACTIVE_GAP_CAP_MS = 300_000;
export const CACHE_VERSION = 2;

export const RESERVED_CACHE_FILES = new Set([
  'presence.json',
  'summaries.json',
  'models.json',
]);

// SwiftBar adaptive colors (light,dark)
const CLR = 'color=#1d1d1f,#f5f5f7';
const CLR_SUB = 'color=#3a3a3c,#d1d1d6';
const CLR_HEAD = 'color=#000000,#ffffff';

// ── Types ──────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

export type SessionLiveness = 'working' | 'open' | 'closed';

export interface MonitorConfig {
  geminiDir: string;
  stateDir: string;
  cacheDir: string;
  pinFile: string;
  configDir: string;
  roots: string[];
  wrapperPath: string;
  lsofOutputOverride?: string;
  lsofRunner?: () => string;
  skipPidVerify?: boolean;
  now: number;
}

export interface PresenceLock {
  pid: number;
  command: string;
  rootPath: string;
  conversationId: string;
  lockPath: string;
}

export interface PresenceSnapshot {
  ts: number;
  locks: Record<string, PresenceLock>;
  liveRoots: string[];
}

export interface SummaryRow {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  lastModifiedMs: number;
  workspaceUris: string[];
  status: string;
  source: string;
  projectId: string;
  agentName: string;
  parentConversationId: string;
  nestingDepth: number;
  notFullyIdle: boolean;
  killed: boolean;
  groupId: string;
  appDataDir: string;
}

export interface WorkspaceInfo {
  cwd: string;
  gitRoot: string;
  repo: string;
  branch: string;
  isCitc: boolean;
}

export interface DiscoveredSession {
  id: string;
  rootId: string;
  rootPath: string;
  rootName: string;
  cacheKey: string;
  brainDir: string;
  surface: string;
  title: string;
  preview: string;
  stepCount: number;
  status: string;
  source: string;
  agentName: string;
  parentConversationId: string;
  nestingDepth: number;
  notFullyIdle: boolean;
  killed: boolean;
  groupId: string;
  lastModifiedMs: number;
  latestTreeModifiedMs: number;
  treeRunning: boolean;
  liveness: SessionLiveness;
  lock: PresenceLock | null;
  workspace: WorkspaceInfo;
  childIds: string[];
}

export interface DiscoveryResult {
  roots: DiscoveredSession[];
  allById: Map<string, DiscoveredSession>;
  presence: PresenceSnapshot;
}

export interface ToolStat {
  name: string;
  count: number;
  failed: number;
  sandboxBlocked: number;
  lastTs: string;
}

export interface PendingTool {
  stepIndex: number;
  ordinal: number;
  name: string;
  summary: string;
  startTs: string;
  mcpServer?: string;
}

export interface ToolIssue {
  name: string;
  ts: string;
  stepIndex: number;
  exitCode: string;
  message: string;
}

export interface ApiErrorEntry {
  ts: string;
  stepIndex: number;
  message: string;
  isQuota: boolean;
}

export interface SkillInvocation {
  name: string;
  timestamp: string;
}

export interface BackgroundTaskEvent {
  taskId: string;
  toolName: string;
  summary: string;
  ts: string;
  stepIndex: number;
}

export interface SessionStats {
  startTime: string;
  lastActivity: string;
  lastEventTimestampMs: number;
  activeDurationMs: number;
  firstUserRequest: string;
  turnCount: { user: number; assistant: number };
  wakeupCount: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalOutputTokens: number;
  lastInputTokens: number;
  lastCacheReadTokens: number;
  currentContextTokens: number;
  peakContextTokens: number;
  compactions: number;
  lastAssistantStep: number;
  lastApiErrorStep: number;
  tools: Map<string, ToolStat>;
  pendingTools: PendingTool[];
  toolFailures: ToolIssue[];
  sandboxBlocks: ToolIssue[];
  apiErrors: ApiErrorEntry[];
  skills: SkillInvocation[];
  mcpUsed: Map<string, number>;
  mcpFailed: Map<string, number>;
  backgroundEvents: BackgroundTaskEvent[];
}

type SerializedSessionStats = Omit<SessionStats, 'tools' | 'mcpUsed' | 'mcpFailed'> & {
  tools: Array<[string, ToolStat]>;
  mcpUsed: Array<[string, number]>;
  mcpFailed: Array<[string, number]>;
};

interface CacheEntry {
  v: number;
  inode: number;
  size: number;
  mtimeMs: number;
  lastOffset: number;
  cachedAt: number;
  model: string;
  modelStepCount: number;
  stats: SerializedSessionStats;
}

export interface SubagentEntry {
  conversationId: string;
  typeName: string;
  role: string;
  state: string;
  spawnStepIndex: number;
  isActive: boolean;
  isKilled: boolean;
  model: string;
  durationMs: number;
  toolCalls: number;
  totalTokens: number;
}

export interface SwarmMemberEntry {
  handle: string;
  conversationId: string;
  role: string;
  phase: string;
  desiredState: string;
  model: string;
  lastReadSeq: number;
  unreadLag: number;
  killed: boolean;
  toolCalls: number;
  totalTokens: number;
}

export interface SwarmBoardPost {
  seq: number;
  agent: string;
  text: string;
}

export interface SwarmInfo {
  swarmId: string;
  title: string;
  headSeq: number;
  statusTag: string;
  members: SwarmMemberEntry[];
  recentPosts: SwarmBoardPost[];
}

export interface InboxMessage {
  id: string;
  sender: string;
  senderLabel: string;
  title: string;
  summary: string;
  timestamp: string;
  timestampMs: number;
  unread: boolean;
}

export interface BackgroundTaskItem {
  name: string;
  logPath: string;
  mtimeMs: number;
  sizeBytes: number;
  summary: string;
  isRecent: boolean;
}

export interface ArtifactItem {
  name: string;
  filePath: string;
  summary: string;
  updatedAt: string;
  userFacing: boolean;
}

export interface ChecklistSummary {
  sourcePath: string;
  done: number;
  inProgress: number;
  pending: number;
  total: number;
  items: Array<{ status: 'done' | 'in_progress' | 'pending'; text: string }>;
}

export interface RuleFileItem {
  path: string;
  label: string;
  scope: 'repo' | 'global';
}

export interface McpServerEntry {
  name: string;
  toolCount: number;
  calls: number;
}

export interface CustomizationSummary {
  rules: RuleFileItem[];
  hooks: Array<{ name: string; events: string[] }>;
  mcpWorking: McpServerEntry[];
}

export interface AnyDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

export interface OpenDbResult {
  db: AnyDb | null;
  busy: boolean;
  usedImmutable: boolean;
}

// ── Helpers & Config ───────────────────────────────────────────────────

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveConfig(
  overrides?: Partial<MonitorConfig>,
  env: NodeJS.ProcessEnv = process.env,
): MonitorConfig {
  const geminiDir = overrides?.geminiDir ?? join(homedir(), '.gemini');
  const stateDir = overrides?.stateDir ?? (env.AGY_MONITOR_STATE_DIR?.trim() || geminiDir);
  const cacheDir = overrides?.cacheDir ?? join(stateDir, '.agy-monitor-cache');
  const pinFile = overrides?.pinFile ?? join(stateDir, '.agy-monitor-primary');
  const hasCustomRoots = Boolean(overrides?.roots || env.AGY_MONITOR_DIRS?.trim());
  const configDir =
    overrides?.configDir ??
    (env.AGY_MONITOR_CONFIG_DIR?.trim() ||
      join(hasCustomRoots ? stateDir : geminiDir, 'config'));

  let roots: string[];
  if (overrides?.roots) {
    roots = overrides.roots.map((r) => resolve(r));
  } else if (env.AGY_MONITOR_DIRS?.trim()) {
    const raw = env.AGY_MONITOR_DIRS.trim();
    const sepChar = raw.includes(':') ? ':' : ',';
    roots = raw
      .split(sepChar)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((r) => resolve(r));
  } else {
    roots = ['jetski', 'antigravity', 'antigravity-cli'].map((name) =>
      join(geminiDir, name),
    );
  }

  return {
    geminiDir,
    stateDir,
    cacheDir,
    pinFile,
    configDir,
    roots,
    wrapperPath: overrides?.wrapperPath ?? (env.AGY_MENUBAR_PLUGIN ?? ''),
    lsofOutputOverride: overrides?.lsofOutputOverride ?? env.AGY_MONITOR_LSOF_OUTPUT,
    lsofRunner: overrides?.lsofRunner,
    skipPidVerify: overrides?.skipPidVerify ?? false,
    now: overrides?.now ?? Date.now(),
  };
}

function ensureCacheDir(cacheDir: string): void {
  if (!existsSync(cacheDir)) {
    try {
      mkdirSync(cacheDir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
}

export function parseTimestampMs(raw: string): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('0001-01-01')) return 0;
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms) || ms < 946684800000) return 0; // ignore < 2000-01-01
  return ms;
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function rootSlug(rootPath: string): string {
  const base = basename(rootPath).replace(/[^A-Za-z0-9_.-]/g, '_');
  return base || 'root';
}

export function makeSessionCacheKey(rootPath: string, conversationId: string): string {
  return `${rootSlug(rootPath)}__${conversationId}`;
}

// ── Cross-Runtime Read-Only SQLite ─────────────────────────────────────

function isSqliteBusyError(err: unknown): boolean {
  if (!err) return false;
  const msg = String(err instanceof Error ? err.message : err);
  const code = (err as { errcode?: unknown }).errcode;
  return code === 5 || /SQLITE_BUSY|database is locked/i.test(msg);
}

function probeAndReturnDb(db: AnyDb): AnyDb {
  try {
    // Force SQLite to read the header / attach WAL -shm immediately rather than lazily on first query
    db.prepare('PRAGMA schema_version').get();
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function instantiateReadOnlyDb(target: string): AnyDb {
  if (typeof process.versions.bun === 'string') {
    const { Database } = requireSync('bun:sqlite') as {
      Database: new (p: string, opts: { readonly: boolean }) => AnyDb;
    };
    return probeAndReturnDb(new Database(target, { readonly: true }));
  }

  try {
    const { DatabaseSync } = requireSync('node:sqlite') as {
      DatabaseSync: new (p: string, opts: { readOnly: boolean }) => AnyDb;
    };
    return probeAndReturnDb(new DatabaseSync(target, { readOnly: true }));
  } catch (nodeErr) {
    try {
      const { Database } = requireSync('bun:sqlite') as {
        Database: new (p: string, opts: { readonly: boolean }) => AnyDb;
      };
      return probeAndReturnDb(new Database(target, { readonly: true }));
    } catch {
      throw nodeErr;
    }
  }
}

/**
 * Opens a SQLite database strictly in read-only mode.
 * Uses `?immutable=1` ONLY as a fallback when `allowOfflineImmutable` is true
 * (i.e. `lsof` confirmed no live host process holds `<root>`), avoiding stale
 * WAL reads on active databases.
 */
export function openDbWithStatus(
  dbPath: string,
  allowOfflineImmutable = false,
): OpenDbResult {
  if (!existsSync(dbPath)) {
    return { db: null, busy: false, usedImmutable: false };
  }

  try {
    const db = instantiateReadOnlyDb(dbPath);
    return { db, busy: false, usedImmutable: false };
  } catch (err) {
    if (isSqliteBusyError(err)) {
      return { db: null, busy: true, usedImmutable: false };
    }
    if (allowOfflineImmutable) {
      try {
        const encoded = encodeURI(dbPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
        const db = instantiateReadOnlyDb(`file:${encoded}?immutable=1`);
        return { db, busy: false, usedImmutable: true };
      } catch (immErr) {
        return { db: null, busy: isSqliteBusyError(immErr), usedImmutable: false };
      }
    }
    return { db: null, busy: false, usedImmutable: false };
  }
}

export function openDb(dbPath: string, allowOfflineImmutable = false): AnyDb | null {
  return openDbWithStatus(dbPath, allowOfflineImmutable).db;
}

// ── Live Presence (lsof + TTL Cache) ───────────────────────────────────

export function parseLsofOutput(
  output: string,
  roots: string[],
): Omit<PresenceSnapshot, 'ts'> {
  const normalizedRoots = roots.map((r) => resolve(r));
  const locks: Record<string, PresenceLock> = {};
  const liveRootsSet = new Set<string>();

  let currentPid = 0;
  let currentCmd = '';

  for (const rawLine of output.split('\n')) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    const body = rawLine.slice(1).trim();
    if (tag === 'p') {
      currentPid = Number(body) || 0;
    } else if (tag === 'c') {
      currentCmd = body;
    } else if (tag === 'n') {
      for (const rootPath of normalizedRoots) {
        if (body === rootPath || body.startsWith(rootPath + '/')) {
          liveRootsSet.add(rootPath);
          const presencePrefix = `${rootPath}/presence/`;
          if (body.startsWith(presencePrefix) && body.endsWith('.lock')) {
            const fileName = body.slice(presencePrefix.length);
            if (!fileName.includes('/')) {
              const conversationId = fileName.slice(0, -'.lock'.length);
              if (conversationId) {
                locks[`${rootPath}::${conversationId}`] = {
                  pid: currentPid,
                  command: currentCmd,
                  rootPath,
                  conversationId,
                  lockPath: body,
                };
              }
            }
          }
        }
      }
    }
  }

  return {
    locks,
    liveRoots: Array.from(liveRootsSet),
  };
}

function readPresenceCache(cacheDir: string): PresenceSnapshot | null {
  const p = join(cacheDir, 'presence.json');
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    if (!isObject(parsed) || typeof parsed.ts !== 'number') return null;
    return {
      ts: parsed.ts,
      locks: isObject(parsed.locks) ? (parsed.locks as Record<string, PresenceLock>) : {},
      liveRoots: Array.isArray(parsed.liveRoots)
        ? parsed.liveRoots.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function writePresenceCache(cacheDir: string, snapshot: PresenceSnapshot): void {
  ensureCacheDir(cacheDir);
  try {
    writeFileSync(join(cacheDir, 'presence.json'), JSON.stringify(snapshot));
  } catch {
    /* best-effort */
  }
}

export function scanLivePresence(cfg: MonitorConfig): PresenceSnapshot {
  const cached = readPresenceCache(cfg.cacheDir);

  const saveAndReturn = (rawOut: string): PresenceSnapshot => {
    const parsed = parseLsofOutput(rawOut, cfg.roots);
    const snap: PresenceSnapshot = {
      ts: cfg.now,
      locks: parsed.locks,
      liveRoots: parsed.liveRoots,
    };
    writePresenceCache(cfg.cacheDir, snap);
    return snap;
  };

  if (cfg.lsofRunner) {
    try {
      return saveAndReturn(cfg.lsofRunner());
    } catch {
      if (cached && cfg.now - cached.ts < PRESENCE_TTL_MS) {
        return cached;
      }
      return { ts: cfg.now, locks: {}, liveRoots: [] };
    }
  }

  if (cfg.lsofOutputOverride !== undefined) {
    return saveAndReturn(cfg.lsofOutputOverride);
  }

  try {
    const out = execFileSync(
      'lsof',
      ['-b', '-w', '-n', '-P', '-a', '-c', '/^(jetski|agy|language_)/', '-F', 'pcn'],
      {
        timeout: 500,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return saveAndReturn(out);
  } catch (err) {
    const e = err as {
      status?: number | null;
      signal?: string | null;
      killed?: boolean;
      code?: string;
      stdout?: string | Buffer;
    };
    const stdout =
      typeof e.stdout === 'string'
        ? e.stdout
        : Buffer.isBuffer(e.stdout)
          ? e.stdout.toString('utf-8')
          : '';

    // `lsof -b` exits 1 while still emitting accessible FDs if one mount blocked.
    if (stdout.trim().length > 0 && !e.killed && e.code !== 'ETIMEDOUT') {
      return saveAndReturn(stdout);
    }

    // Timeout, signal, or sandbox denial: fall back to fresh presence.json cache.
    const isTransientFailure =
      Boolean(e.killed) ||
      Boolean(e.signal) ||
      e.code === 'ETIMEDOUT' ||
      e.code === 'EPERM' ||
      e.code === 'EACCES' ||
      e.code === 'ENOENT';

    if (isTransientFailure) {
      if (cached && cfg.now - cached.ts < PRESENCE_TTL_MS) {
        return cached;
      }
      return { ts: cfg.now, locks: {}, liveRoots: [] };
    }

    // Exit status 1 with empty stdout normally means zero matching processes,
    // unless `-b` aborted early; verify cached PIDs before dropping within TTL.
    if (cached && cfg.now - cached.ts < PRESENCE_TTL_MS) {
      const stillAliveLocks: Record<string, PresenceLock> = {};
      const stillLiveRoots = new Set<string>();
      for (const [k, lock] of Object.entries(cached.locks)) {
        if (cfg.skipPidVerify || pidAlive(lock.pid)) {
          stillAliveLocks[k] = lock;
          stillLiveRoots.add(lock.rootPath);
        }
      }
      if (Object.keys(stillAliveLocks).length > 0) {
        return {
          ts: cached.ts,
          locks: stillAliveLocks,
          liveRoots: Array.from(stillLiveRoots),
        };
      }
    }

    const empty: PresenceSnapshot = { ts: cfg.now, locks: {}, liveRoots: [] };
    writePresenceCache(cfg.cacheDir, empty);
    return empty;
  }
}

// ── Summaries DB & Schema Projection ───────────────────────────────────

const SUMMARY_COLUMNS = [
  'conversation_id',
  'title',
  'preview',
  'step_count',
  'last_modified_time',
  'workspace_uris',
  'status',
  'source',
  'project_id',
  'agent_name',
  'parent_conversation_id',
  'nesting_depth',
  'not_fully_idle',
  'killed',
  'group_id',
  'app_data_dir',
] as const;

type SummaryCacheMap = Record<string, SummaryRow[]>;

function readSummariesCache(cacheDir: string): SummaryCacheMap {
  const p = join(cacheDir, 'summaries.json');
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    return isObject(parsed) ? (parsed as SummaryCacheMap) : {};
  } catch {
    return {};
  }
}

function writeSummariesCache(cacheDir: string, map: SummaryCacheMap): void {
  ensureCacheDir(cacheDir);
  try {
    writeFileSync(join(cacheDir, 'summaries.json'), JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

function parseWorkspaceUrisField(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
    }
  } catch {
    if (raw.startsWith('file://') || raw.startsWith('/')) return [raw.trim()];
  }
  return [];
}

export function readRootSummaries(
  rootPath: string,
  isRootLive: boolean,
  summariesCache: SummaryCacheMap,
): { rows: SummaryRow[]; updatedCache: boolean; usedImmutable: boolean; usedBusyFallback: boolean } {
  const dbPath = join(rootPath, 'conversation_summaries.db');
  if (!existsSync(dbPath)) {
    return { rows: [], updatedCache: false, usedImmutable: false, usedBusyFallback: false };
  }

  const opened = openDbWithStatus(dbPath, !isRootLive);
  if (!opened.db) {
    if (opened.busy && summariesCache[rootPath]) {
      return {
        rows: summariesCache[rootPath],
        updatedCache: false,
        usedImmutable: false,
        usedBusyFallback: true,
      };
    }
    return { rows: [], updatedCache: false, usedImmutable: false, usedBusyFallback: false };
  }

  try {
    const tableInfo = opened.db
      .prepare('PRAGMA table_info(conversation_summaries)')
      .all() as Array<{ name?: unknown }>;
    const existingCols = new Set(
      tableInfo
        .map((c) => (typeof c.name === 'string' ? c.name : ''))
        .filter(Boolean),
    );

    if (!existingCols.has('conversation_id')) {
      return {
        rows: [],
        updatedCache: false,
        usedImmutable: opened.usedImmutable,
        usedBusyFallback: false,
      };
    }

    const projected = SUMMARY_COLUMNS.filter((c) => existingCols.has(c));
    const orderClause = existingCols.has('last_modified_time')
      ? 'ORDER BY last_modified_time DESC'
      : 'ORDER BY ROWID DESC';

    const rawRows = opened.db
      .prepare(`SELECT ${projected.join(', ')} FROM conversation_summaries ${orderClause}`)
      .all() as Array<Record<string, unknown>>;

    const rows: SummaryRow[] = [];
    for (const r of rawRows) {
      const conversationId = String(r.conversation_id ?? '').trim();
      if (!conversationId) continue;
      const lastModifiedTime = String(r.last_modified_time ?? '');
      rows.push({
        conversationId,
        title: String(r.title ?? ''),
        preview: String(r.preview ?? ''),
        stepCount: Number(r.step_count ?? 0) || 0,
        lastModifiedTime,
        lastModifiedMs: parseTimestampMs(lastModifiedTime),
        workspaceUris: parseWorkspaceUrisField(r.workspace_uris),
        status: String(r.status ?? ''),
        source: String(r.source ?? ''),
        projectId: String(r.project_id ?? ''),
        agentName: String(r.agent_name ?? ''),
        parentConversationId: String(r.parent_conversation_id ?? '').trim(),
        nestingDepth: Number(r.nesting_depth ?? 0) || 0,
        notFullyIdle: Boolean(Number(r.not_fully_idle ?? 0)),
        killed: Boolean(Number(r.killed ?? 0)),
        groupId: String(r.group_id ?? '').trim(),
        appDataDir: String(r.app_data_dir ?? ''),
      });
    }

    summariesCache[rootPath] = rows;
    return {
      rows,
      updatedCache: true,
      usedImmutable: opened.usedImmutable,
      usedBusyFallback: false,
    };
  } catch (err) {
    if (isSqliteBusyError(err) && summariesCache[rootPath]) {
      return {
        rows: summariesCache[rootPath],
        updatedCache: false,
        usedImmutable: opened.usedImmutable,
        usedBusyFallback: true,
      };
    }
    return {
      rows: [],
      updatedCache: false,
      usedImmutable: opened.usedImmutable,
      usedBusyFallback: false,
    };
  } finally {
    try {
      opened.db.close();
    } catch {
      /* best-effort */
    }
  }
}

// ── Workspace, Git/CitC & Surface Resolution ───────────────────────────

function uriToPath(uri: string): string {
  if (!uri) return '';
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return decodeURIComponent(uri.slice('file://'.length));
    }
  }
  return uri;
}

function readGitBranchFromDotGit(dotGitPath: string, repoDir: string): string {
  try {
    const st = statSync(dotGitPath);
    let gitDir = dotGitPath;
    if (st.isFile()) {
      const ptr = readFileSync(dotGitPath, 'utf-8').trim();
      const m = /^gitdir:\s*(.+)$/m.exec(ptr);
      if (!m) return '';
      gitDir = resolve(repoDir, m[1].trim());
    }
    const headFile = join(gitDir, 'HEAD');
    if (!existsSync(headFile)) return '';
    const head = readFileSync(headFile, 'utf-8').trim();
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (refMatch) return refMatch[1].trim();
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
  } catch {
    /* unreadable .git */
  }
  return '';
}

export function resolveWorkspaceInfo(
  workspaceUris: string[],
  workspaceCache?: Map<string, WorkspaceInfo>,
): WorkspaceInfo {
  const firstUri = workspaceUris[0] ?? '';
  const cwd = uriToPath(firstUri);
  if (!cwd) {
    return { cwd: '', gitRoot: '', repo: 'no-workspace', branch: '', isCitc: false };
  }

  const cached = workspaceCache?.get(cwd);
  if (cached) return cached;

  // CitC path recognition: /google/src/cloud/<user>/<client>/...
  const citcMatch = /^\/google\/src\/cloud\/[^/]+\/([^/]+)/.exec(cwd);
  if (citcMatch) {
    const info: WorkspaceInfo = {
      cwd,
      gitRoot: `/google/src/cloud/${cwd.split('/')[4]}/${citcMatch[1]}`,
      repo: citcMatch[1],
      branch: 'citc',
      isCitc: true,
    };
    workspaceCache?.set(cwd, info);
    return info;
  }

  let cur = resolve(cwd);
  const stopDir = homedir();
  for (let depth = 0; depth < 10; depth++) {
    const citcDir = join(cur, '.citc');
    if (existsSync(citcDir)) {
      let clientName = basename(cur);
      try {
        const cnPath = join(citcDir, 'client_name');
        if (existsSync(cnPath)) {
          clientName = readFileSync(cnPath, 'utf-8').trim() || clientName;
        }
      } catch {
        /* ignore */
      }
      const info: WorkspaceInfo = {
        cwd,
        gitRoot: cur,
        repo: clientName,
        branch: 'citc',
        isCitc: true,
      };
      workspaceCache?.set(cwd, info);
      return info;
    }

    const dotGit = join(cur, '.git');
    if (existsSync(dotGit)) {
      const branch = readGitBranchFromDotGit(dotGit, cur);
      const info: WorkspaceInfo = {
        cwd,
        gitRoot: cur,
        repo: basename(cur),
        branch,
        isCitc: false,
      };
      workspaceCache?.set(cwd, info);
      return info;
    }

    if (cur === stopDir || cur === '/') break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const fallback: WorkspaceInfo = {
    cwd,
    gitRoot: '',
    repo: basename(cwd) || 'workspace',
    branch: '',
    isCitc: false,
  };
  workspaceCache?.set(cwd, fallback);
  return fallback;
}

function hasLiveDaemonHub(rootPath: string): boolean {
  const daemonDir = join(rootPath, 'daemon');
  if (!existsSync(daemonDir)) return false;
  try {
    for (const f of readdirSync(daemonDir)) {
      if (!f.startsWith('hub_') || !f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(daemonDir, f), 'utf-8')) as unknown;
      if (isObject(raw) && typeof raw.pid === 'number' && pidAlive(raw.pid)) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function resolveSurfaceLabel(
  rootName: string,
  row: SummaryRow,
  lock: PresenceLock | null,
  hasHub: boolean,
): string {
  const flavor = (row.appDataDir || rootName).toLowerCase();
  const cmd = (lock?.command ?? '').toLowerCase();
  const isCliSource =
    row.source === 'CORTEX_TRAJECTORY_SOURCE_CLI' ||
    row.projectId === 'default-cli-project';

  if (flavor.includes('antigravity-cli')) {
    return 'Antigravity CLI';
  }
  if (flavor.includes('antigravity')) {
    if (cmd.startsWith('language_')) return 'Agy App';
    if (cmd === 'agy' || isCliSource) return hasHub ? 'Agy Hub' : 'Antigravity CLI';
    return 'Agy App';
  }
  if (flavor.includes('jetski')) {
    if (cmd.includes('cli') || isCliSource) return 'Jetski CLI';
    if (cmd.startsWith('language_')) return 'Jetski IDE';
    return 'Jetski';
  }
  return rootName;
}

// ── Discovery, Tree Rollup & Three-State Liveness ──────────────────────

function getRecentFsActivityMs(brainDir: string): number {
  let latest = 0;
  try {
    const tr = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(tr)) {
      latest = Math.max(latest, statSync(tr).mtimeMs);
    }
    const tasksDir = join(brainDir, '.system_generated', 'tasks');
    if (existsSync(tasksDir)) {
      for (const f of readdirSync(tasksDir)) {
        if (!f.endsWith('.log')) continue;
        latest = Math.max(latest, statSync(join(tasksDir, f)).mtimeMs);
      }
    }
  } catch {
    /* ignore */
  }
  return latest;
}

function readSwarmWorkerParentLinks(
  rootPath: string,
  candidateIds: string[],
): Map<string, string> {
  const childToCoordinator = new Map<string, string>();
  for (const coordinatorId of candidateIds) {
    const membersPath = join(
      rootPath,
      'brain',
      coordinatorId,
      '.system_generated',
      'swarm',
      'members.json',
    );
    if (!existsSync(membersPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(membersPath, 'utf-8')) as unknown;
      if (!isObject(parsed) || !isObject(parsed.members)) continue;
      for (const memberVal of Object.values(parsed.members)) {
        if (!isObject(memberVal)) continue;
        const memberConvId = String(memberVal.conversation_id ?? '').trim();
        if (memberConvId && memberConvId !== coordinatorId) {
          childToCoordinator.set(memberConvId, coordinatorId);
        }
      }
    } catch {
      /* ignore malformed members.json */
    }
  }
  return childToCoordinator;
}

function livenessRank(state: SessionLiveness): number {
  if (state === 'working') return 3;
  if (state === 'open') return 2;
  return 1;
}

export function discoverSessions(cfg: MonitorConfig): DiscoveryResult {
  const presence = scanLivePresence(cfg);
  const liveRootSet = new Set(presence.liveRoots);
  const summariesCache = readSummariesCache(cfg.cacheDir);
  let summariesCacheDirty = false;
  const workspaceCache = new Map<string, WorkspaceInfo>();

  const perRootSessions: DiscoveredSession[] = [];

  for (const rootPath of cfg.roots) {
    if (!existsSync(rootPath)) continue;
    const isRootLive = liveRootSet.has(rootPath);
    const { rows, updatedCache } = readRootSummaries(rootPath, isRootLive, summariesCache);
    if (updatedCache) summariesCacheDirty = true;
    if (rows.length === 0) continue;

    const rName = basename(rootPath);
    const hasHub = rName.includes('antigravity') ? hasLiveDaemonHub(rootPath) : false;

    const rowById = new Map<string, SummaryRow>();
    for (const r of rows) rowById.set(r.conversationId, r);

    // Supplement parent pointers via swarm/members.json on top recent candidates
    const swarmCandidates = rows
      .filter((r) => r.nestingDepth === 0)
      .slice(0, 100)
      .map((r) => r.conversationId);
    const swarmLinks = readSwarmWorkerParentLinks(rootPath, swarmCandidates);

    // Supplement parent pointers via shared group_id
    const groupCoordinators = new Map<string, string>();
    for (const r of rows) {
      if (r.groupId && r.nestingDepth === 0 && !r.parentConversationId) {
        if (!groupCoordinators.has(r.groupId)) {
          groupCoordinators.set(r.groupId, r.conversationId);
        }
      }
    }

    const parentOf = new Map<string, string>();
    for (const r of rows) {
      let parentId = r.parentConversationId;
      if (!parentId) {
        parentId = swarmLinks.get(r.conversationId) ?? '';
      }
      if (!parentId && r.groupId) {
        const gCoord = groupCoordinators.get(r.groupId);
        if (gCoord && gCoord !== r.conversationId) {
          parentId = gCoord;
        }
      }
      if (parentId && parentId !== r.conversationId && rowById.has(parentId)) {
        parentOf.set(r.conversationId, parentId);
      }
    }

    const resolveRootId = (id: string): string => {
      let cur = id;
      const seen = new Set<string>([cur]);
      while (parentOf.has(cur)) {
        const next = parentOf.get(cur)!;
        if (seen.has(next)) break;
        seen.add(next);
        cur = next;
      }
      return cur;
    };

    const descendantsByRoot = new Map<string, SummaryRow[]>();
    for (const r of rows) {
      const rootId = resolveRootId(r.conversationId);
      if (rootId !== r.conversationId) {
        const list = descendantsByRoot.get(rootId) ?? [];
        list.push(r);
        descendantsByRoot.set(rootId, list);
      }
    }

    // Compute root liveness first so children can reference their root's lock
    const rootLivenessMap = new Map<
      string,
      {
        liveness: SessionLiveness;
        lock: PresenceLock | null;
        treeRunning: boolean;
        latestTreeModifiedMs: number;
      }
    >();

    for (const r of rows) {
      const rootId = resolveRootId(r.conversationId);
      if (rootId !== r.conversationId) continue;

      const descendants = descendantsByRoot.get(rootId) ?? [];
      const allNodes = [r, ...descendants];

      const treeRunning = allNodes.some(
        (n) =>
          !n.killed &&
          (n.notFullyIdle || n.status === 'CASCADE_RUN_STATUS_RUNNING'),
      );
      const anyExplicitRunning = allNodes.some(
        (n) => !n.killed && n.status === 'CASCADE_RUN_STATUS_RUNNING',
      );
      const latestTreeModifiedMs = allNodes.reduce(
        (max, n) => Math.max(max, n.lastModifiedMs),
        0,
      );

      const lock = presence.locks[`${rootPath}::${rootId}`] ?? null;
      let liveness: SessionLiveness = 'closed';

      if (lock) {
        liveness = treeRunning ? 'working' : 'open';
      } else if (isRootLive && anyExplicitRunning) {
        const brainDir = join(rootPath, 'brain', rootId);
        const recentActivityMs = Math.max(
          latestTreeModifiedMs,
          getRecentFsActivityMs(brainDir),
        );
        if (recentActivityMs > 0 && cfg.now - recentActivityMs <= HEADLESS_ACTIVE_WINDOW_MS) {
          liveness = 'working';
        }
      }

      rootLivenessMap.set(rootId, {
        liveness,
        lock,
        treeRunning,
        latestTreeModifiedMs,
      });
    }

    for (const r of rows) {
      const rootId = resolveRootId(r.conversationId);
      const rootState = rootLivenessMap.get(rootId);
      const descendants = r.conversationId === rootId ? (descendantsByRoot.get(rootId) ?? []) : [];
      const lock = rootState?.lock ?? null;

      let liveness: SessionLiveness = rootState?.liveness ?? 'closed';
      let treeRunning = rootState?.treeRunning ?? false;
      let latestTreeModifiedMs = rootState?.latestTreeModifiedMs ?? r.lastModifiedMs;

      if (r.conversationId !== rootId) {
        const selfRunning =
          !r.killed && (r.notFullyIdle || r.status === 'CASCADE_RUN_STATUS_RUNNING');
        treeRunning = selfRunning;
        latestTreeModifiedMs = r.lastModifiedMs;
        if (r.killed) {
          liveness = 'closed';
        } else if (selfRunning && (lock || rootState?.liveness === 'working')) {
          liveness = 'working';
        } else if (lock) {
          liveness = 'open';
        } else {
          liveness = 'closed';
        }
      }

      const workspace = resolveWorkspaceInfo(r.workspaceUris, workspaceCache);
      const surface = resolveSurfaceLabel(rName, r, lock, hasHub);

      perRootSessions.push({
        id: r.conversationId,
        rootId,
        rootPath,
        rootName: rName,
        cacheKey: makeSessionCacheKey(rootPath, r.conversationId),
        brainDir: join(rootPath, 'brain', r.conversationId),
        surface,
        title: r.title,
        preview: r.preview,
        stepCount: r.stepCount,
        status: r.status,
        source: r.source,
        agentName: r.agentName,
        parentConversationId: parentOf.get(r.conversationId) ?? r.parentConversationId,
        nestingDepth: r.conversationId === rootId ? 0 : Math.max(1, r.nestingDepth),
        notFullyIdle: r.notFullyIdle,
        killed: r.killed,
        groupId: r.groupId,
        lastModifiedMs: r.lastModifiedMs,
        latestTreeModifiedMs,
        treeRunning,
        liveness,
        lock,
        workspace,
        childIds: descendants.map((d) => d.conversationId),
      });
    }
  }

  if (summariesCacheDirty) {
    writeSummariesCache(cfg.cacheDir, summariesCache);
  }

  // Deduplicate identical conversation IDs mirrored across roots (e.g. agy --hub)
  const allById = new Map<string, DiscoveredSession>();
  const scoreSession = (s: DiscoveredSession): number => {
    const hasTranscript = existsSync(
      join(s.brainDir, '.system_generated', 'logs', 'transcript.jsonl'),
    )
      ? 1
      : 0;
    return (
      livenessRank(s.liveness) * 1_000_000_000_000 +
      hasTranscript * 100_000_000_000 +
      s.stepCount * 1_000_000 +
      Math.floor(s.latestTreeModifiedMs / 1000)
    );
  };

  for (const s of perRootSessions) {
    const existing = allById.get(s.id);
    if (!existing || scoreSession(s) > scoreSession(existing)) {
      allById.set(s.id, s);
    }
  }

  const roots = Array.from(allById.values()).filter((s) => s.id === s.rootId);
  roots.sort((a, b) => {
    const rankDiff = livenessRank(b.liveness) - livenessRank(a.liveness);
    if (rankDiff !== 0) return rankDiff;
    return b.latestTreeModifiedMs - a.latestTreeModifiedMs;
  });

  return { roots, allById, presence };
}

// ── Allow-Listed Model Extraction ──────────────────────────────────────

const DISPLAY_MODEL_DISALLOWED =
  /\b(?:CLI|API|SDK|Code|Assist|Enterprise|Interactions|Live|dir|directory|plugin|plugins|when|with|from|into|that|this|for|and|the|memory|session|window)\b/i;

const SLUG_MODEL_RE =
  /^(?:gemini|claude|opus|fable|sonnet|haiku|gpt)-(?!api\b|cli\b|sdk\b)[A-Za-z0-9][A-Za-z0-9._-]{1,56}(?:@[A-Za-z0-9_-]+)?$/i;

function isValidDisplayModelName(candidate: string): boolean {
  if (candidate.length < 5 || candidate.length > 48) return false;
  if (!/^(?:Gemini|Claude|GPT)[- ][A-Za-z0-9 .()-]+$/.test(candidate)) return false;
  if (DISPLAY_MODEL_DISALLOWED.test(candidate)) return false;

  // Balanced parentheses check
  let depth = 0;
  for (const ch of candidate) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  if (depth !== 0) return false;

  // Every space-separated token in a display model starts with uppercase, digit, or '('
  const words = candidate.split(/\s+/);
  if (words.length > 6) return false;
  for (const w of words) {
    if (!/^[A-Z0-9(]/.test(w)) return false;
  }
  return true;
}

function matchAllowListedModel(rawRun: string): string | null {
  const candidates: string[] = [];

  // If the first byte in the ASCII run is the exact protobuf wire-type-2 length
  // prefix for the remainder (lengths 32..126 are printable ASCII!), strip it first.
  if (rawRun.length >= 5 && rawRun.charCodeAt(0) === rawRun.length - 1) {
    candidates.push(rawRun.slice(1).trim());
  }
  candidates.push(rawRun.trim());

  // Also strip any leading non-letter prefix (protobuf field tag/length bytes)
  const embeddedPrefix = rawRun.search(
    /(?:Gemini|Claude|GPT)[- ]|(?:gemini|claude|opus|fable|sonnet|haiku|gpt)-/i,
  );
  if (embeddedPrefix > 0) {
    candidates.push(rawRun.slice(embeddedPrefix).trim());
  }

  for (const c of candidates) {
    if (!c) continue;
    if (isValidDisplayModelName(c)) return c;
    if (SLUG_MODEL_RE.test(c)) return c;
  }
  return null;
}

/**
 * Scans printable ASCII runs in a protobuf `gen_metadata.data` blob from tail
 * to head, returning the first string that matches the strict model allow-list.
 * Never returns arbitrary raw bytes.
 */
export function extractModelFromBlob(data: Uint8Array): string | null {
  const runs: string[] = [];
  let start = -1;

  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b >= 0x20 && b <= 0x7e) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 4) {
        runs.push(Buffer.from(data.buffer, data.byteOffset + start, i - start).toString('utf-8'));
      }
      start = -1;
    }
  }
  if (start >= 0 && data.length - start >= 4) {
    runs.push(
      Buffer.from(data.buffer, data.byteOffset + start, data.length - start).toString('utf-8'),
    );
  }

  // Model display name and slug sit at the end of `gen_metadata`, after prompts.
  for (let i = runs.length - 1; i >= 0; i--) {
    const matched = matchAllowListedModel(runs[i]);
    if (matched) return matched;
  }
  return null;
}

function lookupSwarmMemberModel(session: DiscoveredSession): string | null {
  const brainDirsToCheck = [session.brainDir];
  if (session.rootId !== session.id) {
    brainDirsToCheck.unshift(join(session.rootPath, 'brain', session.rootId));
  }
  for (const bDir of brainDirsToCheck) {
    const membersFile = join(bDir, '.system_generated', 'swarm', 'members.json');
    if (!existsSync(membersFile)) continue;
    try {
      const parsed = JSON.parse(readFileSync(membersFile, 'utf-8')) as unknown;
      if (!isObject(parsed) || !isObject(parsed.members)) continue;
      for (const mVal of Object.values(parsed.members)) {
        if (!isObject(mVal)) continue;
        if (String(mVal.conversation_id ?? '') === session.id) {
          const m = String(
            mVal.applied_model || mVal.model || mVal.desired_model || '',
          ).trim();
          if (m) return m;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function lookupCliSettingsModel(rootPath: string): string | null {
  for (const rel of [join('cli', 'settings.json'), 'settings.json']) {
    const p = join(rootPath, rel);
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
      if (isObject(parsed) && typeof parsed.model === 'string' && parsed.model.trim()) {
        return parsed.model.trim();
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

interface ModelCacheEntry {
  model: string;
  stepCount: number;
}

function readModelsCache(cacheDir: string): Record<string, ModelCacheEntry> {
  const p = join(cacheDir, 'models.json');
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    return isObject(parsed) ? (parsed as Record<string, ModelCacheEntry>) : {};
  } catch {
    return {};
  }
}

function writeModelsCache(cacheDir: string, map: Record<string, ModelCacheEntry>): void {
  ensureCacheDir(cacheDir);
  try {
    writeFileSync(join(cacheDir, 'models.json'), JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

export function resolveSessionModel(
  session: DiscoveredSession,
  isRootLive: boolean,
  modelsCache: Record<string, ModelCacheEntry>,
): { model: string; dirty: boolean } {
  // Tier 1: Swarm member config
  const swarmModel = lookupSwarmMemberModel(session);
  if (swarmModel) {
    return { model: swarmModel, dirty: false };
  }

  const cached = modelsCache[session.cacheKey];
  if (cached && cached.model !== 'unknown' && cached.stepCount === session.stepCount) {
    return { model: cached.model, dirty: false };
  }

  // Tier 2: Per-conversation gen_metadata protobuf blob
  const convDbPath = join(session.rootPath, 'conversations', `${session.id}.db`);
  if (existsSync(convDbPath)) {
    const db = openDb(convDbPath, !isRootLive);
    if (db) {
      try {
        const rows = db
          .prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 3')
          .all() as Array<{ data?: unknown }>;
        for (const r of rows) {
          if (r.data instanceof Uint8Array || Buffer.isBuffer(r.data)) {
            const found = extractModelFromBlob(r.data);
            if (found) {
              modelsCache[session.cacheKey] = {
                model: found,
                stepCount: session.stepCount,
              };
              return { model: found, dirty: true };
            }
          }
        }
      } catch {
        /* gen_metadata absent or locked */
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Reuse prior resolved model if DB was transiently busy
  if (cached && cached.model !== 'unknown') {
    return { model: cached.model, dirty: false };
  }

  // Tier 3: CLI settings fallback for 0-turn brand new sessions
  if (session.stepCount === 0) {
    const settingsModel = lookupCliSettingsModel(session.rootPath);
    if (settingsModel) {
      return { model: settingsModel, dirty: false };
    }
  }

  return { model: 'unknown', dirty: false };
}

// ── Transcript Incremental Parser & Cache ──────────────────────────────

export function freshStats(): SessionStats {
  return {
    startTime: '',
    lastActivity: '',
    lastEventTimestampMs: 0,
    activeDurationMs: 0,
    firstUserRequest: '',
    turnCount: { user: 0, assistant: 0 },
    wakeupCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
    currentContextTokens: 0,
    peakContextTokens: 0,
    compactions: 0,
    lastAssistantStep: -1,
    lastApiErrorStep: -1,
    tools: new Map(),
    pendingTools: [],
    toolFailures: [],
    sandboxBlocks: [],
    apiErrors: [],
    skills: [],
    mcpUsed: new Map(),
    mcpFailed: new Map(),
    backgroundEvents: [],
  };
}

function cleanArgString(val: unknown): string {
  if (typeof val !== 'string') return '';
  let s = val.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const unquoted = JSON.parse(s) as unknown;
      if (typeof unquoted === 'string') s = unquoted;
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s.trim();
}

function extractUserRequestText(content: string): string {
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  const body = m ? m[1] : content;
  return firstLine(body.replace(/<\/?[A-Z_]+>/g, '').trim());
}

function extractSkillFromPath(filePath: string): string | null {
  const m = /\/skills\/([^/]+)\/SKILL\.md$/i.exec(filePath);
  return m ? m[1] : null;
}

function classifyGenericResult(
  content: string,
  errorField: string,
  status: string,
): {
  isBackground: boolean;
  taskId: string;
  isFailure: boolean;
  isSandboxBlock: boolean;
  exitCode: string;
  message: string;
} {
  const bgMatch = /Tool is running as a background task(?: with task id:\s*([^\s\n]+))?/i.exec(
    content,
  );
  if (bgMatch) {
    return {
      isBackground: true,
      taskId: bgMatch[1] ?? '',
      isFailure: false,
      isSandboxBlock: false,
      exitCode: '',
      message: '',
    };
  }

  const exitMatch = /Command exited with code (\d+)\./.exec(content);
  const exitCode = exitMatch ? exitMatch[1] : '';
  const nonZeroExit = exitCode !== '' && exitCode !== '0';

  const explicitToolErr = /^Encountered error in tool execution:\s*(.+)$/m.exec(content);
  const hasFailedStatus =
    status === 'ERROR' || Boolean(errorField.trim()) || Boolean(explicitToolErr) || nonZeroExit;

  if (!hasFailedStatus) {
    return {
      isBackground: false,
      taskId: '',
      isFailure: false,
      isSandboxBlock: false,
      exitCode: '0',
      message: '',
    };
  }

  // Extract command output body (ignoring Jetski's generic wrapper boilerplate)
  const cmdOutIdx = content.indexOf('Command output:');
  const bodyText =
    cmdOutIdx >= 0 ? content.slice(cmdOutIdx + 'Command output:'.length).trim() : content;
  const combinedErr = `${errorField}\n${explicitToolErr?.[1] ?? ''}\n${bodyText}`;

  const hasHardSandboxSignature =
    /operation not permitted|EPERM|Permission denied for read_file|Permission prompt for action|Read-only file system/i.test(
      combinedErr,
    ) ||
    (/Reason:[\s\S]{0,120}Path:[\s\S]{0,120}Identifier:/i.test(combinedErr) &&
      exitCode === '137');

  const hasWrapperSandboxHint = /sandbox errors that may or may not be related/i.test(content);
  const isSandboxExitCode =
    exitCode === '126' ||
    exitCode === '127' ||
    exitCode === '137' ||
    exitCode === '6' ||
    exitCode === '7';
  const hasWrapperOnlyBlock =
    hasWrapperSandboxHint &&
    (isSandboxExitCode ||
      bodyText.length === 0 ||
      /permission denied|EACCES/i.test(bodyText));

  const isSandboxBlock = hasHardSandboxSignature || hasWrapperOnlyBlock;

  let message =
    firstLine(errorField) ||
    firstLine(explicitToolErr?.[1] ?? '') ||
    firstLine(bodyText) ||
    (exitCode ? `Command exited with code ${exitCode}` : 'Tool error');
  if (message.length > 160) message = message.slice(0, 159) + '…';

  return {
    isBackground: false,
    taskId: '',
    isFailure: !isSandboxBlock,
    isSandboxBlock,
    exitCode,
    message,
  };
}

export function processTranscriptEvent(stats: SessionStats, evt: JsonObject): void {
  const type = typeof evt.type === 'string' ? evt.type : '';
  const ts = typeof evt.created_at === 'string' ? evt.created_at : '';
  const stepIndex = typeof evt.step_index === 'number' ? evt.step_index : -1;

  if (ts) {
    if (!stats.startTime) stats.startTime = ts;
    stats.lastActivity = ts;
    const tsMs = parseTimestampMs(ts);
    if (tsMs > 0) {
      if (stats.lastEventTimestampMs > 0 && tsMs > stats.lastEventTimestampMs) {
        const delta = tsMs - stats.lastEventTimestampMs;
        stats.activeDurationMs += Math.min(delta, ACTIVE_GAP_CAP_MS);
      }
      stats.lastEventTimestampMs = Math.max(stats.lastEventTimestampMs, tsMs);
    }
  }

  switch (type) {
    case 'USER_INPUT': {
      stats.pendingTools = [];
      const content = typeof evt.content === 'string' ? evt.content : '';
      const isSystemWakeup =
        content.includes('<SYSTEM_MESSAGE>') && !content.includes('<USER_REQUEST>');

      if (isSystemWakeup) {
        stats.wakeupCount++;
      } else {
        stats.turnCount.user++;
        if (!stats.firstUserRequest && content.trim()) {
          stats.firstUserRequest = extractUserRequestText(content);
        }
        const slashMatch = /(?:^|\n)\s*\/([a-z0-9][a-z0-9_-]{1,40})(?:\s|$)/.exec(
          content.includes('<USER_REQUEST>') ? extractUserRequestText(content) : content,
        );
        if (slashMatch) {
          const skName = slashMatch[1];
          if (!stats.skills.some((s) => s.name === skName)) {
            stats.skills.push({ name: skName, timestamp: ts });
          }
        }
      }
      break;
    }

    case 'PLANNER_RESPONSE': {
      // Reconcile any leftover pendingTools from earlier steps so cancelled steps never drift
      stats.pendingTools = [];
      stats.turnCount.assistant++;
      if (stepIndex >= 0) stats.lastAssistantStep = stepIndex;

      const inTok = typeof evt.input_tokens === 'number' ? evt.input_tokens : 0;
      const cacheTok = typeof evt.cache_read_tokens === 'number' ? evt.cache_read_tokens : 0;
      const outTok = typeof evt.output_tokens === 'number' ? evt.output_tokens : 0;

      stats.totalInputTokens += inTok;
      stats.totalCacheReadTokens += cacheTok;
      stats.totalOutputTokens += outTok;

      const ctx = inTok + cacheTok;
      if (ctx > 0) {
        stats.lastInputTokens = inTok;
        stats.lastCacheReadTokens = cacheTok;
        stats.currentContextTokens = ctx;
        if (ctx > stats.peakContextTokens) stats.peakContextTokens = ctx;
      }

      const toolCalls = Array.isArray(evt.tool_calls) ? evt.tool_calls : [];
      toolCalls.forEach((rawTc, ordinal) => {
        if (!isObject(rawTc)) return;
        const name = typeof rawTc.name === 'string' && rawTc.name ? rawTc.name : 'unknown';
        const args = isObject(rawTc.args) ? rawTc.args : {};

        const existing = stats.tools.get(name);
        if (existing) {
          existing.count++;
          existing.lastTs = ts;
        } else {
          stats.tools.set(name, {
            name,
            count: 1,
            failed: 0,
            sandboxBlocked: 0,
            lastTs: ts,
          });
        }

        // Skill file read detection
        if (name === 'read_file' || name === 'view_file') {
          const targetPath = cleanArgString(args.Path ?? args.AbsolutePath ?? '');
          const skName = extractSkillFromPath(targetPath);
          if (skName && !stats.skills.some((s) => s.name === skName)) {
            stats.skills.push({ name: skName, timestamp: ts });
          }
        }

        // MCP server usage detection
        let mcpServer = '';
        if (name === 'call_mcp_tool') {
          mcpServer = cleanArgString(args.ServerName ?? '');
        } else if (name.startsWith('mcp_')) {
          const rest = name.slice('mcp_'.length);
          const sepIdx = rest.indexOf('_');
          mcpServer = sepIdx > 0 ? rest.slice(0, sepIdx) : rest;
        }
        if (mcpServer) {
          stats.mcpUsed.set(mcpServer, (stats.mcpUsed.get(mcpServer) ?? 0) + 1);
        }

        const summary =
          cleanArgString(args.toolSummary) ||
          cleanArgString(args.Role) ||
          basename(cleanArgString(args.Path ?? '')) ||
          '';

        stats.pendingTools.push({
          stepIndex,
          ordinal,
          name,
          summary,
          startTs: ts,
          ...(mcpServer ? { mcpServer } : {}),
        });
      });
      break;
    }

    case 'GENERIC': {
      const source = typeof evt.source === 'string' ? evt.source : 'MODEL';
      if (source !== 'MODEL') break;

      const completed = stats.pendingTools.shift();
      const toolName = completed?.name ?? 'tool';
      const content = typeof evt.content === 'string' ? evt.content : '';
      const errorField = typeof evt.error === 'string' ? evt.error : '';
      const status = typeof evt.status === 'string' ? evt.status : '';

      const outcome = classifyGenericResult(content, errorField, status);
      if (outcome.isBackground) {
        stats.backgroundEvents.push({
          taskId: outcome.taskId,
          toolName,
          summary: completed?.summary ?? '',
          ts,
          stepIndex,
        });
        if (stats.backgroundEvents.length > 10) {
          stats.backgroundEvents = stats.backgroundEvents.slice(-10);
        }
        break;
      }

      if (outcome.isSandboxBlock) {
        if (completed?.mcpServer) {
          stats.mcpFailed.set(
            completed.mcpServer,
            (stats.mcpFailed.get(completed.mcpServer) ?? 0) + 1,
          );
        }
        const stat = stats.tools.get(toolName);
        if (stat) stat.sandboxBlocked++;
        stats.sandboxBlocks.push({
          name: toolName,
          ts,
          stepIndex,
          exitCode: outcome.exitCode,
          message: outcome.message,
        });
        if (stats.sandboxBlocks.length > 10) {
          stats.sandboxBlocks = stats.sandboxBlocks.slice(-10);
        }
      } else if (outcome.isFailure) {
        if (completed?.mcpServer) {
          stats.mcpFailed.set(
            completed.mcpServer,
            (stats.mcpFailed.get(completed.mcpServer) ?? 0) + 1,
          );
        }
        const stat = stats.tools.get(toolName);
        if (stat) stat.failed++;
        stats.toolFailures.push({
          name: toolName,
          ts,
          stepIndex,
          exitCode: outcome.exitCode,
          message: outcome.message,
        });
        if (stats.toolFailures.length > 10) {
          stats.toolFailures = stats.toolFailures.slice(-10);
        }
      }
      break;
    }

    case 'CHECKPOINT': {
      stats.compactions++;
      stats.pendingTools = [];
      break;
    }

    case 'ERROR_MESSAGE': {
      stats.pendingTools = [];
      if (stepIndex >= 0) stats.lastApiErrorStep = stepIndex;
      const errText =
        typeof evt.error === 'string' && evt.error.trim()
          ? evt.error.trim()
          : typeof evt.content === 'string' && evt.content.trim()
            ? evt.content.trim()
            : 'API error';
      const isQuota = /RESOURCE_EXHAUSTED|quota|429|rate.?limit/i.test(errText);
      stats.apiErrors.push({
        ts,
        stepIndex,
        message: firstLine(errText),
        isQuota,
      });
      if (stats.apiErrors.length > 10) {
        stats.apiErrors = stats.apiErrors.slice(-10);
      }
      break;
    }
  }
}

function processTranscriptLines(text: string, stats: SessionStats): void {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isObject(parsed)) processTranscriptEvent(stats, parsed);
    } catch {
      /* skip malformed JSON line */
    }
  }
}

/**
 * Reads bytes `[fromOffset, totalSize)` of `transcriptFile` in chunks and splits
 * strictly on `0x0a` (`\n`) in `Buffer` space so multi-byte UTF-8 sequences are
 * never torn across chunk boundaries and partial tail lines are retried next tick.
 */
export function parseTranscriptRange(
  transcriptFile: string,
  fromOffset: number,
  totalSize: number,
  stats: SessionStats,
  chunkSize: number = READ_CHUNK_BYTES,
): number {
  const remaining = totalSize - fromOffset;
  if (remaining <= 0) return fromOffset;

  const fd = openSync(transcriptFile, 'r');
  let totalRead = 0;
  let carry: Buffer = Buffer.alloc(0);

  try {
    const bufSize = Math.max(16, Math.min(chunkSize, remaining));
    const buf = Buffer.allocUnsafe(bufSize);
    let left = remaining;

    while (left > 0) {
      const want = Math.min(buf.length, left);
      const n = readSync(fd, buf, 0, want, fromOffset + totalRead);
      if (n <= 0) break;
      totalRead += n;
      left -= n;

      const chunk =
        carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl < 0) {
        carry = Buffer.from(chunk);
        continue;
      }

      processTranscriptLines(chunk.subarray(0, lastNl + 1).toString('utf-8'), stats);
      carry = Buffer.from(chunk.subarray(lastNl + 1));
    }
  } finally {
    closeSync(fd);
  }

  return fromOffset + totalRead - carry.length;
}

function serializeStats(s: SessionStats): SerializedSessionStats {
  return {
    ...s,
    tools: Array.from(s.tools.entries()),
    mcpUsed: Array.from(s.mcpUsed.entries()),
    mcpFailed: Array.from(s.mcpFailed.entries()),
  };
}

function deserializeStats(s: Partial<SerializedSessionStats>): SessionStats {
  const base = freshStats();
  return {
    ...base,
    ...s,
    turnCount: s.turnCount ?? base.turnCount,
    tools: new Map(s.tools ?? []),
    mcpUsed: new Map(s.mcpUsed ?? []),
    mcpFailed: new Map(s.mcpFailed ?? []),
    pendingTools: s.pendingTools ?? [],
    toolFailures: s.toolFailures ?? [],
    sandboxBlocks: s.sandboxBlocks ?? [],
    apiErrors: s.apiErrors ?? [],
    skills: s.skills ?? [],
    backgroundEvents: s.backgroundEvents ?? [],
  };
}

function readSessionCache(cacheDir: string, cacheKey: string): CacheEntry | null {
  const p = join(cacheDir, `${cacheKey}.json`);
  if (!existsSync(p)) return null;
  try {
    const entry = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    if (!isObject(entry) || entry.v !== CACHE_VERSION) return null;
    return entry as unknown as CacheEntry;
  } catch {
    return null;
  }
}

function writeSessionCache(cacheDir: string, cacheKey: string, entry: CacheEntry): void {
  ensureCacheDir(cacheDir);
  try {
    writeFileSync(join(cacheDir, `${cacheKey}.json`), JSON.stringify(entry));
  } catch {
    /* best-effort */
  }
}

export function loadStats(
  session: DiscoveredSession,
  cacheDir: string,
  chunkSize: number = READ_CHUNK_BYTES,
): SessionStats {
  const transcriptFile = join(
    session.brainDir,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );

  let st;
  try {
    st = statSync(transcriptFile);
  } catch {
    return freshStats();
  }

  const cache = readSessionCache(cacheDir, session.cacheKey);

  if (
    cache &&
    cache.inode === st.ino &&
    cache.size === st.size &&
    cache.mtimeMs === st.mtimeMs
  ) {
    return deserializeStats(cache.stats);
  }

  if (
    cache &&
    cache.inode === st.ino &&
    st.size > cache.size &&
    cache.lastOffset <= st.size
  ) {
    const stats = deserializeStats(cache.stats);
    const newOffset = parseTranscriptRange(
      transcriptFile,
      cache.lastOffset,
      st.size,
      stats,
      chunkSize,
    );
    writeSessionCache(cacheDir, session.cacheKey, {
      v: CACHE_VERSION,
      inode: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      lastOffset: newOffset,
      cachedAt: Date.now(),
      model: cache.model ?? 'unknown',
      modelStepCount: cache.modelStepCount ?? -1,
      stats: serializeStats(stats),
    });
    return stats;
  }

  const stats = freshStats();
  const newOffset = parseTranscriptRange(transcriptFile, 0, st.size, stats, chunkSize);
  writeSessionCache(cacheDir, session.cacheKey, {
    v: CACHE_VERSION,
    inode: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    lastOffset: newOffset,
    cachedAt: Date.now(),
    model: cache?.model ?? 'unknown',
    modelStepCount: cache?.modelStepCount ?? -1,
    stats: serializeStats(stats),
  });
  return stats;
}

export function pruneCache(cacheDir: string, validCacheKeys: Set<string>): void {
  if (!existsSync(cacheDir)) return;
  try {
    for (const f of readdirSync(cacheDir)) {
      if (!f.endsWith('.json')) continue;
      if (RESERVED_CACHE_FILES.has(f)) continue;
      const key = f.slice(0, -'.json'.length);
      if (!validCacheKeys.has(key)) {
        try {
          unlinkSync(join(cacheDir, f));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

// ── Phase 4 Enrichment Readers ─────────────────────────────────────────

function countTotalToolCalls(stats: SessionStats): number {
  let sum = 0;
  for (const t of stats.tools.values()) sum += t.count;
  return sum;
}

function countTotalTokens(stats: SessionStats): number {
  return stats.totalInputTokens + stats.totalCacheReadTokens + stats.totalOutputTokens;
}

export function readSwarmInfo(
  session: DiscoveredSession,
  allById: Map<string, DiscoveredSession>,
  cacheDir: string,
  isRootLive: boolean,
  modelsCache: Record<string, ModelCacheEntry>,
): { swarm: SwarmInfo | null; modelsDirty: boolean } {
  const swarmBrainDir =
    existsSync(join(session.brainDir, '.system_generated', 'swarm', 'members.json'))
      ? session.brainDir
      : session.rootId !== session.id
        ? join(session.rootPath, 'brain', session.rootId)
        : session.brainDir;

  const swarmDir = join(swarmBrainDir, '.system_generated', 'swarm');
  const membersPath = join(swarmDir, 'members.json');
  if (!existsSync(membersPath)) return { swarm: null, modelsDirty: false };

  let modelsDirty = false;
  try {
    const membersRaw = JSON.parse(readFileSync(membersPath, 'utf-8')) as unknown;
    if (!isObject(membersRaw) || !isObject(membersRaw.members)) {
      return { swarm: null, modelsDirty: false };
    }

    let swarmId = basename(swarmBrainDir);
    const swarmJsonPath = join(swarmDir, 'swarm.json');
    if (existsSync(swarmJsonPath)) {
      try {
        const sj = JSON.parse(readFileSync(swarmJsonPath, 'utf-8')) as unknown;
        if (isObject(sj) && typeof sj.swarm_id === 'string' && sj.swarm_id) {
          swarmId = sj.swarm_id;
        }
      } catch {
        /* ignore */
      }
    }

    let headSeq = 0;
    let statusTag = '';
    const recentPosts: SwarmBoardPost[] = [];
    const boardPath = join(swarmDir, 'board.jsonl');
    if (existsSync(boardPath)) {
      try {
        const lines = readFileSync(boardPath, 'utf-8').split('\n').filter(Boolean);
        for (const l of lines) {
          try {
            const p = JSON.parse(l) as unknown;
            if (!isObject(p)) continue;
            const seq = typeof p.seq === 'number' ? p.seq : 0;
            const agent = typeof p.agent === 'string' ? p.agent : 'agent';
            const text = typeof p.text === 'string' ? p.text : '';
            if (seq > headSeq) headSeq = seq;
            if (/\[stall\]/i.test(text)) statusTag = '[stall]';
            else if (/\[done\]/i.test(text)) statusTag = '[done]';
            recentPosts.push({ seq, agent, text });
          } catch {
            /* skip malformed board row */
          }
        }
      } catch {
        /* ignore */
      }
    }

    const members: SwarmMemberEntry[] = [];
    for (const [handle, rawVal] of Object.entries(membersRaw.members)) {
      if (!isObject(rawVal)) continue;
      const conversationId = String(rawVal.conversation_id ?? '').trim();
      const role = String(rawVal.role ?? 'worker');
      const killed = Boolean(rawVal.killed);
      const childSession = conversationId ? allById.get(conversationId) : undefined;

      let phase = String(rawVal.phase ?? rawVal.desired_state ?? 'UNKNOWN');
      if (killed || childSession?.killed) {
        phase = 'KILLED';
      } else if (
        childSession &&
        (childSession.notFullyIdle || childSession.status === 'CASCADE_RUN_STATUS_RUNNING')
      ) {
        phase = 'RUNNING';
      }

      let model = String(
        rawVal.applied_model || rawVal.model || rawVal.desired_model || '',
      ).trim();
      if (!model && childSession) {
        const res = resolveSessionModel(childSession, isRootLive, modelsCache);
        model = res.model;
        if (res.dirty) modelsDirty = true;
      }

      let toolCalls = 0;
      let totalTokens = 0;
      if (childSession && conversationId !== session.id) {
        const childStats = loadStats(childSession, cacheDir);
        toolCalls = countTotalToolCalls(childStats);
        totalTokens = countTotalTokens(childStats);
      }

      const lastReadSeq = typeof rawVal.last_read_seq === 'number' ? rawVal.last_read_seq : 0;
      const unreadLag = !killed && headSeq > lastReadSeq ? headSeq - lastReadSeq : 0;

      members.push({
        handle,
        conversationId,
        role,
        phase,
        desiredState: String(rawVal.desired_state ?? ''),
        model: model || 'default',
        lastReadSeq,
        unreadLag,
        killed,
        toolCalls,
        totalTokens,
      });
    }

    const title = typeof membersRaw.title === 'string' ? membersRaw.title.trim() : '';
    return {
      swarm: {
        swarmId,
        title,
        headSeq,
        statusTag,
        members,
        recentPosts: recentPosts.slice(-4),
      },
      modelsDirty,
    };
  } catch {
    return { swarm: null, modelsDirty };
  }
}

export function readSubagents(
  session: DiscoveredSession,
  allById: Map<string, DiscoveredSession>,
  swarmMemberIds: Set<string>,
  cacheDir: string,
  isRootLive: boolean,
  modelsCache: Record<string, ModelCacheEntry>,
): { subagents: SubagentEntry[]; modelsDirty: boolean } {
  const subagentsDir = join(session.brainDir, '.system_generated', 'subagents');
  const byId = new Map<string, SubagentEntry>();
  let modelsDirty = false;

  if (existsSync(subagentsDir)) {
    try {
      for (const f of readdirSync(subagentsDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(readFileSync(join(subagentsDir, f), 'utf-8')) as unknown;
          if (!isObject(raw)) continue;
          const convId = String(raw.conversationId ?? f.slice(0, -'.json'.length)).trim();
          if (!convId || swarmMemberIds.has(convId)) continue;
          const desc = isObject(raw.subagentDescriptor) ? raw.subagentDescriptor : {};
          const typeName = String(desc.typeName ?? 'subagent');
          const role = String(desc.role ?? typeName);
          const state = String(raw.state ?? '');
          const spawnStepIndex =
            typeof raw.spawnStepIndex === 'number' ? raw.spawnStepIndex : 0;

          byId.set(convId, {
            conversationId: convId,
            typeName,
            role,
            state,
            spawnStepIndex,
            isActive: /RUNNING|ACTIVE/i.test(state),
            isKilled: /KILLED/i.test(state),
            model: 'unknown',
            durationMs: 0,
            toolCalls: 0,
            totalTokens: 0,
          });
        } catch {
          /* skip bad subagent json */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Also attach direct SQLite children not already represented in swarm or subagents dir
  for (const childId of session.childIds) {
    if (swarmMemberIds.has(childId) || byId.has(childId)) continue;
    const child = allById.get(childId);
    if (!child || child.parentConversationId !== session.id) continue;
    byId.set(childId, {
      conversationId: childId,
      typeName: child.agentName || 'subagent',
      role: child.title || child.agentName || 'Subagent',
      state: child.status,
      spawnStepIndex: 0,
      isActive: false,
      isKilled: child.killed,
      model: 'unknown',
      durationMs: 0,
      toolCalls: 0,
      totalTokens: 0,
    });
  }

  for (const [convId, entry] of byId) {
    const child = allById.get(convId);
    if (child) {
      const childLive =
        !child.killed &&
        (child.notFullyIdle || child.status === 'CASCADE_RUN_STATUS_RUNNING') &&
        session.liveness === 'working';
      entry.isActive = childLive;
      entry.isKilled = entry.isKilled || child.killed;
      const mRes = resolveSessionModel(child, isRootLive, modelsCache);
      entry.model = mRes.model;
      if (mRes.dirty) modelsDirty = true;

      const cStats = loadStats(child, cacheDir);
      entry.toolCalls = countTotalToolCalls(cStats);
      entry.totalTokens = countTotalTokens(cStats);
      const sMs = parseTimestampMs(cStats.startTime);
      const eMs = parseTimestampMs(cStats.lastActivity);
      entry.durationMs = sMs > 0 && eMs >= sMs ? eMs - sMs : cStats.activeDurationMs;
    } else {
      // Child conversation exists on disk without summary row
      const childBrain = join(session.rootPath, 'brain', convId);
      if (existsSync(childBrain)) {
        const synthChild: DiscoveredSession = {
          ...session,
          id: convId,
          cacheKey: makeSessionCacheKey(session.rootPath, convId),
          brainDir: childBrain,
          childIds: [],
        };
        const cStats = loadStats(synthChild, cacheDir);
        entry.toolCalls = countTotalToolCalls(cStats);
        entry.totalTokens = countTotalTokens(cStats);
        entry.durationMs = cStats.activeDurationMs;
      }
    }
  }

  const subagents = Array.from(byId.values()).sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.spawnStepIndex - a.spawnStepIndex;
  });

  return { subagents, modelsDirty };
}

export function readInboxMessages(
  session: DiscoveredSession,
  senderLabels: Map<string, string>,
): InboxMessage[] {
  const msgDir = join(session.brainDir, '.system_generated', 'messages');
  if (!existsSync(msgDir)) return [];

  let readMap: Record<string, boolean> = {};
  const readJsonPath = join(msgDir, 'read.json');
  if (existsSync(readJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(readJsonPath, 'utf-8')) as unknown;
      if (isObject(parsed)) readMap = parsed as Record<string, boolean>;
    } catch {
      /* ignore */
    }
  }

  const undeliveredIds = new Set<string>();
  const undeliveredDir = join(msgDir, 'undelivered');
  if (existsSync(undeliveredDir)) {
    try {
      for (const f of readdirSync(undeliveredDir)) {
        if (f.endsWith('.json')) undeliveredIds.add(f.slice(0, -'.json'.length));
      }
    } catch {
      /* ignore */
    }
  }

  let files: Array<{ name: string; mtimeMs: number }> = [];
  try {
    for (const f of readdirSync(msgDir)) {
      if (!f.endsWith('.json') || f === 'read.json') continue;
      try {
        files.push({ name: f, mtimeMs: statSync(join(msgDir, f)).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  } catch {
    return [];
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  files = files.slice(0, 15);

  const out: InboxMessage[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(msgDir, f.name), 'utf-8')) as unknown;
      if (!isObject(raw)) continue;
      if (raw.hideFromUser === true) continue;

      const id = String(raw.id ?? f.name.slice(0, -'.json'.length));
      const sender = String(raw.sender ?? 'agent');
      let senderLabel = senderLabels.get(sender) ?? '';
      if (!senderLabel) {
        const taskMatch = /\/(task-\d+)$/.exec(sender);
        if (taskMatch) senderLabel = taskMatch[1];
        else senderLabel = sender.length > 12 ? `${sender.slice(0, 8)}…` : sender;
      }

      const renderDetails = isObject(raw.renderDetails) ? raw.renderDetails : {};
      const title =
        typeof renderDetails.messageTitle === 'string' ? renderDetails.messageTitle : '';
      const content = typeof raw.content === 'string' ? raw.content : '';
      const summary = title || firstLine(content) || 'Message';
      const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : '';
      const timestampMs = parseTimestampMs(timestamp) || f.mtimeMs;
      const unread = undeliveredIds.has(id) || readMap[id] !== true;

      out.push({
        id,
        sender,
        senderLabel,
        title,
        summary,
        timestamp,
        timestampMs,
        unread,
      });
    } catch {
      /* skip malformed message */
    }
  }

  out.sort((a, b) => b.timestampMs - a.timestampMs);
  return out.slice(0, 8);
}

export function readBackgroundTasks(
  session: DiscoveredSession,
  stats: SessionStats,
  now: number,
): BackgroundTaskItem[] {
  const tasksDir = join(session.brainDir, '.system_generated', 'tasks');
  const eventByStep = new Map<string, BackgroundTaskEvent>();
  for (const ev of stats.backgroundEvents) {
    const taskSuffix = ev.taskId.includes('/') ? ev.taskId.split('/').pop()! : ev.taskId;
    if (taskSuffix) eventByStep.set(taskSuffix, ev);
    if (ev.stepIndex >= 0) eventByStep.set(`task-${ev.stepIndex}`, ev);
  }

  const items: BackgroundTaskItem[] = [];
  if (existsSync(tasksDir)) {
    try {
      for (const f of readdirSync(tasksDir)) {
        if (!f.endsWith('.log')) continue;
        const full = join(tasksDir, f);
        try {
          const st = statSync(full);
          const name = f.slice(0, -'.log'.length);
          const meta = eventByStep.get(name);
          items.push({
            name,
            logPath: full,
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            summary: meta?.summary || meta?.toolName || '',
            isRecent: now - st.mtimeMs < 120_000,
          });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items.slice(0, 8);
}

export function parseGfmChecklist(filePath: string): ChecklistSummary | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, 'utf-8');
    let done = 0;
    let inProgress = 0;
    let pending = 0;
    const items: ChecklistSummary['items'] = [];

    for (const line of text.split('\n')) {
      const m = /^\s*[-*]\s+\[([ xX/])\]\s+(.+)$/.exec(line);
      if (!m) continue;
      const mark = m[1];
      const label = m[2].replace(/\*\*/g, '').trim();
      if (mark === 'x' || mark === 'X') {
        done++;
        items.push({ status: 'done', text: label });
      } else if (mark === '/') {
        inProgress++;
        items.push({ status: 'in_progress', text: label });
      } else {
        pending++;
        items.push({ status: 'pending', text: label });
      }
    }

    const total = done + inProgress + pending;
    if (total === 0) return null;
    return { sourcePath: filePath, done, inProgress, pending, total, items };
  } catch {
    return null;
  }
}

export function readArtifactsAndChecklist(session: DiscoveredSession): {
  artifacts: ArtifactItem[];
  checklist: ChecklistSummary | null;
} {
  const artifacts: ArtifactItem[] = [];
  if (existsSync(session.brainDir)) {
    try {
      for (const f of readdirSync(session.brainDir)) {
        if (!f.endsWith('.md')) continue;
        const mdPath = join(session.brainDir, f);
        const metaPath = `${mdPath}.metadata.json`;
        let summary = '';
        let updatedAt = '';
        let userFacing = true;
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as unknown;
            if (isObject(meta)) {
              summary = typeof meta.summary === 'string' ? firstLine(meta.summary) : '';
              updatedAt = typeof meta.updatedAt === 'string' ? meta.updatedAt : '';
              userFacing = meta.userFacing !== false;
            }
          } catch {
            /* ignore */
          }
        }
        artifacts.push({
          name: f,
          filePath: mdPath,
          summary,
          updatedAt,
          userFacing,
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Prefer brain task.md / plan.md checklist if present, else workspace PLAN.md / task.md
  const checklistCandidates: string[] = [
    join(session.brainDir, 'task.md'),
    join(session.brainDir, 'plan.md'),
  ];
  if (session.workspace.cwd) {
    checklistCandidates.push(
      join(session.workspace.cwd, 'PLAN.md'),
      join(session.workspace.cwd, 'task.md'),
    );
  }
  if (session.workspace.gitRoot && session.workspace.gitRoot !== session.workspace.cwd) {
    checklistCandidates.push(
      join(session.workspace.gitRoot, 'PLAN.md'),
      join(session.workspace.gitRoot, 'task.md'),
    );
  }

  let checklist: ChecklistSummary | null = null;
  for (const cand of checklistCandidates) {
    checklist = parseGfmChecklist(cand);
    if (checklist) break;
  }

  return { artifacts, checklist };
}

function countMcpToolSchemas(serverDir: string): number {
  if (!existsSync(serverDir)) return 0;
  try {
    let count = 0;
    for (const f of readdirSync(serverDir)) {
      if (!f.startsWith('.') && f.endsWith('.json')) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function readPluginEnablementMap(configDir: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const cfgFile = join(configDir, 'config.json');
  if (!existsSync(cfgFile)) return out;
  try {
    const parsed = JSON.parse(readFileSync(cfgFile, 'utf-8')) as unknown;
    if (isObject(parsed) && isObject(parsed.plugins)) {
      for (const [pluginName, val] of Object.entries(parsed.plugins)) {
        if (isObject(val) && typeof val.enabled === 'boolean') {
          out.set(pluginName, val.enabled);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function readCustomizations(
  session: DiscoveredSession,
  cfg: MonitorConfig,
  stats?: Pick<SessionStats, 'mcpUsed' | 'mcpFailed'>,
): CustomizationSummary {
  const rules: RuleFileItem[] = [];
  const seen = new Set<string>();
  const home = homedir();

  const checkRuleFile = (base: string, rel: string, label: string, scope: 'repo' | 'global') => {
    if (!base || !existsSync(base)) return;
    const full = join(base, rel);
    if (seen.has(full) || !existsSync(full)) return;
    seen.add(full);
    const display =
      scope === 'repo'
        ? rel
        : full.startsWith(home)
          ? '~' + full.slice(home.length)
          : full;
    rules.push({ path: display, label, scope });
  };

  const scanRuleDir = (
    dir: string,
    label: string,
    scope: 'repo' | 'global',
    relPrefix?: string,
  ) => {
    if (!dir || !existsSync(dir)) return;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md') && !f.endsWith('.mdc')) continue;
        const full = join(dir, f);
        if (seen.has(full)) continue;
        seen.add(full);
        const display = relPrefix
          ? `${relPrefix}/${f}`
          : full.startsWith(home)
            ? '~' + full.slice(home.length)
            : full;
        rules.push({ path: display, label, scope });
      }
    } catch {
      /* ignore */
    }
  };

  const repoBases = [session.workspace.gitRoot, session.workspace.cwd].filter(Boolean);
  for (const base of repoBases) {
    checkRuleFile(base, 'AGENTS.md', 'Agents', 'repo');
    checkRuleFile(base, 'GEMINI.md', 'Gemini', 'repo');
    checkRuleFile(base, 'CLAUDE.md', 'Claude', 'repo');
    checkRuleFile(base, '.cursorrules', 'Cursor', 'repo');
    checkRuleFile(base, '.github/copilot-instructions.md', 'Copilot', 'repo');
    scanRuleDir(join(base, '.agents', 'rules'), 'Rule', 'repo', '.agents/rules');
    scanRuleDir(join(base, '_agents', 'rules'), 'Rule', 'repo', '_agents/rules');
  }

  checkRuleFile(cfg.configDir, 'AGENTS.md', 'Global', 'global');
  checkRuleFile(cfg.configDir, 'GEMINI.md', 'Global', 'global');
  scanRuleDir(join(cfg.configDir, 'rules'), 'Global', 'global');

  const hooks: Array<{ name: string; events: string[] }> = [];
  const hooksFile = join(cfg.configDir, 'hooks.json');
  if (existsSync(hooksFile)) {
    try {
      const rawHooks = JSON.parse(readFileSync(hooksFile, 'utf-8')) as unknown;
      if (isObject(rawHooks)) {
        for (const [hookName, val] of Object.entries(rawHooks)) {
          if (isObject(val)) {
            hooks.push({ name: hookName, events: Object.keys(val) });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Collect MCP server enablement from enabled plugins, global config, and workspace config.
  const pluginEnablement = readPluginEnablementMap(cfg.configDir);
  const mcpConfigFiles: string[] = [];

  const builtinPluginsDir = join(session.rootPath, 'builtin', 'plugins');
  if (existsSync(builtinPluginsDir)) {
    try {
      for (const entry of readdirSync(builtinPluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (pluginEnablement.get(entry.name) !== true) continue;
        mcpConfigFiles.push(join(builtinPluginsDir, entry.name, 'mcp_config.json'));
      }
    } catch {
      /* ignore */
    }
  }

  const userPluginsDir = join(cfg.configDir, 'plugins');
  if (existsSync(userPluginsDir)) {
    try {
      for (const entry of readdirSync(userPluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (pluginEnablement.get(entry.name) === false) continue;
        mcpConfigFiles.push(join(userPluginsDir, entry.name, 'mcp_config.json'));
      }
    } catch {
      /* ignore */
    }
  }

  mcpConfigFiles.push(join(cfg.configDir, 'mcp_config.json'));
  for (const base of repoBases) {
    mcpConfigFiles.push(
      join(base, 'mcp_config.json'),
      join(base, '.gemini', 'mcp_config.json'),
    );
  }

  const configuredMcp = new Map<string, boolean>();
  let foundAnyMcpConfig = false;
  const seenMcpFiles = new Set<string>();

  for (const mcpFile of mcpConfigFiles) {
    if (seenMcpFiles.has(mcpFile) || !existsSync(mcpFile)) continue;
    seenMcpFiles.add(mcpFile);
    try {
      const rawMcp = JSON.parse(readFileSync(mcpFile, 'utf-8')) as unknown;
      if (isObject(rawMcp) && isObject(rawMcp.mcpServers)) {
        foundAnyMcpConfig = true;
        for (const [srvName, srvVal] of Object.entries(rawMcp.mcpServers)) {
          const isDisabled =
            isObject(srvVal) && (srvVal.disabled === true || srvVal.enabled === false);
          configuredMcp.set(srvName, !isDisabled);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const rootMcpDir = join(session.rootPath, 'mcp');
  // Fall back to <root>/mcp/* directories only when no mcp_config.json exists at all.
  if (!foundAnyMcpConfig && existsSync(rootMcpDir)) {
    try {
      for (const entry of readdirSync(rootMcpDir, { withFileTypes: true })) {
        if (entry.isDirectory()) configuredMcp.set(entry.name, true);
      }
    } catch {
      /* ignore */
    }
  }

  // Include servers actively called in this session unless explicitly disabled in config.
  if (stats?.mcpUsed) {
    for (const [srvName, calls] of stats.mcpUsed.entries()) {
      if (calls > 0 && configuredMcp.get(srvName) !== false) {
        configuredMcp.set(srvName, true);
      }
    }
  }

  const mcpWorking: McpServerEntry[] = [];
  for (const [srvName, isEnabled] of configuredMcp.entries()) {
    if (!isEnabled) continue;
    const toolCount = countMcpToolSchemas(join(rootMcpDir, srvName));
    const totalCalls = stats?.mcpUsed.get(srvName) ?? 0;
    const failedCalls = stats?.mcpFailed.get(srvName) ?? 0;
    const okCalls = Math.max(0, totalCalls - failedCalls);

    if (totalCalls > 0 && okCalls === 0) continue;
    if (toolCount === 0 && okCalls === 0) continue;

    mcpWorking.push({
      name: srvName,
      toolCount,
      calls: okCalls,
    });
  }

  mcpWorking.sort((a, b) => a.name.localeCompare(b.name));

  return {
    rules,
    hooks,
    mcpWorking,
  };
}

// ── Formatting & SwiftBar Output Choke Point ───────────────────────────

export function sanitizeLabel(text: string): string {
  return text.replace(/\|/g, '│').replace(/\p{Cc}/gu, ' ');
}

export function sanitizeParam(value: string): string {
  return value.replace(/["\\]/g, '').replace(/\p{Cc}/gu, ' ');
}

export type LineSink = (line: string) => void;

let activeSink: LineSink = (line: string) => {
  console.log(line);
};

export function emit(label: string, params = '', sink: LineSink = activeSink): void {
  const safe = sanitizeLabel(label);
  if (!params) {
    sink(safe);
    return;
  }
  sink(safe ? `${safe} | ${params}` : `| ${params}`);
}

export function sep(sink: LineSink = activeSink): void {
  sink('---');
}

export function firstLine(s: string): string {
  for (const line of String(s).split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatMs(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function formatAgeFromMs(tsMs: number, now: number): string {
  if (tsMs <= 0) return '?';
  return formatMs(Math.max(0, now - tsMs));
}

function formatTime(iso: string): string {
  const ms = parseTimestampMs(iso);
  if (ms <= 0) return '??:??:??';
  try {
    return new Date(ms).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '??:??:??';
  }
}

export function actionParams(args: string[], wrapperPath: string): string {
  const parts: string[] = [];
  if (wrapperPath) {
    parts.push(`bash="${sanitizeParam(wrapperPath)}"`);
    args.forEach((a, i) => parts.push(`param${i + 1}="${sanitizeParam(a)}"`));
  } else {
    parts.push(`bash="${sanitizeParam(process.argv[0])}"`);
    parts.push('param1="--no-warnings"');
    parts.push(`param2="${sanitizeParam(MODULE_PATH)}"`);
    args.forEach((a, i) => parts.push(`param${i + 3}="${sanitizeParam(a)}"`));
  }
  parts.push('terminal=false', 'refresh=true');
  return parts.join(' ');
}

function sessionDot(session: DiscoveredSession, now: number): string {
  if (session.liveness === 'working') return '🟢';
  if (session.liveness === 'open') {
    const age = session.latestTreeModifiedMs > 0 ? now - session.latestTreeModifiedMs : Infinity;
    return age < RECENT_IDLE_MAX_AGE_MS ? '🟡' : '🔵';
  }
  return '⚪';
}

export function menuBarBadge(
  roots: DiscoveredSession[],
  primary: DiscoveredSession,
  primaryStats: SessionStats,
  now: number,
): { label: string; params: string } {
  const hasLiveSession =
    primary.liveness === 'working' ||
    primary.liveness === 'open' ||
    roots.some((r) => r.liveness === 'working' || r.liveness === 'open');

  const unresolvedApiError =
    primaryStats.apiErrors.length > 0 &&
    primaryStats.lastApiErrorStep >= primaryStats.lastAssistantStep;

  if (hasLiveSession) {
    if (unresolvedApiError) {
      return { label: '⚠️', params: 'size=14' };
    }
    return { label: '', params: `templateImage=${AGY_ICON}` };
  }

  const latestClosedMs = Math.max(
    primary.latestTreeModifiedMs,
    parseTimestampMs(primaryStats.lastActivity),
    roots[0]?.latestTreeModifiedMs ?? 0,
  );
  if (latestClosedMs > 0 && now - latestClosedMs < RECENT_IDLE_MAX_AGE_MS) {
    return { label: unresolvedApiError ? '🟠' : '🟡', params: 'size=14' };
  }

  return { label: '⚪', params: 'size=14' };
}

function renderVersion(): void {
  emit(`Agy Monitor v${VERSION}`, `size=11 ${CLR_SUB} href="${CHANGELOG_URL}"`);
}

function renderNoSession(cfg: MonitorConfig): void {
  emit('⚪', 'size=14');
  sep();
  emit('No Antigravity or Jetski sessions found', CLR);
  sep();
  emit(`Checked: ${cfg.roots.join(', ')}`, `size=11 ${CLR_SUB}`);
  emit('Refresh', 'refresh=true');
  renderVersion();
}

// ── Pin Persistence ────────────────────────────────────────────────────

export function readPinnedId(pinFile: string): string | null {
  try {
    return readFileSync(pinFile, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function writePinnedId(pinFile: string, id: string): void {
  mkdirSync(dirname(pinFile), { recursive: true });
  writeFileSync(pinFile, id.trim());
}

export function clearPinnedId(pinFile: string): void {
  try {
    unlinkSync(pinFile);
  } catch {
    /* already absent */
  }
}

// ── Main Render Pipeline ───────────────────────────────────────────────

export function runMonitor(
  args: string[] = process.argv.slice(2),
  overrides?: Partial<MonitorConfig>,
  sink?: LineSink,
): void {
  const cfg = resolveConfig(overrides);

  const cmd = args[0];
  if (cmd === 'pin' && args[1]) {
    writePinnedId(cfg.pinFile, args[1]);
    return;
  }
  if (cmd === 'unpin') {
    clearPinnedId(cfg.pinFile);
    return;
  }

  const prevSink = activeSink;
  if (sink) activeSink = sink;

  try {
    const discovery = discoverSessions(cfg);
    if (discovery.roots.length === 0) {
      renderNoSession(cfg);
      return;
    }

    const pinnedId = readPinnedId(cfg.pinFile);
    let primary: DiscoveredSession = discovery.roots[0];
    if (pinnedId) {
      const pinnedTarget = discovery.allById.get(pinnedId);
      if (pinnedTarget) {
        primary = pinnedTarget;
      }
    }

    const liveRootSet = new Set(discovery.presence.liveRoots);
    const modelsCache = readModelsCache(cfg.cacheDir);
    let modelsCacheDirty = false;

    const primaryStats = loadStats(primary, cfg.cacheDir);
    const primaryModelRes = resolveSessionModel(
      primary,
      liveRootSet.has(primary.rootPath),
      modelsCache,
    );
    if (primaryModelRes.dirty) modelsCacheDirty = true;

    // Child rollups for primary session
    let childToolCalls = 0;
    let childTotalTokens = 0;
    for (const childId of primary.childIds) {
      const childSession = discovery.allById.get(childId);
      if (!childSession) continue;
      const cStats = loadStats(childSession, cfg.cacheDir);
      childToolCalls += countTotalToolCalls(cStats);
      childTotalTokens += countTotalTokens(cStats);
    }

    // ── Menu bar top line ──
    const badge = menuBarBadge(discovery.roots, primary, primaryStats, cfg.now);
    emit(badge.label, badge.params);
    sep();

    // ── Session header ──
    const branchPart = primary.workspace.branch ? ` (${primary.workspace.branch})` : '';
    emit(
      `📂 ${primary.workspace.repo}${branchPart} · ${primary.surface}`,
      `size=13 ${CLR}`,
    );

    const summaryText =
      firstLine(primary.title) ||
      primaryStats.firstUserRequest ||
      extractUserRequestText(primary.preview);
    if (summaryText) {
      emit(`💬 ${truncate(summaryText, 80)}`, `size=12 ${CLR}`);
    }

    emit(`🤖 ${primaryModelRes.model}`, `size=12 ${CLR}`);

    const stateTag =
      primary.liveness === 'working'
        ? '🟢 working'
        : primary.liveness === 'open'
          ? '🟡 open (idle)'
          : '⚪ closed';
    const activeDur =
      primaryStats.activeDurationMs > 0
        ? `${formatMs(primaryStats.activeDurationMs)} active · `
        : '';
    const updatedAgo =
      primary.latestTreeModifiedMs > 0
        ? `updated ${formatAgeFromMs(primary.latestTreeModifiedMs, cfg.now)} ago`
        : '';
    emit(
      `⏱ ${stateTag} · ${activeDur}${updatedAgo} · 🔑 ${primary.id.slice(0, 8)}…`,
      `size=12 ${CLR}`,
    );

    // ── Core metrics ──
    sep();
    const selfCalls = countTotalToolCalls(primaryStats);
    const totalFailed = Array.from(primaryStats.tools.values()).reduce(
      (s, t) => s + t.failed,
      0,
    );
    const totalSandbox = Array.from(primaryStats.tools.values()).reduce(
      (s, t) => s + t.sandboxBlocked,
      0,
    );
    const issueParts = [
      totalFailed > 0 ? `${totalFailed} failed` : '',
      totalSandbox > 0 ? `${totalSandbox} sandbox retries` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const childCallPart = childToolCalls > 0 ? ` + ${childToolCalls} child` : '';
    emit(
      `🔧 ${selfCalls}${childCallPart} tool calls${issueParts ? ` (${issueParts})` : ''}`,
      `size=12 ${CLR}`,
    );
    if (primaryStats.tools.size > 0) {
      const sortedTools = Array.from(primaryStats.tools.values()).sort(
        (a, b) => b.count - a.count,
      );
      for (const t of sortedTools.slice(0, 12)) {
        const extra = [
          t.failed > 0 ? `${t.failed} fail` : '',
          t.sandboxBlocked > 0 ? `${t.sandboxBlocked} sandbox` : '',
        ]
          .filter(Boolean)
          .join(', ');
        emit(
          `--${t.name}: ${t.count}${extra ? ` (${extra})` : ''}`,
          `size=11 font=Menlo ${CLR_SUB}`,
        );
      }
    }

    const ctxBase = primaryStats.lastInputTokens + primaryStats.lastCacheReadTokens;
    const cacheHitPct =
      ctxBase > 0 ? Math.round((primaryStats.lastCacheReadTokens / ctxBase) * 100) : 0;
    const ctxMetaParts = [
      primaryStats.peakContextTokens > 0
        ? `peak ${formatNumber(primaryStats.peakContextTokens)}`
        : '',
      ctxBase > 0 ? `${cacheHitPct}% cached` : '',
      primaryStats.compactions > 0 ? `${primaryStats.compactions} compactions` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    emit(
      `🧠 Context: ${formatNumber(primaryStats.currentContextTokens)}${ctxMetaParts ? ` (${ctxMetaParts})` : ''}`,
      `size=12 ${CLR}`,
    );

    const selfTokens = countTotalTokens(primaryStats);
    const grandTokens = selfTokens + childTotalTokens;
    emit(
      `📊 Tokens: ${formatNumber(grandTokens)} (${formatNumber(primaryStats.totalInputTokens)} in · ${formatNumber(primaryStats.totalCacheReadTokens)} cached · ${formatNumber(primaryStats.totalOutputTokens)} out${childTotalTokens > 0 ? ` · +${formatNumber(childTotalTokens)} child` : ''})`,
      `size=12 ${CLR}`,
    );

    const wakeupSuffix =
      primaryStats.wakeupCount > 0 ? ` (${primaryStats.wakeupCount} wakeups)` : '';
    emit(
      `💬 Turns: ${primaryStats.turnCount.user} user / ${primaryStats.turnCount.assistant} assistant${wakeupSuffix}`,
      `size=12 ${CLR}`,
    );

    // ── API / Quota Alerts ──
    if (primaryStats.apiErrors.length > 0) {
      sep();
      emit(`⚠️ API / Quota Alerts (${primaryStats.apiErrors.length})`, `size=13 ${CLR_HEAD}`);
      for (const err of primaryStats.apiErrors.slice(-5).reverse()) {
        const prefix = err.isQuota ? '[QUOTA] ' : '';
        emit(
          `  ${formatTime(err.ts)} ${prefix}${truncate(err.message, 75)}`,
          `size=11 font=Menlo ${CLR_SUB}`,
        );
      }
    }

    // ── Tool Failures & Sandbox Blocks ──
    if (primaryStats.toolFailures.length > 0 || primaryStats.sandboxBlocks.length > 0) {
      sep();
      if (primaryStats.toolFailures.length > 0) {
        emit(
          `❌ Recent Tool Failures (${primaryStats.toolFailures.length})`,
          `size=13 ${CLR_HEAD}`,
        );
        for (const f of primaryStats.toolFailures.slice(-5).reverse()) {
          const codeTag = f.exitCode ? ` (exit ${f.exitCode})` : '';
          emit(
            `-- ${formatTime(f.ts)} · 🔧 ${f.name}${codeTag}`,
            `size=11 ${CLR_SUB}`,
          );
          emit(`---- ${truncate(f.message, 75)}`, `size=11 font=Menlo ${CLR_SUB}`);
        }
      }
      if (primaryStats.sandboxBlocks.length > 0) {
        emit(
          `🛡 Sandbox Blocks / Bypass Retries (${primaryStats.sandboxBlocks.length})`,
          `size=12 ${CLR_SUB}`,
        );
        for (const b of primaryStats.sandboxBlocks.slice(-5).reverse()) {
          emit(
            `-- ${formatTime(b.ts)} · ${b.name}: ${truncate(b.message, 70)}`,
            `size=11 font=Menlo ${CLR_SUB}`,
          );
        }
      }
    }

    // ── Plan & Artifacts ──
    const { artifacts, checklist } = readArtifactsAndChecklist(primary);
    if (artifacts.length > 0 || checklist) {
      sep();
      const headerCounts = checklist
        ? `${checklist.done}/${checklist.total} tasks done${checklist.inProgress > 0 ? ` · ${checklist.inProgress} active` : ''}`
        : `${artifacts.length} artifacts`;
      emit(`📝 Plan & Artifacts (${headerCounts})`, `size=13 ${CLR_HEAD}`);

      if (checklist) {
        emit(
          `  📄 Open ${basename(checklist.sourcePath)}`,
          `bash="open" param1="${sanitizeParam(checklist.sourcePath)}" terminal=false size=12 ${CLR_SUB}`,
        );
        const activeOrPending = checklist.items.filter((i) => i.status !== 'done');
        for (const item of activeOrPending.slice(0, 4)) {
          const icon = item.status === 'in_progress' ? '🔄' : '⬜';
          emit(`  ${icon} ${truncate(item.text, 72)}`, `size=11 font=Menlo ${CLR_SUB}`);
        }
        if (checklist.items.length > 4) {
          emit(`All Checklist Items (${checklist.total})`, `size=12 ${CLR_SUB}`);
          for (const item of checklist.items) {
            const icon =
              item.status === 'done'
                ? '✅'
                : item.status === 'in_progress'
                  ? '🔄'
                  : '⬜';
            emit(`--${icon} ${truncate(item.text, 85)}`, `size=11 font=Menlo ${CLR_SUB}`);
          }
        }
      }

      for (const art of artifacts.slice(0, 6)) {
        const desc = art.summary ? ` — ${truncate(art.summary, 52)}` : '';
        emit(
          `  📎 ${art.name}${desc}`,
          `bash="open" param1="${sanitizeParam(art.filePath)}" terminal=false size=12 ${CLR_SUB}`,
        );
      }
    }

    // ── Native Swarm ──
    const swarmRes = readSwarmInfo(
      primary,
      discovery.allById,
      cfg.cacheDir,
      liveRootSet.has(primary.rootPath),
      modelsCache,
    );
    if (swarmRes.modelsDirty) modelsCacheDirty = true;

    const swarmMemberIds = new Set<string>();
    const senderLabels = new Map<string, string>();

    if (swarmRes.swarm) {
      const sw = swarmRes.swarm;
      for (const m of sw.members) {
        if (m.conversationId) {
          swarmMemberIds.add(m.conversationId);
          senderLabels.set(m.conversationId, `@${m.handle}`);
        }
      }
      const runningN = sw.members.filter((m) => m.phase === 'RUNNING').length;
      const waitingN = sw.members.filter((m) => m.phase === 'WAITING').length;
      const swarmTitle = sw.title || `${sw.swarmId.slice(0, 8)}…`;
      const tagSuffix = sw.statusTag ? ` ${sw.statusTag}` : '';
      sep();
      emit(
        `🐝 Swarm: ${swarmTitle} (${runningN} running · ${waitingN} waiting · board #${sw.headSeq})${tagSuffix}`,
        `size=13 ${CLR_HEAD}`,
      );
      for (const m of sw.members) {
        const pDot =
          m.phase === 'RUNNING'
            ? '🟢'
            : m.phase === 'WAITING'
              ? '🟡'
              : '⚪';
        const lagPart = m.unreadLag > 0 ? ` · lag +${m.unreadLag}` : '';
        const statsPart =
          m.totalTokens > 0
            ? ` · ${m.toolCalls} calls · ${formatNumber(m.totalTokens)} tok`
            : '';
        const clickParams = m.conversationId
          ? `${actionParams(['pin', m.conversationId], cfg.wrapperPath)} `
          : '';
        emit(
          `  ${pDot} @${m.handle} (${m.role}) · ${m.model}${lagPart}${statsPart}`,
          `${clickParams}size=12 font=Menlo ${CLR_SUB}`,
        );
      }
      if (sw.recentPosts.length > 0) {
        emit(`Swarm Board (#${sw.headSeq})`, `size=12 ${CLR_SUB}`);
        for (const p of sw.recentPosts) {
          emit(
            `--#${p.seq} @${p.agent}: ${truncate(firstLine(p.text), 75)}`,
            `size=11 font=Menlo ${CLR_SUB}`,
          );
        }
      }
    }

    // ── Subagents ──
    const subRes = readSubagents(
      primary,
      discovery.allById,
      swarmMemberIds,
      cfg.cacheDir,
      liveRootSet.has(primary.rootPath),
      modelsCache,
    );
    if (subRes.modelsDirty) modelsCacheDirty = true;

    for (const sa of subRes.subagents) {
      senderLabels.set(sa.conversationId, sa.role);
    }

    if (subRes.subagents.length > 0) {
      sep();
      emit(`🤖 Subagents (${subRes.subagents.length})`, `size=13 ${CLR_HEAD}`);
      for (const sa of subRes.subagents.slice(0, 8)) {
        const icon = sa.isActive ? '🔄' : sa.isKilled ? '⏹' : '✅';
        const dur = sa.durationMs > 0 ? formatMs(sa.durationMs) : '?';
        const tok = sa.totalTokens > 0 ? formatNumber(sa.totalTokens) : '0';
        const pinAction = actionParams(['pin', sa.conversationId], cfg.wrapperPath);
        emit(
          `  ${icon} ${sa.role} [${sa.typeName}]`,
          `${pinAction} size=12 font=Menlo ${CLR_SUB}`,
        );
        emit(
          `     ${sa.model} · ${dur} · ${sa.toolCalls} calls · ${tok} tok`,
          `size=11 font=Menlo ${CLR_SUB}`,
        );
      }
      if (subRes.subagents.length > 8) {
        emit(
          `  … and ${subRes.subagents.length - 8} more subagents`,
          `size=11 ${CLR_SUB}`,
        );
      }
    }

    // ── Skills ──
    if (primaryStats.skills.length > 0) {
      sep();
      emit(`📚 Skills (${primaryStats.skills.length})`, `size=13 ${CLR_HEAD}`);
      for (const sk of primaryStats.skills.slice(-8)) {
        emit(
          `  ${formatTime(sk.timestamp)} ${sk.name}`,
          `size=12 font=Menlo ${CLR_SUB}`,
        );
      }
    }

    // ── Inbox ──
    const inbox = readInboxMessages(primary, senderLabels);
    if (inbox.length > 0) {
      const unreadCount = inbox.filter((m) => m.unread).length;
      sep();
      emit(
        `📬 Inbox${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`,
        `size=13 ${CLR_HEAD}`,
      );
      for (const m of inbox.slice(0, 6)) {
        const font = m.unread ? 'font=Menlo-Bold' : 'font=Menlo';
        emit(
          `  ${m.senderLabel} — ${truncate(m.summary, 64)}`,
          `size=12 ${font} ${CLR_SUB}`,
        );
      }
    }

    // ── Background Tasks ──
    const bgTasks = readBackgroundTasks(primary, primaryStats, cfg.now);
    if (bgTasks.length > 0) {
      sep();
      emit(`⚙️ Background Tasks (${bgTasks.length})`, `size=13 ${CLR_HEAD}`);
      for (const t of bgTasks.slice(0, 5)) {
        const dot = t.isRecent ? '🟢' : '⚪';
        const desc = t.summary ? ` — ${truncate(t.summary, 48)}` : '';
        emit(
          `  ${dot} ${t.name}${desc} (${formatAgeFromMs(t.mtimeMs, cfg.now)} ago)`,
          `bash="open" param1="${sanitizeParam(t.logPath)}" terminal=false size=12 font=Menlo ${CLR_SUB}`,
        );
      }
    }

    // ── Rules, Hooks & MCP ──
    const cust = readCustomizations(primary, cfg, primaryStats);
    if (
      cust.rules.length > 0 ||
      cust.hooks.length > 0 ||
      cust.mcpWorking.length > 0
    ) {
      sep();
      const repoRules = cust.rules.filter((r) => r.scope === 'repo');
      const globalRules = cust.rules.filter((r) => r.scope === 'global');
      const summaryBadges = [
        cust.rules.length > 0 ? `${cust.rules.length} rules` : '',
        cust.hooks.length > 0 ? `${cust.hooks.length} hooks` : '',
        cust.mcpWorking.length > 0 ? `${cust.mcpWorking.length} MCP` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      emit(`📋 Rules, Hooks & MCP (${summaryBadges})`, `size=13 ${CLR_HEAD}`);

      for (const r of repoRules) {
        emit(`  [${r.label}] ${r.path}`, `size=12 font=Menlo ${CLR_SUB}`);
      }
      if (globalRules.length > 0) {
        emit(`Global Rules (${globalRules.length})`, `size=12 ${CLR_SUB}`);
        for (const r of globalRules) {
          emit(`--[${r.label}] ${r.path}`, `size=11 font=Menlo ${CLR_SUB}`);
        }
      }
      if (cust.hooks.length > 0) {
        emit(`Active Hooks (${cust.hooks.length})`, `size=12 ${CLR_SUB}`);
        for (const h of cust.hooks) {
          emit(
            `--🪝 ${h.name} (${h.events.join(', ')})`,
            `size=11 font=Menlo ${CLR_SUB}`,
          );
        }
      }
      if (cust.mcpWorking.length > 0) {
        const usedCount = cust.mcpWorking.filter((s) => s.calls > 0).length;
        emit(
          `MCP Servers (${cust.mcpWorking.length}${usedCount > 0 ? ` · ${usedCount} used` : ''})`,
          `size=12 ${CLR_SUB}`,
        );
        for (const srv of cust.mcpWorking) {
          const detail = [
            srv.toolCount > 0
              ? `${srv.toolCount} ${srv.toolCount === 1 ? 'tool' : 'tools'}`
              : '',
            srv.calls > 0
              ? `${srv.calls} ${srv.calls === 1 ? 'call' : 'calls'}`
              : '',
          ]
            .filter(Boolean)
            .join(' · ');
          emit(
            `--🟢 ${srv.name} (${detail})`,
            `size=11 font=Menlo ${CLR}`,
          );
        }
      }
    }

    // ── Running Now (strictly guarded by live working state + freshness) ──
    const hasRecentBgLog = bgTasks.some((t) => t.isRecent);
    const activePending =
      primary.liveness === 'working'
        ? primaryStats.pendingTools.filter((pt) => {
            const startMs = parseTimestampMs(pt.startTs);
            return (
              hasRecentBgLog ||
              startMs === 0 ||
              cfg.now - startMs <= RUNNING_NOW_MAX_AGE_MS
            );
          })
        : [];

    if (activePending.length > 0) {
      sep();
      emit('⏳ Running Now', `size=13 ${CLR_HEAD}`);
      for (const pt of activePending) {
        const sum = pt.summary ? ` — ${truncate(pt.summary, 50)}` : '';
        emit(
          `  ${formatTime(pt.startTs)} 🔄 ${pt.name}${sum}`,
          `size=12 font=Menlo ${CLR_SUB}`,
        );
      }
    }

    // ── Actions ──
    sep();
    if (primary.workspace.cwd && existsSync(primary.workspace.cwd)) {
      emit(
        'Open Workspace Folder',
        `bash="open" param1="${sanitizeParam(primary.workspace.cwd)}" terminal=false`,
      );
    }
    if (existsSync(primary.brainDir)) {
      emit(
        'Open Session Brain',
        `bash="open" param1="${sanitizeParam(primary.brainDir)}" terminal=false`,
      );
    }
    if (primary.surface === 'Agy App') {
      emit(
        'Focus Antigravity',
        'bash="open" param1="-a" param2="Antigravity" terminal=false',
      );
    }
    emit('Refresh', 'refresh=true');

    if (pinnedId) {
      if (primary.rootId !== primary.id) {
        emit(
          '⬆️ Pin Parent Coordinator',
          actionParams(['pin', primary.rootId], cfg.wrapperPath),
        );
      }
      emit('📌 Pinned: Reset to Auto', actionParams(['unpin'], cfg.wrapperPath));
    }

    // ── Other Sessions (root sessions only, excluding primary's root) ──
    const otherRoots = discovery.roots
      .filter((r) => r.id !== primary.id && r.id !== primary.rootId)
      .slice(0, MAX_OTHER_SESSIONS);

    if (otherRoots.length > 0) {
      sep();
      emit(`Other Sessions (${otherRoots.length})`, `size=13 ${CLR_HEAD}`);
      for (const s of otherRoots) {
        let oStats: SessionStats;
        try {
          oStats = loadStats(s, cfg.cacheDir);
        } catch {
          continue;
        }
        const mRes = resolveSessionModel(
          s,
          liveRootSet.has(s.rootPath),
          modelsCache,
        );
        if (mRes.dirty) modelsCacheDirty = true;

        const dot = sessionDot(s, cfg.now);
        const calls = countTotalToolCalls(oStats);
        const ctxTok = formatNumber(oStats.currentContextTokens);
        const totTok = formatNumber(countTotalTokens(oStats));
        const ageLabel =
          s.latestTreeModifiedMs > 0
            ? `updated ${formatAgeFromMs(s.latestTreeModifiedMs, cfg.now)} ago`
            : 'idle';

        emit(
          `--${dot} ${s.workspace.repo} · ${s.surface} · ${mRes.model}`,
          `${actionParams(['pin', s.id], cfg.wrapperPath)} size=12 ${CLR}`,
        );
        emit(
          `--   ${ageLabel} · 🔧 ${calls} · 🧠 ${ctxTok} ctx · 📊 ${totTok} tok`,
          `size=11 ${CLR_SUB}`,
        );
        const oSummary =
          firstLine(s.title) ||
          oStats.firstUserRequest ||
          extractUserRequestText(s.preview);
        if (oSummary) {
          emit(`--   💬 ${truncate(oSummary, 64)}`, `size=11 ${CLR_SUB}`);
        }
      }
    }

    if (modelsCacheDirty) {
      writeModelsCache(cfg.cacheDir, modelsCache);
    }

    try {
      const validKeys = new Set<string>();
      for (const s of discovery.allById.values()) validKeys.add(s.cacheKey);
      pruneCache(cfg.cacheDir, validKeys);
    } catch {
      /* best-effort */
    }

    sep();
    renderVersion();
  } finally {
    activeSink = prevSink;
  }
}

// Guard so the module can be imported in tests without executing main().
const isEntrypoint = !process.argv[1] || resolve(process.argv[1]) === MODULE_PATH;
if (isEntrypoint) {
  try {
    runMonitor();
  } catch (err) {
    emit('⚠️', 'size=14');
    sep();
    emit('Agy Monitor error', `size=12 ${CLR}`);
    emit(
      truncate(firstLine(String(err instanceof Error ? err.message : err)), 90),
      `size=11 ${CLR_SUB}`,
    );
    emit('Refresh', 'refresh=true');
    sep();
    emit(`Agy Monitor v${VERSION}`, `size=11 ${CLR_SUB} href="${CHANGELOG_URL}"`);
  }
}
