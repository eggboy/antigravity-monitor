import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';

import {
  AGY_ICON,
  RESERVED_CACHE_FILES,
  discoverSessions,
  emit,
  extractModelFromBlob,
  freshStats,
  loadStats,
  makeSessionCacheKey,
  menuBarBadge,
  openDbWithStatus,
  parseGfmChecklist,
  parseTranscriptRange,
  processTranscriptEvent,
  pruneCache,
  readPinnedId,
  readRootSummaries,
  resolveConfig,
  resolveWorkspaceInfo,
  runMonitor,
  sanitizeLabel,
  sanitizeParam,
  scanLivePresence,
  type MonitorConfig,
} from '../scripts/agy-menubar.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'agy-monitor-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try {
      chmodSync(d, 0o755);
    } catch {
      /* ignore */
    }
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface SeedRow {
  conversation_id: string;
  title?: string;
  preview?: string;
  step_count?: number;
  last_modified_time?: string;
  workspace_uris?: string;
  status?: string;
  source?: string;
  project_id?: string;
  agent_name?: string;
  parent_conversation_id?: string;
  nesting_depth?: number;
  not_fully_idle?: number;
  killed?: number;
  group_id?: string;
  app_data_dir?: string;
}

function createSummaryDb(rootDir: string, rows: SeedRow[]): void {
  mkdirSync(rootDir, { recursive: true });
  const dbPath = join(rootDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      step_count INTEGER,
      last_modified_time TEXT,
      workspace_uris TEXT,
      status TEXT,
      source TEXT,
      project_id TEXT,
      agent_name TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      not_fully_idle NUMERIC,
      killed NUMERIC,
      group_id TEXT,
      app_data_dir TEXT
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, preview, step_count, last_modified_time,
      workspace_uris, status, source, project_id, agent_name,
      parent_conversation_id, nesting_depth, not_fully_idle, killed,
      group_id, app_data_dir
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(
      r.conversation_id,
      r.title ?? '',
      r.preview ?? '',
      r.step_count ?? 1,
      r.last_modified_time ?? '2026-11-16 05:20:00.000000+00:00',
      r.workspace_uris ?? '[]',
      r.status ?? 'CASCADE_RUN_STATUS_IDLE',
      r.source ?? '',
      r.project_id ?? 'default-cli-project',
      r.agent_name ?? '',
      r.parent_conversation_id ?? '',
      r.nesting_depth ?? 0,
      r.not_fully_idle ?? 0,
      r.killed ?? 0,
      r.group_id ?? '',
      r.app_data_dir ?? '',
    );
  }
  db.close();
}

function createConvMetadataDb(rootDir: string, convId: string, blob: Uint8Array): void {
  const convDir = join(rootDir, 'conversations');
  mkdirSync(convDir, { recursive: true });
  const db = new DatabaseSync(join(convDir, `${convId}.db`));
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);');
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
    1,
    blob,
    blob.byteLength,
  );
  db.close();
}

function writeTranscript(rootDir: string, convId: string, events: unknown[]): string {
  const logDir = join(rootDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logDir, { recursive: true });
  const p = join(logDir, 'transcript.jsonl');
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

describe('agy-menubar hermetic suite', () => {
  it('preserves multi-byte UTF-8 across tiny chunk boundaries and defers partial tail lines', () => {
    const base = makeTempDir();
    const trFile = join(base, 'transcript.jsonl');

    const evt1 = JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-16T05:00:00Z',
      content: '<USER_REQUEST>🚀 日本語テスト — café 🦀 check</USER_REQUEST>',
    });
    const evt2 = JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-16T05:00:05Z',
      input_tokens: 1200,
      cache_read_tokens: 3800,
      output_tokens: 250,
      tool_calls: [],
    });
    const halfTail = '{"step_index":2,"type":"CHECKPOINT","created_at":"2026-11-16T05:00:10Z"';

    writeFileSync(trFile, `${evt1}\n${evt2}\n${halfTail}`);
    const fullBytes = Buffer.byteLength(`${evt1}\n${evt2}\n${halfTail}`);
    const completeBytes = Buffer.byteLength(`${evt1}\n${evt2}\n`);

    const stats = freshStats();
    // Chunk size 37 forces splits directly through multi-byte UTF-8 sequences
    const offset1 = parseTranscriptRange(trFile, 0, fullBytes, stats, 37);

    assert.equal(offset1, completeBytes);
    assert.equal(stats.firstUserRequest, '🚀 日本語テスト — café 🦀 check');
    assert.equal(stats.turnCount.user, 1);
    assert.equal(stats.turnCount.assistant, 1);
    assert.equal(stats.currentContextTokens, 5000);
    assert.equal(stats.compactions, 0);

    // Complete the partial tail line and incrementally parse from offset1
    const finishedTail = `${halfTail}}\n`;
    writeFileSync(trFile, `${evt1}\n${evt2}\n${finishedTail}`);
    const newTotal = Buffer.byteLength(`${evt1}\n${evt2}\n${finishedTail}`);
    const offset2 = parseTranscriptRange(trFile, offset1, newTotal, stats, 37);

    assert.equal(offset2, newTotal);
    assert.equal(stats.compactions, 1);
  });

  it('caches stats incrementally, reparses on log rotation, and protects RESERVED_CACHE_FILES', () => {
    const base = makeTempDir();
    const rootDir = join(base, 'jetski');
    const stateDir = join(base, 'state');
    const convId = '11111111-1111-1111-1111-111111111111';

    createSummaryDb(rootDir, [
      {
        conversation_id: convId,
        title: 'Cache Test',
        step_count: 2,
        last_modified_time: '2026-11-16 05:10:00+00:00',
      },
    ]);
    const trPath = writeTranscript(rootDir, convId, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-16T05:09:00Z',
        content: '<USER_REQUEST>Initial turn</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-16T05:09:10Z',
        input_tokens: 1000,
        cache_read_tokens: 4000,
        output_tokens: 200,
        tool_calls: [{ name: 'read_file', args: { Path: '/tmp/a.txt' } }],
      },
    ]);

    const cfg = resolveConfig({
      roots: [rootDir],
      stateDir,
      lsofOutputOverride: '',
      now: Date.parse('2026-11-16T05:10:05Z'),
    });
    const disc = discoverSessions(cfg);
    const session = disc.roots[0];
    assert.ok(session);

    const s1 = loadStats(session, cfg.cacheDir, 64);
    assert.equal(s1.currentContextTokens, 5000);
    assert.equal(s1.peakContextTokens, 5000);

    // Append a larger turn + compaction + post-compaction smaller context turn
    const appended = [
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-16T05:09:20Z',
        input_tokens: 2000,
        cache_read_tokens: 10000,
        output_tokens: 300,
        tool_calls: [],
      }),
      JSON.stringify({
        step_index: 3,
        type: 'CHECKPOINT',
        created_at: '2026-11-16T05:09:25Z',
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-16T05:09:30Z',
        input_tokens: 1500,
        cache_read_tokens: 500,
        output_tokens: 100,
        tool_calls: [],
      }),
    ].join('\n');
    writeFileSync(trPath, `${Buffer.from(appended)}\n`, { flag: 'a' });
    const future = new Date(Date.now() + 2000);
    utimesSync(trPath, future, future);

    const s2 = loadStats(session, cfg.cacheDir, 64);
    assert.equal(s2.turnCount.assistant, 3);
    assert.equal(s2.currentContextTokens, 2000);
    assert.equal(s2.peakContextTokens, 12000);
    assert.equal(s2.compactions, 1);

    // Simulate rotation/shrink -> full reparse
    writeTranscript(rootDir, convId, [
      {
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-16T05:10:00Z',
        input_tokens: 777,
        cache_read_tokens: 0,
        output_tokens: 10,
      },
    ]);
    const future2 = new Date(Date.now() + 4000);
    utimesSync(trPath, future2, future2);
    const s3 = loadStats(session, cfg.cacheDir, 64);
    assert.equal(s3.turnCount.assistant, 1);
    assert.equal(s3.currentContextTokens, 777);

    // Verify pruneCache keeps RESERVED_CACHE_FILES and active session, deletes stale entry
    for (const reserved of RESERVED_CACHE_FILES) {
      writeFileSync(join(cfg.cacheDir, reserved), '{}');
    }
    const staleFile = join(cfg.cacheDir, 'jetski__dead-session.json');
    writeFileSync(staleFile, '{}');

    pruneCache(cfg.cacheDir, new Set([makeSessionCacheKey(rootDir, convId)]));
    assert.equal(existsSync(staleFile), false);
    for (const reserved of RESERVED_CACHE_FILES) {
      assert.equal(existsSync(join(cfg.cacheDir, reserved)), true);
    }
    assert.equal(
      existsSync(join(cfg.cacheDir, `${makeSessionCacheKey(rootDir, convId)}.json`)),
      true,
    );
  });

  it('rejects stale .lock files on disk and classifies working, open, closed, and headless runs', () => {
    const base = makeTempDir();
    const rootDir = join(base, 'jetski');
    const stateDir = join(base, 'state');
    const now = Date.parse('2026-11-16T05:30:00Z');

    const idWorking = 'aaaaaaaa-0000-0000-0000-000000000001';
    const idOpen = 'bbbbbbbb-0000-0000-0000-000000000002';
    const idStale = 'cccccccc-0000-0000-0000-000000000003';
    const idHeadless = 'dddddddd-0000-0000-0000-000000000004';
    const idCrashedHeadless = 'eeeeeeee-0000-0000-0000-000000000005';

    createSummaryDb(rootDir, [
      {
        conversation_id: idWorking,
        title: 'Working Session',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
        last_modified_time: '2026-11-16 05:29:50+00:00',
      },
      {
        conversation_id: idOpen,
        title: 'Idle Open Session',
        status: 'CASCADE_RUN_STATUS_IDLE',
        not_fully_idle: 0,
        last_modified_time: '2026-11-16 05:25:00+00:00',
      },
      {
        conversation_id: idStale,
        title: 'Stale Lock Session',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
        last_modified_time: '2026-11-15 01:00:00+00:00',
      },
      {
        conversation_id: idHeadless,
        title: 'Headless Print Run',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
        last_modified_time: '2026-11-16 05:28:00+00:00',
      },
      {
        conversation_id: idCrashedHeadless,
        title: 'Old Crashed Run',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
        last_modified_time: '2026-11-16 03:00:00+00:00',
      },
    ]);

    // Write 0-byte .lock files on disk for ALL of them (including stale!)
    const presenceDir = join(rootDir, 'presence');
    mkdirSync(presenceDir, { recursive: true });
    for (const id of [idWorking, idOpen, idStale]) {
      writeFileSync(join(presenceDir, `${id}.lock`), '');
    }

    // Only idWorking and idOpen have open FDs in lsof
    const lsofOut = [
      'p1001',
      'cjetski-cli',
      `n${join(presenceDir, `${idWorking}.lock`)}`,
      'p1002',
      'cjetski-cli',
      `n${join(presenceDir, `${idOpen}.lock`)}`,
    ].join('\n');

    const cfg: MonitorConfig = resolveConfig({
      roots: [rootDir],
      stateDir,
      lsofOutputOverride: lsofOut,
      now,
    });

    const { allById } = discoverSessions(cfg);
    assert.equal(allById.get(idWorking)?.liveness, 'working');
    assert.equal(allById.get(idOpen)?.liveness, 'open');
    assert.equal(allById.get(idStale)?.liveness, 'closed');
    assert.equal(allById.get(idHeadless)?.liveness, 'working');
    assert.equal(allById.get(idCrashedHeadless)?.liveness, 'closed');
  });

  it('falls back to presence.json within 15s TTL when lsof times out or errors', () => {
    const base = makeTempDir();
    const rootDir = join(base, 'jetski');
    const stateDir = join(base, 'state');
    const lockFile = join(rootDir, 'presence', 'conv-1.lock');

    const t0 = 1_700_000_000_000;
    const snap1 = scanLivePresence(
      resolveConfig({
        roots: [rootDir],
        stateDir,
        now: t0,
        lsofRunner: () => `p4242\ncjetski-cli\nn${lockFile}\n`,
      }),
    );
    assert.ok(snap1.locks[`${rootDir}::conv-1`]);

    // 8s later: lsof throws ETIMEDOUT -> cached lock preserved
    const snap2 = scanLivePresence(
      resolveConfig({
        roots: [rootDir],
        stateDir,
        now: t0 + 8_000,
        lsofRunner: () => {
          const err = new Error('lsof timed out') as Error & { code?: string };
          err.code = 'ETIMEDOUT';
          throw err;
        },
      }),
    );
    assert.equal(snap2.locks[`${rootDir}::conv-1`]?.pid, 4242);

    // 20s later (>= 15s TTL): cache expires cleanly
    const snap3 = scanLivePresence(
      resolveConfig({
        roots: [rootDir],
        stateDir,
        now: t0 + 20_000,
        lsofRunner: () => {
          throw new Error('lsof timed out');
        },
      }),
    );
    assert.deepEqual(snap3.locks, {});
  });

  it('rolls delegated subagents and native swarm workers under their root coordinator', () => {
    const base = makeTempDir();
    const rootDir = join(base, 'jetski');
    const stateDir = join(base, 'state');
    const now = Date.parse('2026-11-16T05:40:00Z');

    const coordId = 'coord000-0000-0000-0000-000000000001';
    const subId = 'subagent-0000-0000-0000-000000000002';
    const workerWaitId = 'worker01-0000-0000-0000-000000000003';
    const workerRunId = 'worker02-0000-0000-0000-000000000004';
    const otherRootId = 'other000-0000-0000-0000-000000000005';

    // Coordinator is CASCADE_RUN_STATUS_IDLE with not_fully_idle = 1 while child runs
    createSummaryDb(rootDir, [
      {
        conversation_id: coordId,
        title: 'Coordinator Task',
        status: 'CASCADE_RUN_STATUS_IDLE',
        not_fully_idle: 1,
        last_modified_time: '2026-11-16 05:39:00+00:00',
      },
      {
        conversation_id: subId,
        title: 'SWE Subagent',
        agent_name: 'swe',
        parent_conversation_id: coordId,
        nesting_depth: 1,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
        last_modified_time: '2026-11-16 05:39:55+00:00',
      },
      {
        // Linked ONLY via swarm/members.json (empty parent_conversation_id)
        conversation_id: workerWaitId,
        title: 'Duck Critic',
        nesting_depth: 1,
        status: 'CASCADE_RUN_STATUS_IDLE',
        not_fully_idle: 0,
        last_modified_time: '2026-11-16 05:39:30+00:00',
      },
      {
        conversation_id: workerRunId,
        title: 'Impl Worker',
        parent_conversation_id: coordId,
        nesting_depth: 1,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        not_fully_idle: 1,
        last_modified_time: '2026-11-16 05:39:58+00:00',
      },
      {
        conversation_id: otherRootId,
        title: 'Unrelated Root Session',
        status: 'CASCADE_RUN_STATUS_IDLE',
        not_fully_idle: 0,
        last_modified_time: '2026-11-16 05:20:00+00:00',
      },
    ]);

    // Write subagent descriptor + child transcripts + swarm files
    const subDir = join(rootDir, 'brain', coordId, '.system_generated', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, `${subId}.json`),
      JSON.stringify({
        conversationId: subId,
        subagentDescriptor: { typeName: 'swe', role: 'Backend Engineer' },
        state: 'SUBAGENT_STATE_RUNNING',
        spawnStepIndex: 4,
      }),
    );

    const swarmDir = join(rootDir, 'brain', coordId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, swarm_id: coordId }),
    );
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Architecture Review',
        members: {
          'duck-plan': {
            conversation_id: workerWaitId,
            role: 'critic',
            phase: 'WAITING',
            applied_model: 'opus-5.5-high',
            last_read_seq: 1,
            killed: false,
          },
          'duck-impl': {
            conversation_id: workerRunId,
            role: 'worker',
            phase: 'RUNNING',
            applied_model: 'gemini-4-carbon-high',
            last_read_seq: 3,
            killed: false,
          },
        },
      }),
    );
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      [
        JSON.stringify({ seq: 1, agent: 'coordinator', text: 'Kickoff' }),
        JSON.stringify({ seq: 2, agent: 'duck-impl', text: 'Draft ready' }),
        JSON.stringify({ seq: 3, agent: 'coordinator', text: '[stall] Waiting on critic' }),
      ].join('\n') + '\n',
    );

    writeTranscript(rootDir, coordId, [
      {
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-16T05:38:00Z',
        input_tokens: 1000,
        cache_read_tokens: 0,
        output_tokens: 100,
        tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Backend Engineer' } }],
      },
    ]);
    writeTranscript(rootDir, subId, [
      {
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-16T05:39:00Z',
        input_tokens: 2000,
        cache_read_tokens: 1000,
        output_tokens: 500,
        tool_calls: [
          { name: 'read_file', args: { Path: '/tmp/x' } },
          { name: 'edit_file', args: { Path: '/tmp/x' } },
        ],
      },
    ]);

    const lsofOut = `p8888\ncjetski-cli\nn${join(rootDir, 'presence', `${coordId}.lock`)}\n`;
    const lines: string[] = [];
    runMonitor(
      [],
      {
        roots: [rootDir],
        stateDir,
        lsofOutputOverride: lsofOut,
        wrapperPath: '/path/to/agy-monitor.5s.sh',
        now,
      },
      (line) => lines.push(line),
    );

    const rendered = lines.join('\n');
    // Menu bar shows monochrome AGY_ICON for working coordinator
    assert.ok(lines[0].includes(`templateImage=${AGY_ICON}`));
    // Child tool calls (+ 2 child) and child tokens (+3.5k child) rolled up
    assert.match(rendered, /🔧 1 \+ 2 child tool calls/);
    assert.match(rendered, /\+3\.5k child/);
    // Swarm panel shows board #3, [stall], and lag +2 on @duck-plan
    assert.match(rendered, /Swarm: Architecture Review .* board #3.*\[stall\]/);
    assert.match(rendered, /@duck-plan \(critic\) · opus-5\.5-high · lag \+2/);
    assert.match(rendered, /@duck-impl \(worker\) · gemini-4-carbon-high/);
    // Subagents panel shows Backend Engineer [swe]
    assert.match(rendered, /Backend Engineer \[swe\]/);
    // Other Sessions lists ONLY otherRootId (1 session), NOT subId/workerWaitId/workerRunId
    assert.match(rendered, /Other Sessions \(1\)/);
    assert.ok(!rendered.includes(`param2="${subId}"`) || rendered.includes('Subagents'));
    const otherSection = rendered.slice(rendered.indexOf('Other Sessions (1)'));
    assert.ok(otherSection.includes(otherRootId));
    assert.ok(!otherSection.includes(subId));
    assert.ok(!otherSection.includes(workerWaitId));
    assert.ok(!otherSection.includes(workerRunId));
  });

  it('reconciles pendingTools per step, classifies sandbox blocks vs genuine failures, and tracks wakeups/skills/API errors', () => {
    const stats = freshStats();

    // Human user turn
    processTranscriptEvent(stats, {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-16T05:00:00Z',
      content: '<USER_REQUEST>/rubber-duck-review check this</USER_REQUEST>',
    });
    assert.equal(stats.turnCount.user, 1);
    assert.equal(stats.skills.length, 1);
    assert.equal(stats.skills[0].name, 'rubber-duck-review');

    // Step 1 enqueues 2 tools, but second tool is cancelled without a GENERIC row
    processTranscriptEvent(stats, {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-16T05:00:02Z',
      input_tokens: 500,
      cache_read_tokens: 500,
      output_tokens: 50,
      tool_calls: [
        {
          name: 'read_file',
          args: { Path: '"/Users/test/.gemini/skills/python-best-practices/SKILL.md"' },
        },
        { name: 'run_command', args: { toolSummary: '"Never finishes"' } },
      ],
    });
    assert.equal(stats.pendingTools.length, 2);
    assert.equal(stats.skills.length, 2);
    assert.equal(stats.skills[1].name, 'python-best-practices');

    // Only 1 GENERIC arrives (sandbox denial on read_file)
    processTranscriptEvent(stats, {
      step_index: 2,
      type: 'GENERIC',
      source: 'MODEL',
      created_at: '2026-11-16T05:00:03Z',
      content:
        'Encountered error in tool execution: Permission denied for read_file "/secret/file"',
    });
    assert.equal(stats.sandboxBlocks.length, 1);
    assert.equal(stats.toolFailures.length, 0);
    assert.equal(stats.pendingTools.length, 1);

    // Step 3 PLANNER_RESPONSE reconciles leftover Step 1 pending tool before enqueueing Step 3
    processTranscriptEvent(stats, {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-16T05:00:05Z',
      input_tokens: 600,
      cache_read_tokens: 600,
      output_tokens: 80,
      tool_calls: [{ name: 'run_command', args: { toolSummary: '"Run unit tests"' } }],
    });
    assert.equal(stats.pendingTools.length, 1);
    assert.equal(stats.pendingTools[0].stepIndex, 3);
    assert.equal(stats.pendingTools[0].summary, 'Run unit tests');

    // Genuine command failure WITH Jetski's generic sandbox boilerplate note -> must be toolFailure, NOT sandboxBlock!
    processTranscriptEvent(stats, {
      step_index: 4,
      type: 'GENERIC',
      source: 'MODEL',
      created_at: '2026-11-16T05:00:08Z',
      content: [
        'Command exited with code 1.',
        '',
        'There were sandbox errors that may or may not be related to the failure.',
        '',
        'Command output:',
        'AssertionError [ERR_ASSERTION]: expected 42 to equal 43',
      ].join('\n'),
    });
    assert.equal(stats.pendingTools.length, 0);
    assert.equal(stats.sandboxBlocks.length, 1);
    assert.equal(stats.toolFailures.length, 1);
    assert.equal(stats.toolFailures[0].exitCode, '1');
    assert.match(stats.toolFailures[0].message, /AssertionError/);

    // Internal <SYSTEM_MESSAGE> wakeup should NOT count as a human user turn
    processTranscriptEvent(stats, {
      step_index: 5,
      type: 'USER_INPUT',
      created_at: '2026-11-16T05:00:10Z',
      content: '<SYSTEM_MESSAGE>\n[Message] Subagent finished\n</SYSTEM_MESSAGE>',
    });
    assert.equal(stats.turnCount.user, 1);
    assert.equal(stats.wakeupCount, 1);

    // ERROR_MESSAGE clears pendingTools and flags quota errors
    processTranscriptEvent(stats, {
      step_index: 6,
      type: 'ERROR_MESSAGE',
      created_at: '2026-11-16T05:00:12Z',
      error: 'RESOURCE_EXHAUSTED: Quota exceeded for quota metric',
    });
    assert.equal(stats.apiErrors.length, 1);
    assert.equal(stats.apiErrors[0].isQuota, true);
  });

  it('extracts allow-listed model names from binary gen_metadata blobs and rejects prose/garbage', () => {
    const promptNoise =
      'Use Claude Opus when this session is Gemini CLI vs Code Assist in gemini dir or Gemini API (official';
    // 0x22 ('"') is length 34 for 'Gemini-5-M-IT-G1149-Rev27-Carbon-G'
    const slugWithLenByte = '"Gemini-5-M-IT-G1149-Rev27-Carbon-G';
    const displayModel = '\x16Gemini 4 Carbon (High)';

    const buf1 = Buffer.concat([
      Buffer.from([0x0a, 0xff, 0x00, 0x89]),
      Buffer.from(promptNoise, 'utf-8'),
      Buffer.from([0x00, 0x12]),
      Buffer.from(slugWithLenByte, 'utf-8'),
      Buffer.from([0x00]),
      Buffer.from(displayModel, 'utf-8'),
    ]);
    assert.equal(extractModelFromBlob(buf1), 'Gemini 4 Carbon (High)');

    // Without display name at tail, extracts slug cleanly without leading '"' length byte
    const buf2 = Buffer.concat([
      Buffer.from(promptNoise, 'utf-8'),
      Buffer.from([0x00]),
      Buffer.from(slugWithLenByte, 'utf-8'),
    ]);
    assert.equal(extractModelFromBlob(buf2), 'Gemini-5-M-IT-G1149-Rev27-Carbon-G');

    // Only prose and random binary bytes -> returns null (never leaks raw bytes or prose)
    const buf3 = Buffer.concat([
      Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]),
      Buffer.from(promptNoise, 'utf-8'),
      Buffer.from('\x00$eb3b51bc-e692-47cf-ba2f-ad0d38f5eb27\x00MODEL_PLACEHOLDER_M427', 'utf-8'),
    ]);
    assert.equal(extractModelFromBlob(buf3), null);
  });

  it('handles missing SQLite columns via PRAGMA table_info and uses ?immutable=1 only when offline', () => {
    const base = makeTempDir();
    const minimalRoot = join(base, 'minimal');
    mkdirSync(minimalRoot, { recursive: true });

    // Minimal schema with only 2 columns
    const minDb = new DatabaseSync(join(minimalRoot, 'conversation_summaries.db'));
    minDb.exec(
      'CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT);',
    );
    minDb
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?)')
      .run('min-conv-1', 'Minimal Schema Session');
    minDb.close();

    const minRes = readRootSummaries(minimalRoot, false, {});
    assert.equal(minRes.rows.length, 1);
    assert.equal(minRes.rows[0].conversationId, 'min-conv-1');
    assert.equal(minRes.rows[0].title, 'Minimal Schema Session');
    assert.equal(minRes.rows[0].nestingDepth, 0);

    // Uncheckpointed / read-only WAL directory without -shm
    const roRoot = join(base, 'readonly-root');
    mkdirSync(roRoot, { recursive: true });
    const roDbPath = join(roRoot, 'conversation_summaries.db');
    const wDb = new DatabaseSync(roDbPath);
    wDb.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE conversation_summaries (conversation_id TEXT); INSERT INTO conversation_summaries VALUES ('ro-1');",
    );
    wDb.close();

    chmodSync(roDbPath, 0o444);
    chmodSync(roRoot, 0o555);

    try {
      // Live root MUST NOT fall back to ?immutable=1 (avoids serving stale pre-WAL rows)
      const liveAttempt = openDbWithStatus(roDbPath, false);
      assert.equal(liveAttempt.db, null);
      assert.equal(liveAttempt.usedImmutable, false);

      // Offline root safely falls back to ?immutable=1
      const offlineAttempt = openDbWithStatus(roDbPath, true);
      assert.ok(offlineAttempt.db);
      assert.equal(offlineAttempt.usedImmutable, true);
      offlineAttempt.db.close();

      const roSummaries = readRootSummaries(roRoot, false, {});
      assert.equal(roSummaries.usedImmutable, true);
      assert.equal(roSummaries.rows[0]?.conversationId, 'ro-1');
    } finally {
      chmodSync(roRoot, 0o755);
      chmodSync(roDbPath, 0o644);
    }

    // Verify SQLITE_BUSY falls back to cached summaries snapshot on a live root
    const busyRoot = join(base, 'busy-root');
    createSummaryDb(busyRoot, [
      { conversation_id: 'busy-conv-1', title: 'Cached Before Lock' },
    ]);
    const summaryCacheMap = {};
    const initialLoad = readRootSummaries(busyRoot, true, summaryCacheMap);
    assert.equal(initialLoad.rows.length, 1);

    const exclusiveWriter = new DatabaseSync(join(busyRoot, 'conversation_summaries.db'));
    exclusiveWriter.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO conversation_summaries (conversation_id, title) VALUES (\'busy-conv-2\', \'Uncommitted\');');
    try {
      const duringLock = readRootSummaries(busyRoot, true, summaryCacheMap);
      assert.equal(duringLock.usedBusyFallback, true);
      assert.equal(duringLock.rows[0]?.conversationId, 'busy-conv-1');
    } finally {
      exclusiveWriter.exec('ROLLBACK;');
      exclusiveWriter.close();
    }
  });

  it('supports pin/unpin CLI commands, git worktrees, inbox filtering, GFM checklists, and model extraction end-to-end', () => {
    const base = makeTempDir();
    const rootDir = join(base, 'antigravity');
    const stateDir = join(base, 'state');

    // Simulate a git worktree where .git is a file pointing to a worktree gitdir
    const realGitWorktree = join(base, 'gitdir-wt');
    mkdirSync(realGitWorktree, { recursive: true });
    writeFileSync(join(realGitWorktree, 'HEAD'), 'ref: refs/heads/feat/agy-menubar\n');

    const repoDir = join(base, 'my-worktree-repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, '.git'), `gitdir: ${realGitWorktree}\n`);
    writeFileSync(
      join(repoDir, 'PLAN.md'),
      ['# Plan', '- [x] Step one', '- [/] Step two', '- [ ] Step three'].join('\n'),
    );

    const wsInfo = resolveWorkspaceInfo([`file://${repoDir}`]);
    assert.equal(wsInfo.repo, 'my-worktree-repo');
    assert.equal(wsInfo.branch, 'feat/agy-menubar');

    const checklist = parseGfmChecklist(join(repoDir, 'PLAN.md'));
    assert.ok(checklist);
    assert.equal(checklist.done, 1);
    assert.equal(checklist.inProgress, 1);
    assert.equal(checklist.pending, 1);
    assert.equal(checklist.total, 3);

    const id1 = 'session1-0000-0000-0000-000000000001';
    const id2 = 'session2-0000-0000-0000-000000000002';
    const id3 = 'session3-0000-0000-0000-000000000003';
    const agyCliRootDir = join(base, 'antigravity-cli');
    createSummaryDb(rootDir, [
      {
        conversation_id: id1,
        title: 'First Session',
        step_count: 3,
        source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
        workspace_uris: JSON.stringify([`file://${repoDir}`]),
        last_modified_time: '2026-11-16 05:50:00+00:00',
      },
      {
        conversation_id: id2,
        title: 'Pinned Second Session',
        step_count: 3,
        project_id: '',
        workspace_uris: JSON.stringify([`file://${repoDir}`]),
        last_modified_time: '2026-11-16 05:10:00+00:00',
      },
    ]);
    createSummaryDb(agyCliRootDir, [
      {
        conversation_id: id3,
        title: 'Standalone Agy CLI Session',
        step_count: 2,
        workspace_uris: JSON.stringify([`file://${repoDir}`]),
        last_modified_time: '2026-11-16 05:45:00+00:00',
      },
    ]);
    createConvMetadataDb(
      rootDir,
      id2,
      Buffer.from('\x00\x16Claude Opus 5.5 (Max)\x00', 'utf-8'),
    );

    // Add inbox messages (1 visible unread, 1 hidden internal board wakeup)
    const msgDir = join(rootDir, 'brain', id2, '.system_generated', 'messages');
    mkdirSync(msgDir, { recursive: true });
    writeFileSync(
      join(msgDir, 'msg-visible.json'),
      JSON.stringify({
        id: 'msg-visible',
        sender: `${id2}/task-7`,
        content: 'Build finished cleanly',
        timestamp: '2026-11-16T05:10:00Z',
      }),
    );
    writeFileSync(
      join(msgDir, 'msg-hidden.json'),
      JSON.stringify({
        id: 'msg-hidden',
        sender: 'swarm-daemon',
        hideFromUser: true,
        content: 'Internal wakeup',
        timestamp: '2026-11-16T05:10:01Z',
      }),
    );

    // Pin id2 via runMonitor(['pin', id2])
    const pinCfg = {
      roots: [rootDir, agyCliRootDir],
      stateDir,
      lsofOutputOverride: '',
    };
    runMonitor(['pin', id2], pinCfg);
    assert.equal(readPinnedId(resolveConfig(pinCfg).pinFile), id2);

    const lines: string[] = [];
    runMonitor([], pinCfg, (l) => lines.push(l));
    const out = lines.join('\n');
    assert.match(out, /Pinned Second Session/);
    assert.match(out, /Claude Opus 5\.5 \(Max\)/);
    assert.match(out, /my-worktree-repo \(feat\/agy-menubar\) · Agy App/);
    assert.match(out, /Focus Antigravity/);
    assert.match(out, /Plan & Artifacts \(1\/3 tasks done · 1 active\)/);
    assert.match(out, /Inbox \(1 unread\)/);
    assert.match(out, /task-7 — Build finished cleanly/);
    assert.ok(!out.includes('Internal wakeup'));
    assert.match(out, /Pinned: Reset to Auto/);
    // Both CORTEX_TRAJECTORY_SOURCE_CLI and antigravity-cli render as 'Antigravity CLI'
    assert.equal(
      (out.match(/my-worktree-repo · Antigravity CLI · unknown/g) ?? []).length,
      2,
    );
    assert.ok(!out.includes('· Agy CLI'));

    // Unpin via runMonitor(['unpin'])
    runMonitor(['unpin'], pinCfg);
    assert.equal(readPinnedId(resolveConfig(pinCfg).pinFile), null);
  });

  it('escapes pipes and strips control characters in emit() and sanitizeParam()', () => {
    const emitted: string[] = [];
    const maliciousLabel =
      'Commit fix | bash="rm -rf /" terminal=true\nInjected Row | bash="curl evil"';
    const maliciousPath = '/tmp/bad"path\\with\nnewline\r\x00end';

    emit(
      maliciousLabel,
      `size=12 bash="open" param1="${sanitizeParam(maliciousPath)}"`,
      (l) => emitted.push(l),
    );

    // Strictly 1 output line (newlines stripped so extra menu rows can never be injected)
    assert.equal(emitted.length, 1);
    const singleLine = emitted[0];
    assert.ok(!singleLine.includes('\n'));
    assert.ok(!singleLine.includes('\r'));
    assert.ok(!singleLine.includes('\x00'));

    // Exactly ONE literal '|' delimiter in the entire emitted line
    const literalPipes = singleLine.split('|');
    assert.equal(literalPipes.length, 2);
    assert.ok(literalPipes[0].includes('│'));
    assert.ok(!literalPipes[0].includes('|'));

    // Parameter value has quotes and backslashes stripped
    assert.equal(sanitizeLabel('a|b\nc'), 'a│b c');
    assert.equal(sanitizeParam(maliciousPath), '/tmp/badpathwith newline  end');
  });

  it('shows only enabled and working MCP servers with adaptive black text coloring', () => {
    const base = makeTempDir();
    const rootDir = join(base, 'jetski');
    const stateDir = join(base, 'state');
    const configDir = join(stateDir, 'config');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'working-with-tools': {},
          'working-by-call': {},
          'disabled-with-cached-tools': { disabled: true },
          'explicitly-disabled-flag': { enabled: false },
          'enabled-zero-tools': {},
          'enabled-all-calls-failed': {},
        },
      }),
    );

    // Populate <root>/mcp/ schema directories, including a stale unreferenced directory
    const mcpRoot = join(rootDir, 'mcp');
    for (const [srv, toolNames] of [
      ['working-with-tools', ['search.json', 'get_doc.json', 'answer.json']],
      ['disabled-with-cached-tools', ['old_tool.json']],
      ['stale-uninstalled-plugin', ['leftover.json']],
      ['enabled-zero-tools', ['instructions.md']],
    ] as const) {
      const dir = join(mcpRoot, srv);
      mkdirSync(dir, { recursive: true });
      for (const f of toolNames) {
        writeFileSync(join(dir, f), '{}');
      }
    }

    const convId = 'mcpcheck-0000-0000-0000-000000000001';
    createSummaryDb(rootDir, [
      {
        conversation_id: convId,
        title: 'MCP Filter Check',
        step_count: 4,
        last_modified_time: '2026-11-16 06:00:00+00:00',
      },
    ]);

    // Call 'working-by-call' successfully and fail 'enabled-all-calls-failed'
    writeTranscript(rootDir, convId, [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-16T05:59:00Z',
        input_tokens: 1000,
        cache_read_tokens: 0,
        output_tokens: 100,
        tool_calls: [
          { name: 'call_mcp_tool', args: { ServerName: '"working-by-call"' } },
          { name: 'call_mcp_tool', args: { ServerName: '"enabled-all-calls-failed"' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        source: 'MODEL',
        created_at: '2026-11-16T05:59:01Z',
        content: 'OK result',
      },
      {
        step_index: 3,
        type: 'GENERIC',
        source: 'MODEL',
        status: 'ERROR',
        created_at: '2026-11-16T05:59:02Z',
        error: 'MCP connection refused',
      },
    ]);

    const lines: string[] = [];
    runMonitor(
      [],
      { roots: [rootDir], stateDir, configDir, lsofOutputOverride: '' },
      (l) => lines.push(l),
    );
    const out = lines.join('\n');

    // Header and submenu count strictly the 2 enabled & working servers
    assert.match(out, /Rules, Hooks & MCP \(2 MCP\)/);
    assert.match(out, /MCP Servers \(2 · 1 used\)/);
    assert.match(
      out,
      /--🟢 working-by-call \(1 call\) \| size=11 font=Menlo color=#1d1d1f,#f5f5f7/,
    );
    assert.match(
      out,
      /--🟢 working-with-tools \(3 tools\) \| size=11 font=Menlo color=#1d1d1f,#f5f5f7/,
    );

    // Disabled, zero-tool idle, all-failed, and stale directories MUST NOT appear
    assert.ok(!out.includes('disabled-with-cached-tools'));
    assert.ok(!out.includes('explicitly-disabled-flag'));
    assert.ok(!out.includes('enabled-zero-tools'));
    assert.ok(!out.includes('enabled-all-calls-failed'));
    assert.ok(!out.includes('stale-uninstalled-plugin'));
  });

  it('embeds a valid 44x44 144-DPI Antigravity tray PNG and shows it whenever a session is working or open', () => {
    const png = Buffer.from(AGY_ICON, 'base64');
    assert.deepEqual(
      png.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    const crc32 = (buf: Buffer): number => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
      return (c ^ 0xffffffff) >>> 0;
    };

    let off = 8;
    let width = 0;
    let height = 0;
    let physX = 0;
    const idatChunks: Buffer[] = [];

    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.subarray(off + 4, off + 8).toString('ascii');
      const data = png.subarray(off + 8, off + 8 + len);
      const expectedCrc = png.readUInt32BE(off + 8 + len);
      const actualCrc = crc32(png.subarray(off + 4, off + 8 + len));
      assert.equal(actualCrc, expectedCrc, `CRC mismatch on PNG chunk ${type}`);

      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
      } else if (type === 'pHYs') {
        physX = data.readUInt32BE(0);
      } else if (type === 'IDAT') {
        idatChunks.push(data);
      }
      off += 12 + len;
    }

    assert.equal(width, 44);
    assert.equal(height, 44);
    assert.equal(physX, 5669); // 144 DPI Retina @2x
    assert.equal(inflateSync(Buffer.concat(idatChunks)).length, 44 * (1 + 44 * 4));

    const baseRoot = makeTempDir();
    const stateDir = join(baseRoot, 'state');
    const rootDir = join(baseRoot, 'jetski');
    const now = Date.parse('2026-11-16T06:20:00Z');
    createSummaryDb(rootDir, [
      {
        conversation_id: 'live-open-1',
        title: 'Idle Open Window',
        status: 'CASCADE_RUN_STATUS_IDLE',
        not_fully_idle: 0,
        last_modified_time: '2026-11-16 05:00:00+00:00',
      },
    ]);

    // 1. Open (idle) session -> shows Antigravity templateImage
    const openDisc = discoverSessions(
      resolveConfig({
        roots: [rootDir],
        stateDir,
        lsofOutputOverride: `p777\ncjetski-cli\nn${join(rootDir, 'presence', 'live-open-1.lock')}\n`,
        now,
      }),
    );
    const cleanStats = freshStats();
    assert.deepEqual(
      menuBarBadge(openDisc.roots, openDisc.roots[0], cleanStats, now),
      { label: '', params: `templateImage=${AGY_ICON}` },
    );

    // 2. Live session with unresolved API error -> shows warning glyph
    const errStats = freshStats();
    errStats.apiErrors.push({
      ts: '2026-11-16T06:19:50Z',
      stepIndex: 5,
      message: 'RESOURCE_EXHAUSTED',
      isQuota: true,
    });
    errStats.lastApiErrorStep = 5;
    errStats.lastAssistantStep = 4;
    assert.deepEqual(
      menuBarBadge(openDisc.roots, openDisc.roots[0], errStats, now),
      { label: '⚠️', params: 'size=14' },
    );

    // 3. Closed > 5m -> grey dot; Closed < 5m -> yellow dot (or orange on error)
    const closedDisc = discoverSessions(
      resolveConfig({
        roots: [rootDir],
        stateDir,
        lsofOutputOverride: '',
        now,
      }),
    );
    assert.deepEqual(
      menuBarBadge(closedDisc.roots, closedDisc.roots[0], cleanStats, now),
      { label: '⚪', params: 'size=14' },
    );

    const recentSession = {
      ...closedDisc.roots[0],
      latestTreeModifiedMs: now - 60_000,
    };
    assert.deepEqual(
      menuBarBadge([recentSession], recentSession, cleanStats, now),
      { label: '🟡', params: 'size=14' },
    );
    assert.deepEqual(
      menuBarBadge([recentSession], recentSession, errStats, now),
      { label: '🟠', params: 'size=14' },
    );
  });
});
