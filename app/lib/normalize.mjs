// Canonical message model + filtering. Every data source funnels through here,
// so the summarizer never has to know whether records came from a demo file,
// an exported JSON file.
import { parseTimeAny, cleanText } from './util.mjs';

const KIND_MAP = {
  text: 'text', plain: 'text',
  image: 'image', pic: 'image', picture: 'image', photo: 'image',
  sticker: 'sticker', face: 'sticker', emoji: 'sticker', marketface: 'sticker',
  voice: 'voice', audio: 'voice', ptt: 'voice',
  video: 'video',
  file: 'file',
  reply: 'text',
  forward: 'forward', card: 'forward', ark: 'forward', json: 'forward', jsonstr: 'forward', xmlstr: 'forward',
  system: 'system', notice: 'system', tip: 'system', graytip: 'system', revoke: 'system',
  recall: 'system', recalled: 'system', systemmsg: 'system'
};

const SENDER_NAME_KEYS = ['name', 'nick', 'nickname', 'senderName', 'memberName', 'cardName', 'sender_name', 'displayName', 'groupCard', 'remark'];
const SENDER_UIN_KEYS = ['uin', 'uid', 'senderUin', 'senderUid', 'userId', 'peerUin', 'from'];
const TEXT_KEYS = ['text', 'plainText', 'messageText'];

function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

export function normalizeKind(raw) {
  const k = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  return KIND_MAP[k] || (k ? 'text' : 'text');
}

/**
 * Converts one export record into the canonical shape.
 * Tolerant on purpose: exported JSON shapes vary,
 * so we accept the common variants and degrade instead of throwing.
 */
export function toCanonical(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const time = parseTimeAny(
    raw.time ?? raw.timestamp ?? raw.sendTime ?? raw.msgTime ?? raw.createTime ?? raw.date
  );
  if (!time) return null;

  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender : {};
  const name = String(
    pick(sender, SENDER_NAME_KEYS) ?? pick(raw, ['senderName', 'name', 'nickname', 'memberName'], '')
  ).trim();
  const uin = String(
    pick(sender, SENDER_UIN_KEYS) ?? pick(raw, ['senderUin', 'uin', 'uid', 'peerUin'], '')
  ).trim();

  let kind = normalizeKind(raw.kind ?? raw.type ?? raw.msgType ?? raw.elementType);
  if (raw.recalled === true || raw.system === true) kind = 'system';

  // text: exports use content.text; tolerate plain strings and elements arrays
  let rawText = pick(raw, TEXT_KEYS, '');
  if (!rawText && raw.content !== undefined) {
    const c = raw.content;
    if (typeof c === 'string') rawText = c;
    else if (c && typeof c === 'object') {
      rawText = c.text || '';
      if (!rawText && Array.isArray(c.elements)) {
        rawText = c.elements.map((e) => (typeof e === 'string' ? e : e?.text || e?.data?.text || '')).join('');
      }
    }
  }
  if (!rawText) {
    const fallback = ['content', 'message', 'msg'].map((k) => raw[k]).find((v) => typeof v === 'string');
    rawText = fallback || '';
  }
  const text = cleanText(rawText || '');
  // No text but resources present: infer a media kind instead of an empty bubble
  let resolvedKind = kind;
  const resList = (raw.content && raw.content.resources) || raw.resources || [];
  const firstRes = Array.isArray(resList) && resList.length ? resList[0] : null;
  if (!text && resolvedKind === 'text' && firstRes) {
    const name = String(firstRes?.filename || firstRes?.fileName || firstRes?.url || '');
    resolvedKind = /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name) ? 'image' : 'file';
  }
  // Placeholders follow the QQ client preview renderer
  const fileName = firstRes ? String(firstRes.filename || firstRes.fileName || '').trim() : '';
  const placeholder = resolvedKind === 'file' && fileName
    ? `[文件: ${fileName.slice(0, 40)}]`
    : ({
      image: '[图片]', sticker: '[表情]', voice: '[语音]', video: '[视频]',
      file: '[文件]', forward: '[合并转发]', system: '[系统提示]'
    }[resolvedKind] || '[空消息]');

  return {
    id: String(raw.msgId ?? raw.id ?? raw.messageId ?? `m${index}`),
    t: time,
    tIso: time.toISOString(),
    from: name || '未知成员',
    uin: uin || '',
    kind: resolvedKind,
    text: text || placeholder,
    replyTo: raw.replyMsgId ?? raw.replyTo ?? raw.referencedMessageId ?? raw.replyId ?? null,
    raw
  };
}

export function canonicalizeAll(raws) {
  const out = [];
  (raws || []).forEach((r, i) => {
    const m = toCanonical(r, i);
    if (m) out.push(m);
  });
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function filterMessages(messages, opts = {}) {
  const from = opts.from ? new Date(opts.from) : null;
  const to = opts.to ? new Date(opts.to) : null;
  const keywords = (opts.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  const include = new Set((opts.includeMembers || []).map(String));
  const exclude = new Set((opts.excludeMembers || []).map(String));
  const includeSystem = opts.includeSystem !== false;
  const filterPureImage = opts.filterPureImage === true;

  const kept = [];
  for (const m of messages) {
    if (from && m.t < from) continue;
    if (to && m.t > to) continue;
    if (!includeSystem && m.kind === 'system') continue;
    if (exclude.has(m.from)) continue;
    if (include.size > 0 && !include.has(m.from)) continue;
    if (filterPureImage && (m.kind === 'image' || m.kind === 'sticker') && m.text.length <= 6) continue;
    if (keywords.length > 0) {
      const hay = m.text.toLowerCase();
      if (!keywords.some((k) => hay.includes(k))) continue;
    }
    kept.push(m);
  }
  return kept;
}

export function computeStats(messages) {
  const perMember = new Map();
  const kinds = {};
  let chars = 0;
  for (const m of messages) {
    chars += m.text.length;
    kinds[m.kind] = (kinds[m.kind] || 0) + 1;
    const key = m.from;
    const cur = perMember.get(key) || { name: m.from, uin: m.uin, count: 0, chars: 0, first: m.t, last: m.t };
    cur.count += 1;
    cur.chars += m.text.length;
    if (m.t < cur.first) cur.first = m.t;
    if (m.t > cur.last) cur.last = m.t;
    perMember.set(key, cur);
  }
  const members = [...perMember.values()].sort((a, b) => b.count - a.count);
  const first = messages.length ? messages[0].t : null;
  const last = messages.length ? messages[messages.length - 1].t : null;
  return {
    messageCount: messages.length,
    memberCount: members.length,
    charCount: chars,
    spanFrom: first ? first.toISOString() : null,
    spanTo: last ? last.toISOString() : null,
    kinds,
    members
  };
}
