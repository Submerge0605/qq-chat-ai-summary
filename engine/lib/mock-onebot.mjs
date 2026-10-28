// Minimal OneBot 11 mock server: lets the whole v0.3 flow run with no QQ,
// no NapCat and no exported files. Implements just the actions we call.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneBotToCanonical } from './onebot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function normalizeChatEntry(c) {
  const messages = (c.messages || []).map((m, i) => ({
    msgId: String(m.msgId ?? m.message_id ?? `m${i}`),
    time: m.time ?? m.timestamp ?? m.timeIso ?? null,
    from: m.from ?? m.sender?.name ?? m.sender?.nickname ?? '未知成员',
    uin: String(m.uin ?? m.sender?.uin ?? m.sender?.user_id ?? ''),
    kind: m.kind || 'text',
    text: m.text ?? m.content ?? ''
  })).filter((m) => m.time);
  return {
    id: String(c.id ?? c.group_id ?? c.user_id ?? ''),
    name: c.name ?? c.group_name ?? c.nickname ?? c.remark ?? String(c.id ?? ''),
    type: c.type || (c.group_id ? 'group' : 'friend'),
    memberCount: Number(c.memberCount ?? c.member_count ?? 0),
    messages
  };
}

/** Load mock chats: prefer data/mock-onebot.json, fall back to the demo samples. */
export function loadMockChats() {
  const candidates = [
    path.join(ROOT, 'data', 'mock-onebot.json'),
    path.join(ROOT, 'data', 'mock-onebot.sample.json')
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const doc = readJsonSafe(file);
    if (!doc) continue;
    const groups = (doc.groups || doc.groupList || []).map((c) => ({ ...normalizeChatEntry(c), type: 'group' }));
    const friends = (doc.friends || doc.friendList || []).map((c) => ({ ...normalizeChatEntry(c), type: 'friend' }));
    if (groups.length || friends.length) return [...groups, ...friends];
  }
  // fallback: two built-in samples
  const out = [];
  const g = readJsonSafe(path.join(ROOT, 'data', 'sample-group-qinghe.json'));
  if (g) out.push({ ...normalizeChatEntry({ ...g.chat, messages: g.messages }), type: 'group', memberCount: g.chat?.memberCount || 10 });
  const f = readJsonSafe(path.join(ROOT, 'data', 'sample-friend-suqing.json'));
  if (f) out.push({ ...normalizeChatEntry({ ...f.chat, messages: f.messages }), type: 'friend', memberCount: 2 });
  return out;
}

/** Mock fixture organised as real OneBot responses (验收交付的 data/mock-onebot.json). */
function loadOneBotShapedMock() {
  const file = path.join(ROOT, 'data', 'mock-onebot.json');
  const doc = readJsonSafe(file);
  if (!doc || !Array.isArray(doc.get_group_list)) return null;
  const gh = doc.get_group_msg_history || {};
  const fh = doc.get_friend_msg_history || {};
  const groups = doc.get_group_list.map((g) => {
    const id = String(g.group_id);
    const raw = (gh[id] && gh[id].messages) || [];
    return {
      id,
      onebotId: id,
      name: String(g.group_name || id),
      type: 'group',
      memberCount: Number(g.member_count || 0),
      rawMessages: raw,
      messages: raw.map((m, i) => oneBotToCanonical(m, i))
    };
  });
  const friends = (doc.get_friend_list || []).map((f) => {
    const id = String(f.user_id);
    const raw = (fh[id] && fh[id].messages) || [];
    return {
      id,
      onebotId: id,
      name: String(f.remark || f.nickname || id),
      type: 'friend',
      memberCount: 2,
      rawMessages: raw,
      messages: raw.map((m, i) => oneBotToCanonical(m, i))
    };
  });
  return [...groups, ...friends];
}

/** OneBot ids must be numeric; keep a stable mapping for non-numeric sample ids. */
function withOneBotIds(chats) {
  let seq = 90000;
  return chats.map((c) => {
    const numeric = /^\d{3,}$/.test(String(c.id));
    const onebotId = numeric ? String(c.id) : String(++seq);
    return { ...c, onebotId };
  });
}

function toOneBotMessage(chat, m, seq) {
  const ts = Math.floor(new Date(m.time).getTime() / 1000);
  const segments = [];
  if (m.kind === 'image') segments.push({ type: 'image', data: { file: 'mock.png', url: '' } });
  else if (m.kind === 'sticker') segments.push({ type: 'face', data: { id: '1' } });
  else if (m.kind === 'reply') segments.push({ type: 'reply', data: { id: '0' } });
  if (m.text) segments.push({ type: 'text', data: { text: m.text } });
  return {
    message_id: seq,
    message_seq: seq,
    time: ts,
    sender: { user_id: Number(m.uin || 0), nickname: m.from, card: m.from },
    message: segments,
    raw_message: m.text,
    msg_kind: m.kind
  };
}

export function startMockOneBot({ port = 0, host = '127.0.0.1', token = '' } = {}) {
  const chats = withOneBotIds(loadOneBotShapedMock() || loadMockChats());
  const byId = new Map(chats.map((c) => [String(c.onebotId), c]));
  const selfDoc = readJsonSafe(path.join(ROOT, 'data', 'mock-onebot.json'))?.self || { user_id: 1000000001, nickname: 'MockUser' };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { body = {}; }
      const url = new URL(req.url, 'http://x');
      // Real NapCat takes the action from the URL path (POST /get_group_list),
      // and the body is the params object itself.
      const pathAction = decodeURIComponent((url.pathname || '').replace(/^\/+/, '').split('/')[0] || '');
      const action = pathAction || url.searchParams.get('action') || body.action || '';
      if (token) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${token}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 1403, message: 'token 校验失败' }));
        }
      }
      const ok = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
      };
      const fail = (code, message) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: code, message }));
      };

      const params = body.params || body;

      if (action === 'get_status') return ok({ online: true, good: true, mock: true });
      if (action === 'get_login_info') return ok({ user_id: Number(selfDoc.user_id || 1000000001), nickname: String(selfDoc.nickname || 'MockUser') });

      if (action === 'get_group_list') {
        return ok(chats.filter((c) => c.type === 'group').map((c) => ({
          group_id: Number(c.onebotId),
          group_name: c.name,
          member_count: c.memberCount
        })));
      }
      if (action === 'get_friend_list') {
        return ok(chats.filter((c) => c.type === 'friend').map((c) => ({
          user_id: Number(c.onebotId),
          nickname: c.name,
          remark: c.name
        })));
      }

      const isGroup = action === 'get_group_msg_history';
      const isFriend = action === 'get_friend_msg_history';
      if (!isGroup && !isFriend) return fail(1404, `未实现的 action: ${action}`);

      const targetId = String(isGroup ? params.group_id : params.user_id);
      const chat = byId.get(targetId);
      if (!chat) return fail(1404, `会话不存在: ${targetId}`);

      const all = chat.rawMessages && chat.rawMessages.length
        ? chat.rawMessages.map((m) => ({ ...m, seq: Number(m.message_seq ?? m.message_id ?? 0) })).sort((a, b) => a.seq - b.seq)
        : [...chat.messages]
          .map((m, i) => ({ ...m, seq: i + 1 }))
          .sort((a, b) => new Date(a.time) - new Date(b.time));
      const count = Math.max(1, Math.min(Number(params.count) || 50, 1000));
      const rawSeq = params.message_seq;
      const beforeSeq = (rawSeq === undefined || rawSeq === null || rawSeq === '' || Number(rawSeq) === 0)
        ? null
        : Number(rawSeq);

      // OneBot 语义：不传 message_seq 时返回最新的一页；传了则返回该 seq 之前的一页
      let slice = beforeSeq === null
        ? all.slice(-count)
        : all.filter((m) => m.seq < beforeSeq).slice(-count);
      const messages = chat.rawMessages && chat.rawMessages.length
        ? slice.map((m) => m)
        : slice.map((m) => toOneBotMessage(chat, m, m.seq));
      return ok({ messages });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        base: `http://${host}:${addr.port}`,
        token,
        chats,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}
