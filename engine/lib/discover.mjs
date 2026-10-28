// Best-effort discovery of a local OneBot HTTP endpoint.
// Order: explicit setting -> env -> our runtime config / NapCat config -> common ports.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function serversFromConfig(doc) {
  const out = [];
  const net = doc?.network || doc?.Network || {};
  const lists = [net.httpServers, net.httpServer, doc?.httpServers, doc?.httpServer].filter(Boolean);
  for (const list of lists) {
    const arr = Array.isArray(list) ? list : [list];
    for (const s of arr) {
      if (!s || typeof s !== 'object') continue;
      const port = Number(s.port || s.Port || 0);
      const host = String(s.host || s.Host || '127.0.0.1');
      const enabled = s.enable !== false && s.enabled !== false;
      if (!port || !enabled) continue;
      out.push({ base: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, token: String(s.token || s.Token || '') });
    }
  }
  return out;
}

export function discoverOneBot({ explicitBase = '', explicitToken = '' } = {}) {
  if (explicitBase) return { base: explicitBase, token: explicitToken || '', source: '设置' };
  if (process.env.QCAS_ONEBOT_BASE) {
    return { base: process.env.QCAS_ONEBOT_BASE, token: process.env.QCAS_ONEBOT_TOKEN || '', source: '环境变量' };
  }

  const home = os.homedir();
  const roots = [
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'QChatSummary', 'napcat', 'config'),
    path.join(home, '.napcat', 'config'),
    path.join(home, 'AppData', 'Roaming', 'NapCatQQ', 'config'),
    path.join(home, 'AppData', 'Roaming', 'QQ', 'NapCat', 'config')
  ];

  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/^onebot11.*\.json$/i.test(f)) continue;
      const doc = readJson(path.join(dir, f));
      const found = serversFromConfig(doc);
      if (found.length) return { ...found[0], source: `NapCat 配置 (${path.join(dir, f)})` };
    }
  }

  return { base: 'http://127.0.0.1:3000', token: '', source: '默认端口' };
}
