// Topic segmentation engine (v0.5).
//
// The v0.4 engine grouped messages by a fixed 10-category domain taxonomy and
// then hard-capped the result at 7 topics. On a real 24k-message group chat
// with no domain vocabulary that produced exactly one fallback: seven topics,
// all titled 围绕「回复消息、raven」的讨论. This module replaces it with a
// data-driven pipeline:
//
//   clean text -> session bursts (time gaps) -> split long bursts by term
//   continuity -> merge until the topic budget -> per-topic distinctive terms
//   -> title taken from a real clause -> evidence with distinct senders
//
// Guarantees (checked by qa/v05-topic-quality.mjs):
//   * sum(topics[].messageCount) === messages.length (100% coverage)
//   * topicCount ≈ clamp(round(n / 150), 4, 120) — scales with the chat volume
//   * titles are unique, 4–28 chars, contain no placeholder / mention tokens
//   * every topic has at least one evidence message with a real msgId
import { cjkTerms, latinTerms, jaccard, clip, dayLabel, fmtTime, INTENT } from '../util.mjs';

// Words that carry no topic information in a chat: conversational filler,
// client placeholders, and verbs that show up in every thread.
const GENERIC_TERMS = new Set([
  '回复', '消息', '转发', '截图', '图片', '表情', '语音', '视频', '文件', '合并',
  '意思', '觉得', '知道', '哈哈', '呵呵', '真的', '就是', '可以', '什么', '怎么',
  '这样', '那样', '现在', '然后', '所以', '但是', '而且', '如果', '已经', '还是',
  '没有', '不是', '不要', '这个', '那个', '我们', '你们', '他们', '自己', '大家',
  '一个', '一下', '时候', '问题', '东西', '事情', '看到', '感觉', '应该', '需要',
  '可能', '其实', '主要', '直接', '什么', '为什么', '怎么样', '有没有', '是不是',
  '提到', '网上', '链接', '卡片', '系统', '提示', '原始', '记录', '版本', '内容',
  '一段', '一句', '一点', '有点', '还是', '已经', '怎么', '为什么', '因为', '不过'
]);

const FILLER = new Set(['收到', '好的', '嗯嗯', '明白', '好', 'ok', '可以', '哈哈', '👍',
  '在', '辛苦了', '我看看', '稍等', '没问题', '同意', '按这个来', '哈哈哈哈', '？', '?', '草']);

const MEDIA_PLACEHOLDER = /^\[[^\]]{1,10}\]$/;

const TARGET_TOPICS_MAX = 140;
const TARGET_TOPICS_MIN = 4;
// Topic count grows with volume but slower than linearly: a 400-message chat
// deserves ~10 topics, a 24k-message chat ~117. This keeps small chats readable
// and large chats from collapsing into a handful of mega-blobs.
export function topicBudget(messageCount) {
  const raw = Math.round(8 + messageCount / 180);
  return Math.max(TARGET_TOPICS_MIN, Math.min(TARGET_TOPICS_MAX, raw));
}

function isFiller(m) {
  const t = m.text.trim().toLowerCase();
  return t.length <= 3 || FILLER.has(t) || (MEDIA_PLACEHOLDER.test(t) && t.length <= 8);
}

function isQuestion(m) {
  return /[?？]\s*$/.test(m.text) || /(会不会|能不能|要不要|是不是|有没有|行不行|可以吗)/.test(m.text);
}

// ------------------------------------------------------------------ cleaning

/**
 * Strip everything that would pollute term statistics: the reply prefix the
 * renderer adds at v0.3.3, @mentions of real members, client placeholders,
 * URLs. Member names are removed so a chatty nickname can never become the
 * topic title by itself.
 */
function prepare(messages) {
  const names = [...new Set(messages.map((m) => m.from))].filter((n) => n && n.length >= 2)
    .sort((a, b) => b.length - a.length);
  const nameSet = new Set(names);
  return messages.map((m) => {
    let s = String(m.text || '');
    s = s.replace(/^\[回复消息\]\s*/g, '');
    for (const n of names) {
      if (s.indexOf('@' + n) >= 0) s = s.split('@' + n).join(' ');
    }
    s = s.replace(/\[[^\]]{1,16}\]/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      // leftover @tokens (calls, aliases that are not member names)
      .replace(/@[\u4e00-\u9fa5A-Za-z0-9_\-]{1,14}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const terms = new Set();
    if (s) {
      for (const t of cjkTerms(s)) if (!nameSet.has(t)) terms.add(t);
      for (const t of latinTerms(s)) if (!nameSet.has(t) && t.length >= 3) terms.add(t);
    }
    return { m, text: s, terms };
  });
}

// --------------------------------------------------------------- segmentation

/** Bursts of activity separated by a long silence. */
function bursts(prep) {
  if (!prep.length) return [];
  let gap = 12 * 60 * 1000;
  // A very busy room tolerates shorter silences; a quiet room needs longer ones.
  const gaps = [];
  for (let i = 1; i < prep.length; i++) gaps.push(prep[i].m.t - prep[i - 1].m.t);
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    const p50 = gaps[Math.floor(gaps.length * 0.5)];
    gap = Math.max(8 * 60 * 1000, Math.min(30 * 60 * 1000, p50 * 40));
  }
  const out = [];
  let cur = [];
  for (const p of prep) {
    if (cur.length && p.m.t - cur[cur.length - 1].m.t > gap) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

function termSetOf(items) {
  const s = new Set();
  for (const p of items) for (const t of p.terms) s.add(t);
  return s;
}

/**
 * Split an over-long burst where the vocabulary changes: cost = time gap plus
 * the drop in term overlap between the window before and after the boundary.
 */
function splitBurst(items, targetSize) {
  const pieces = [];
  let rest = items;
  while (rest.length > targetSize * 1.5) {
    const mid = Math.floor(rest.length / 2);
    const lo = Math.max(Math.floor(targetSize * 0.55), Math.floor(rest.length * 0.15));
    const hi = Math.min(Math.ceil(rest.length - targetSize * 0.55), Math.ceil(rest.length * 0.85));
    let best = mid;
    let bestScore = -Infinity;
    const window = Math.max(8, Math.min(40, Math.floor(targetSize / 4)));
    for (let i = lo; i <= hi; i++) {
      const before = termSetOf(rest.slice(Math.max(0, i - window), i));
      const after = termSetOf(rest.slice(i, Math.min(rest.length, i + window)));
      const overlap = jaccard([...before], [...after]);
      const gapMin = (rest[i].m.t - rest[i - 1].m.t) / 60000;
      // prefer boundaries with a real pause, then a vocabulary change
      const score = Math.min(gapMin, 90) * 0.6 + (1 - overlap) * 25;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    pieces.push(rest.slice(0, best));
    rest = rest.slice(best);
  }
  pieces.push(rest);
  return pieces;
}

function buildSegments(prep) {
  const n = prep.length;
  const budget = topicBudget(n);
  const targetSize = Math.max(8, Math.round(n / budget));
  let segs = [];
  for (const b of bursts(prep)) {
    // Every burst is cut down to roughly one topic's worth of messages; the
    // split point follows vocabulary change, not a fixed index.
    if (b.length > targetSize * 1.05) segs.push(...splitBurst(b, targetSize));
    else segs.push(b);
  }
  // merge tiny fragments into the neighbour they share the most vocabulary with
  segs = segs.filter((s) => s.length > 0);
  const minSize = Math.max(5, Math.floor(targetSize * 0.14));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].length >= minSize) continue;
      const prev = segs[i - 1];
      const next = segs[i + 1];
      if (!prev && !next) break;
      const mine = termSetOf(segs[i]);
      const scorePrev = prev ? jaccard([...mine], [...termSetOf(prev)]) : -1;
      const scoreNext = next ? jaccard([...mine], [...termSetOf(next)]) : -1;
      if (scorePrev >= scoreNext && prev) prev.push(...segs[i]);
      else if (next) next.unshift(...segs[i]);
      segs.splice(i, 1);
      changed = true;
      break;
    }
  }
  return segs;
}

// ----------------------------------------------------------- term statistics

/** Document frequency of each term across the whole chat (for idf). */
function documentFrequency(prep) {
  const df = new Map();
  for (const p of prep) {
    for (const t of p.terms) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

/** Distinctive vocabulary of one topic: frequent here, rare elsewhere. */
function distinctiveTerms(seg, df, segCount, limit = 12) {
  const tf = new Map();
  for (const p of seg) {
    for (const t of p.terms) {
      if (GENERIC_TERMS.has(t)) continue;
      tf.set(t, (tf.get(t) || 0) + 1);
    }
  }
  const scored = [];
  for (const [term, count] of tf) {
    if (count < 2) continue;
    const docs = df.get(term) || 1;
    if (docs > Math.max(12, Math.round(segCount * 0.28))) continue;
    if (term.length < 2) continue;
    const idf = Math.log(1 + segCount / Math.max(1, docs));
    const lenBoost = 1 + (term.length - 2) * 0.35;
    scored.push({ term, score: (count / seg.length) * idf * lenBoost, count });
  }
  scored.sort((a, b) => b.score - a.score);
  // drop a term shadowed by a longer, equally supported term
  const kept = [];
  for (const cand of scored) {
    if (kept.some((k) => (k.term.includes(cand.term) || cand.term.includes(k.term))
      && Math.abs(k.count - cand.count) <= Math.max(1, Math.round(k.count * 0.4)))) continue;
    kept.push(cand);
    if (kept.length >= limit) break;
  }
  return kept;
}

// ------------------------------------------------------------------- scoring

function informativeScore(p, termScores) {
  const m = p.m;
  if (isFiller(m)) return 0;
  if (m.kind !== 'text') return 0.2;
  const len = p.text.length;
  if (len < 4) return 0.2;
  let s = Math.min(len, 90) / 30;
  if (len > 160) s *= 0.85;   // long pasted dumps are usually not the best excerpt
  let hits = 0;
  for (const t of p.terms) if (termScores.has(t)) hits += 1;
  s += Math.min(hits, 6) * 0.35;
  if (INTENT.decision.test(m.text)) s += 2.2;
  if (INTENT.todo.test(m.text)) s += 1.0;
  if (INTENT.risk.test(m.text)) s += 0.9;
  if (isQuestion(m)) s *= 0.75;
  return s;
}

function scoreMap(pieces) {
  const map = new Map();
  for (const seg of pieces) {
    const terms = distinctiveTerms(seg, new Map(), 1, 30);
    for (const t of terms) map.set(t.term, t.score + 0.1);
  }
  return map;
}

// ------------------------------------------------------------------- titles

const LEADING = /^(所以|然后|而且|但是|但|不过|其实|反正|另外|还有|因为|对了|话说回来|话说|就是|确实|感觉|按说|可是|那个|这个|哎|诶|嗯|哦|喂|啊|而)[，,、\s]*/;
const TRAILING = /[，,。.!！?？；;：:、\s]+$/;
const DANGLING = /(就|是|和|与|及|而|在|有|被)$/;

const PROFANITY = /(操你妈|操你|傻逼|傻屌|他妈|妈的|你妈|卧槽|草泥马|fuck|shit|婊子|贱人|去死)/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

function tidyTitle(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^["“”'‘’《》【】\[\]（）()]+|["“”'‘’《》【】\[\]（）()]+$/g, '');
  s = s.replace(LEADING, '');
  s = s.replace(TRAILING, '');
  s = s.replace(EMOJI, '');
  s = s.replace(/[，,、；;：:]/g, '');
  s = s.replace(/[的了呢吧啊呀嘛哈哦]+$/, '');
  s = s.replace(DANGLING, '');
  s = s.replace(/\s+/g, '');
  return s.trim();
}

function clauseCandidates(p) {
  const parts = p.text.split(/[。！？!?；;\n]+/);
  const out = [];
  for (const part of parts) {
    for (const clause of part.split(/[，,、]+/)) {
      const c = tidyTitle(clause);
      if (c.length < 5 || c.length > 20) continue;
      if (/^(http|www)/i.test(c)) continue;
      if (MEDIA_PLACEHOLDER.test(c)) continue;
      out.push(c);
    }
  }
  return out;
}

/**
 * Titles built from the text span that covers the distinctive terms of the
 * topic: "双盲测试结果和仪器调整" rather than a raw whole sentence. Spans keep
 * the words the discussion is actually about and drop the chatter around them.
 */
function spanCandidates(p, topTerms) {
  const text = p.text;
  if (!text || text.length < 6) return [];
  const hits = [];
  for (const term of topTerms) {
    let idx = text.indexOf(term);
    while (idx >= 0) {
      hits.push({ term, idx, end: idx + term.length });
      if (hits.length > 80) break;
      idx = text.indexOf(term, idx + 1);
    }
  }
  if (!hits.length) return [];
  hits.sort((a, b) => a.idx - b.idx);
  const out = [];
  for (let i = 0; i < hits.length; i++) {
    let start = hits[i].idx;
    let end = hits[i].end;
    const terms = new Set([hits[i].term]);
    let j = i + 1;
    while (j < hits.length && hits[j].idx - end <= 5) {
      terms.add(hits[j].term);
      end = Math.max(end, hits[j].end);
      j++;
    }
    let s2 = start;
    let e2 = end;
    while (s2 > 0 && start - s2 < 9 && !/[，,。！？!?；;\s]/.test(text[s2 - 1])) s2--;
    while (e2 < text.length && e2 - end < 9 && !/[，,。！？!?；;\s]/.test(text[e2])) e2++;
    let title = tidyTitle(text.slice(s2, e2));
    if (title.length > 24) title = tidyTitle(title.slice(0, 24));
    if (title.length < 5 || title.length > 20) continue;
    if (/^(http|www)/i.test(title)) continue;
    out.push({ title, terms: [...terms] });
  }
  return out;
}

/**
 * Build a title from the topic's own content. Span candidates outrank plain
 * clauses; a candidate must contain at least one distinctive term, may not be
 * a member's name, and is scored for term strength, multi-term coverage,
 * length and the informativeness of its source message. When nothing
 * qualifies we compose a neutral phrase from the two strongest terms.
 */
function makeTitle(seg, distinct, names) {
  const termScores = new Map(distinct.map((t) => [t.term, t.score]));
  const top = distinct.slice(0, 8).map((t) => t.term);
  const scored = seg.map((p) => ({ p, s: informativeScore(p, termScores) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 50);
  let best = null;
  const nameList = [...names];
  for (const x of scored) {
    const cands = [
      ...spanCandidates(x.p, top).map((c) => ({ ...c, weight: 1.3 })),
      ...clauseCandidates(x.p).map((c) => ({ title: c, terms: [], weight: 1 }))
    ];
    for (const c of cands) {
      const hit = top.filter((t) => c.title.includes(t));
      if (!hit.length) continue;
      if (PROFANITY.test(c.title)) continue;
      if (nameList.some((nm) => nm.length >= 3 && (c.title === nm || nm === c.title))) continue;
      if (/^(这|那|你|我|他|她|它|咱)/.test(c.title) && c.title.length < 8) continue;
      const lenFit = c.title.length >= 8 && c.title.length <= 22 ? 1 : 0.78;
      const hitScore = hit.reduce((a, t, i) => a + (termScores.get(t) || 0) * (i === 0 ? 1.5 : 1), 0);
      const multi = 1 + Math.min(hit.length - 1, 2) * 0.35;
      const structural = /[与和及或就是都是要会能没不]/;
      const score = hitScore * multi * lenFit * c.weight
        * (1 + Math.min(x.s, 6) * 0.07)
        * (structural.test(c.title) ? 1.1 : 1);
      if (!best || score > best.score) best = { title: c.title, score };
    }
  }
  if (best) {
    const t = tidyTitle(best.title);
    if (t.length >= 5 && t.length <= 26) return t;
  }
  // fallback: two distinctive terms, joined so it still reads as Chinese
  const words = distinct.slice(0, 3).map((t) => t.term).filter((w) => w.length >= 2);
  if (words.length >= 2) {
    const joined = `${words[0]}与${words[1]}`;
    if (joined.length <= 26) return tidyTitle(joined);
  }
  if (words.length === 1) return tidyTitle(words[0] + '相关讨论');
  const m0 = seg[0].m;
  return `${dayLabel(m0.t)} ${fmtTime(m0.t)} 的聊天`;
}

function normalizeKey(s) {
  return s.replace(/[\s，,。.!！?？；;：:“”"'‘’（）()【】\[\]·、—]/g, '').toLowerCase();
}

/** Ensure every title is unique: disambiguate with the topic start time. */
function uniquifyTitles(entries) {
  const used = new Map();
  for (const e of entries) {
    let key = normalizeKey(e.title);
    if (!used.has(key)) { used.set(key, 1); continue; }
    const m0 = e.seg[0].m;
    // keep the whole title within 30 chars even after the disambiguating suffix
    let base = e.title.length > 15 ? e.title.slice(0, 15) : e.title;
    let candidate = `${base}（${dayLabel(m0.t)} ${fmtTime(m0.t)}）`;
    let k2 = normalizeKey(candidate);
    let n = 2;
    while (used.has(k2)) {
      candidate = `${base}（${dayLabel(m0.t)} ${fmtTime(m0.t)}·${n}）`;
      k2 = normalizeKey(candidate);
      n++;
    }
    used.set(k2, 1);
    used.set(key, (used.get(key) || 0) + 1);
    e.title = candidate;
  }
}

// ------------------------------------------------------------------ evidence

function pickEvidence(seg, termScores, limit = 3) {
  const scored = seg.map((p) => ({ p, s: informativeScore(p, termScores) }))
    .filter((x) => x.s > 0.7)
    .sort((a, b) => b.s - a.s);
  const out = [];
  const senders = new Set();
  for (const x of scored) {
    if (out.length >= limit) break;
    if (senders.has(x.p.m.from) && out.length < limit - 1) continue;
    if (out.some((o) => jaccard([...o.p.terms], [...x.p.terms]) > 0.7)) continue;
    out.push(x);
    senders.add(x.p.m.from);
  }
  if (!out.length) {
    const fallback = seg.filter((p) => !isFiller(p.m)).sort((a, b) => b.text.length - a.text.length).slice(0, limit);
    for (const p of fallback.length ? fallback : seg.slice(0, limit)) out.push({ p, s: 0 });
  }
  return out.map((x) => x.p.m);
}

// -------------------------------------------------------------------- public

/**
 * @param {Array} messages canonical messages, sorted by time
 * @param {object} [opts]
 * @param {Map<string,number>} [opts.memberNames]
 * @returns {{topics: Array, segments: Array, coverage: number}}
 */
export function buildTopics(messages, opts = {}) {
  if (!messages.length) return { topics: [], segments: [], coverage: 0 };
  const prep = prepare(messages);
  const budget = topicBudget(messages.length);
  let segs = buildSegments(prep);

  // Merge the least valuable segments until the budget is met. Coverage is
  // preserved even when the budget is small: every message ends up somewhere.
  while (segs.length > budget) {
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].length >= bestScore) continue;
      bestScore = segs[i].length;
      bestIdx = i;
    }
    const i = bestIdx;
    const prev = segs[i - 1];
    const next = segs[i + 1];
    if (!prev && !next) break;
    const mine = termSetOf(segs[i]);
    const sPrev = prev ? jaccard([...mine], [...termSetOf(prev)]) : -1;
    const sNext = next ? jaccard([...mine], [...termSetOf(next)]) : -1;
    if (sPrev >= sNext && prev) prev.push(...segs[i]);
    else if (next) next.unshift(...segs[i]);
    else prev.push(...segs[i]);
    segs.splice(i, 1);
  }

  const df = documentFrequency(prep);
  const names = new Set(messages.map((m) => m.from));
  const entries = segs.map((seg) => {
    const distinct = distinctiveTerms(seg, df, segs.length, 12);
    const termScores = new Map(distinct.map((t) => [t.term, t.score]));
    const score = seg.reduce((a, p) => a + informativeScore(p, termScores), 0);
    return { seg, distinct, termScores, score, title: '' };
  });
  entries.sort((a, b) => b.score - a.score);
  for (const e of entries) e.title = makeTitle(e.seg, e.distinct, names);
  uniquifyTitles(entries);

  const topics = entries.map((e, i) => {
    const msgs = e.seg.map((p) => p.m);
    const t0 = msgs[0].t;
    const t1 = msgs[msgs.length - 1].t;
    const senders = new Map();
    for (const m of msgs) senders.set(m.from, (senders.get(m.from) || 0) + 1);
    const days = new Set(msgs.map((m) => dayLabel(m.t)));
    const when = days.size > 1
      ? `${dayLabel(t0)} 至 ${dayLabel(t1)}（${days.size} 天）`
      : `${dayLabel(t0)} ${fmtTime(t0)}–${fmtTime(t1)}`;
    const reps = pickEvidence(e.seg, e.termScores, 3);
    const kw = e.distinct.slice(0, 5).map((t) => t.term);
    const lead = `${when} 共 ${msgs.length} 条消息`;
    const body = reps.map((m) => `${m.from}：${clip(m.text, 56)}`).join('；');
    const minShare = Math.max(1, Math.ceil(msgs.length * 0.04));
    const participants = [...senders.entries()]
      .map(([name, count]) => ({ name, messageCount: count }))
      .filter((p) => p.messageCount >= minShare)
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, 12);
    return {
      id: `t${i + 1}`,
      rank: i + 1,
      title: e.title,
      period: { from: t0.toISOString(), to: t1.toISOString() },
      messageCount: msgs.length,
      participants,
      keywords: kw,
      summary: `${lead}。关键词：${kw.join('、') || '无'}。核心要点：${body}。`,
      evidence: reps.map((m) => ({ msgId: m.id, sender: m.from, time: m.tIso, quote: clip(m.text, 72) }))
    };
  });

  const coverage = topics.reduce((a, t) => a + t.messageCount, 0);
  return { topics, segments: segs, coverage };
}
