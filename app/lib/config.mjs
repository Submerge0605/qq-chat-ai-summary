// Settings for QQ Chat AI Summary v0.1.
// The key itself is never stored here: we keep the NAME of an environment
// variable, and fall back to the OS keystore-free convention the user already
// uses (DEEPSEEK_API_KEY).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME_DIR = path.join(os.homedir(), '.qq-chat-ai-summary');
const HOME_FILE = path.join(HOME_DIR, 'config.json');
// Some environments (sandboxes, locked-down corporate machines) forbid writes
// outside the app directory. Keep a project-local fallback so settings still
// persist instead of failing the whole request.
const LOCAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.config');
const LOCAL_FILE = path.join(LOCAL_DIR, 'config.json');

let activeFile = HOME_FILE;

export const DEFAULT_SETTINGS = {
  engine: 'offline',
  defaultChatType: 'group',
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY'
  },
  exportDir: ''
};

export function configFilePath() {
  return activeFile;
}

async function readJson(file) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    llm: { ...DEFAULT_SETTINGS.llm, ...(raw.llm || {}) }
  };
}

export async function loadSettings() {
  for (const file of [HOME_FILE, LOCAL_FILE]) {
    try {
      const s = await readJson(file);
      activeFile = file;
      return s;
    } catch { /* try next location */ }
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = {
    ...cur,
    ...patch,
    llm: { ...cur.llm, ...(patch.llm || {}) }
  };
  if (!['offline', 'llm'].includes(next.engine)) next.engine = 'offline';

  const targets = [HOME_FILE, LOCAL_FILE];
  let lastErr = null;
  for (const file of targets) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(next, null, 2), 'utf8');
      activeFile = file;
      return next;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`设置写入失败（已尝试用户目录与项目目录）：${lastErr?.message || '未知错误'}`);
}

export function resolveApiKey(settings, env = process.env) {
  const name = settings?.llm?.apiKeyEnv || 'DEEPSEEK_API_KEY';
  // QCAS_LLM_KEY is what the desktop shell injects after DPAPI decryption.
  return env[name] || env.QCAS_LLM_KEY || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || '';
}

export function publicSettings(settings, env = process.env) {
  return {
    engine: settings.engine,
    llm: {
      baseUrl: settings.llm.baseUrl,
      model: settings.llm.model,
      apiKeyEnv: settings.llm.apiKeyEnv,
      hasKey: !!resolveApiKey(settings, env)
    },
    exportDir: settings.exportDir
  };
}
