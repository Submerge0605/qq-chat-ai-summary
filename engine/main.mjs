#!/usr/bin/env node
// v0.7 engine: fetch QQ history through NapCat OneBot and
// produce the same seven-section summary as v0.1.
//
// Protocol for the desktop shell: JSONL events on stdout, one JSON per line.
//   {"event":"status"|"chats"|"phase"|"done"|"error", ...}
// Optional --events <file> mirrors the same events to a file (handy when the
// parent process cannot capture pipes).
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OneBotClient, oneBotToCanonical } from './lib/onebot.mjs';
import { startMockOneBot } from './lib/mock-onebot.mjs';
import { discoverOneBot } from './lib/discover.mjs';
import { filterMessages, computeStats } from '../app/lib/normalize.mjs';
import { runSummary } from '../app/lib/summarize/index.mjs';
import { fmtDateTime } from '../app/lib/util.mjs';

const VERSION = '0.6.0';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) { out[key.slice(0, eq)] = key.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

/** 配置目录：默认 %APPDATA%\QChatSummary；QCAS_HOME 可覆盖（与桌面壳 AppConfig 一致，便于测试）。 */
function homeDir() {
  const env = process.env.QCAS_HOME;
  if (env) return env;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'QChatSummary');
}

function configPath() {
  return path.join(homeDir(), 'config.json');
}

async function loadConfig() {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function outputDir() {
  return path.join(homeDir(), 'results');
}

const args = parseArgs(process.argv.slice(2));
const eventsFile = args.events ? path.resolve(String(args.events)) : null;

async function emit(obj) {
  const line = JSON.stringify(obj);
  process.stdout.write(line + '\n');
  if (eventsFile) {
    try { await appendFile(eventsFile, line + '\n'); } catch { /* ignore */ }
  }
}

function parseTimeArg(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
    const hh = Number(m[4] || 0), mi = Number(m[5] || 0), ss = Number(m[6] || 0);
    if (mo < 1 || mo > 12 || day < 1 || day > 31 || hh > 23 || mi > 59 || ss > 59) return null;
    const d = new Date(y, mo - 1, day, hh, mi, ss);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
    return d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function makeClient() {
  const cfg = await loadConfig();
  if (args.mock) {
    const mock = await startMockOneBot({ token: cfg.onebotToken || '' });
    return {
      client: new OneBotClient({ base: mock.base, token: mock.token }),
      mode: 'mock',
      mock,
      label: `mock(${mock.base})`
    };
  }
  const cfg2 = await loadConfig();
  const explicitBase = String(args.base || cfg2.onebotBase || '');
  const explicitToken = String(args.token || cfg2.onebotToken || '');
  const found = discoverOneBot({ explicitBase, explicitToken });
  return {
    client: new OneBotClient({ base: found.base, token: found.token }),
    mode: 'live',
    mock: null,
    label: `${found.base}（${found.source}）`
  };
}

function fail(code, message) {
  return emit({ event: 'error', ok: false, code, message }).then(() => process.exitCode = 1);
}

async function cmdStatus() {
  const { client, mode, mock, label } = await makeClient();
  try {
    const st = await client.status();
    await emit({ event: 'status', ok: true, mode, base: label, napcat: st });
    process.exitCode = st.loggedIn || mode === 'mock' ? 0 : 2;
  } catch (err) {
    await emit({
      event: 'status', ok: false, mode, base: label,
      napcat: { reachable: false, loggedIn: false, message: err.message },
      code: err.code || 'STATUS_FAILED'
    });
    process.exitCode = 2;
  } finally {
    if (mock) await mock.close();
  }
}

async function cmdList() {
  const type = String(args.type || 'group');
  const { client, mode, mock, label } = await makeClient();
  try {
    const chats = type === 'friend' ? await client.friendList() : await client.groupList();
    await emit({ event: 'chats', ok: true, mode, base: label, type, chats });
    await emit({ event: 'done', ok: true, count: chats.length });
  } catch (err) {
    await emit({ event: 'error', ok: false, code: err.code || 'LIST_FAILED', message: err.message });
    process.exitCode = 1;
  } finally {
    if (mock) await mock.close();
  }
}

async function cmdRun() {
  const type = String(args.type || 'group');
  const chatId = String(args.id || '');
  const from = parseTimeArg(args.from);
  const to = parseTimeArg(args.to);
  const max = Math.max(10, Number(args.max || 20000));

  if (!chatId) return fail('BAD_ARGS', '缺少 --id（群号或好友 QQ 号）');
  if (!from || !to) return fail('BAD_ARGS', '缺少或无法解析 --from / --to，格式：YYYY-MM-DD HH:mm');
  if (from > to) return fail('BAD_ARGS', '起始时间不能晚于结束时间');

  const { client, mode, mock, label } = await makeClient();
  const t0 = Date.now();
  try {
    await emit({ event: 'phase', phase: 'fetch', progress: 3, message: `连接 ${label}，开始拉取历史消息` });

    const chatList = type === 'friend' ? await client.friendList() : await client.groupList();
    const chatMeta = chatList.find((c) => String(c.id) === chatId) || {
      id: chatId, name: type === 'group' ? `群 ${chatId}` : `好友 ${chatId}`, type
    };

    let pages = 0;
    const hist = await client.history({
      type, id: chatId, from, to, max,
      onPage: ({ pages: p, collected }) => {
        pages = p;
        emit({ event: 'phase', phase: 'fetch', progress: Math.min(55, 5 + p * 4), message: `已拉取 ${collected} 条（第 ${p} 页）` });
      }
    });
    if (mock) await mock.close();

    // @123456 -> @群名片：与 QQ 客户端显示保持一致
    let mentions = null;
    if (type === 'group') {
      await emit({ event: 'phase', phase: 'fetch', progress: 57, message: '解析群成员昵称（用于 @ 还原）' });
      mentions = await client.groupMemberMap(chatId);
    }

    const canonical = hist.messages
      .map((m, i) => oneBotToCanonical(m, i, { mentions }))
      .filter((m) => m.t >= from && m.t <= to)
      .sort((a, b) => a.t - b.t);

    await emit({ event: 'phase', phase: 'filter', progress: 60, message: `时间段内 ${canonical.length} 条消息，开始过滤` });

    const cfg = await loadConfig();
    const options = {
      keywords: String(args.keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
      includeMembers: [], excludeMembers: [],
      includeSystem: args['no-system'] ? false : true,
      filterPureImage: !!args['filter-image'],
      maxMessages: max
    };
    const filtered = filterMessages(canonical, { from, to, ...options });
    let selected = filtered;
    const sampled = filtered.length > max;
    if (sampled) {
      const stride = filtered.length / max;
      selected = Array.from({ length: max }, (_, i) => filtered[Math.floor(i * stride)]);
    }
    const stats = computeStats(selected);
    if (!stats.messageCount) {
      await emit({ event: 'phase', phase: 'empty', progress: 100, message: '该时间段内没有消息' });
    }

    // Debug/reconciliation hook: dump the canonical messages we actually used.
    if (args['dump-messages']) {
      const dumpPath = path.resolve(String(args['dump-messages']));
      await mkdir(path.dirname(dumpPath), { recursive: true });
      const lines = canonical.map((m) => JSON.stringify({
        id: m.id,
        seq: m.raw?.real_seq ?? m.raw?.message_seq ?? null,
        t: m.tIso,
        from: m.from,
        uin: m.uin,
        kind: m.kind,
        text: m.text
      }));
      await writeFile(dumpPath, lines.join('\n'), 'utf8');
      await emit({ event: 'phase', phase: 'dump', progress: 60, message: `已写出 ${canonical.length} 条原始消息用于对账` });
    }

    const params = {
      chatId, chatType: type,
      from: from.toISOString(), to: to.toISOString(),
      fromLabel: fmtDateTime(from), toLabel: fmtDateTime(to),
      options
    };

    const engine = String(args.engine || cfg.engine || 'offline');
    const settings = {
      engine: engine === 'llm' ? 'llm' : 'offline',
      llm: {
        baseUrl: String(args['llm-base'] || cfg.llm?.baseUrl || 'https://api.deepseek.com/v1'),
        model: String(args['llm-model'] || cfg.llm?.model || 'deepseek-chat'),
        apiKeyEnv: String(cfg.llm?.apiKeyEnv || 'DEEPSEEK_API_KEY')
      }
    };

    const { summary, markdown, meta } = await runSummary({
      chat: chatMeta,
      messages: selected,
      params,
      settings,
      onProgress: (phase, pct, msg) => emit({ event: 'phase', phase, progress: 62 + Math.round(pct * 0.3), message: msg })
    });

    const appDataDir = path.join(outputDir(), `${chatMeta.type}-${chatId}-${Date.now()}`);
    const localDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'out', `${chatMeta.type}-${chatId}-${Date.now()}`);
    let dir = args.output ? path.resolve(String(args.output)) : appDataDir;
    await mkdir(dir, { recursive: true }).catch(async () => {
      // sandboxed/locked-down environments: fall back to a project-local folder
      dir = localDir;
      await mkdir(dir, { recursive: true });
    });
    const resultPath = path.join(dir, 'result.json');
    const mdPath = path.join(dir, 'summary.md');
    const payload = {
      summary,
      meta: { ...meta, source: mode, base: label, fetchedMessages: canonical.length, pages, sampling: { sampled, sourceCount: filtered.length, keptCount: selected.length, maxMessages: max } },
      markdown
    };
    await writeFile(resultPath, JSON.stringify(payload, null, 2), 'utf8');
    await writeFile(mdPath, markdown, 'utf8');

    await emit({
      event: 'done', ok: true,
      chat: chatMeta, stats: { messageCount: stats.messageCount, memberCount: stats.memberCount, charCount: stats.charCount },
      engine: meta.engine, result: resultPath, markdown: mdPath,
      elapsedMs: Date.now() - t0
    });
  } catch (err) {
    await emit({ event: 'error', ok: false, code: err.code || 'RUN_FAILED', message: err.message });
    process.exitCode = 1;
  } finally {
    if (mock && mock.close) await mock.close().catch(() => {});
  }
}

async function main() {
  const cmd = args._[0] || 'status';
  if (cmd === 'version') return emit({ event: 'version', version: VERSION });
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'list') return cmdList();
  if (cmd === 'run') return cmdRun();
  await emit({ event: 'error', ok: false, code: 'BAD_COMMAND', message: `未知命令：${cmd}（可用：status / list / run）` });
  process.exitCode = 2;
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ event: 'error', ok: false, code: 'ENGINE_CRASH', message: err.message }) + '\n');
  process.exitCode = 1;
});
