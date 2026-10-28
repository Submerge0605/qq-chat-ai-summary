// LLM (OpenAI-compatible) summary engine — v0.5.
//
// 与 v0.4 的差别（针对「24k 条群消息只出 7 个话题、标题全是占位词」的根因）：
//   1. map：段更大（12000 字符 / 400 条），并发 3，每段要求 8–14 个话题；
//   2. reduce：话题不再交给模型「合并成 5–7 个」，改为程序按标题/关键词 jaccard 合并，
//      并保证大群至少保留 min(100, 消息数/250) 个话题；
//   3. 每个话题的 messageCount 由证据 msgId + 关键词命中回填并按比例归一（总和 ≤ 总消息数）；
//   4. 标题清洗（5–30 字、去掉「回复消息/图片/表情」等占位词）并按 normalizeKey 去重；
//   5. 分段结果 > 6 时按 6 段一组做两级合并，避免 60000 字符截断丢内容；
//   6. 契约不变：{overview, topics, members, conclusions, todos, risks, stats, engine:'llm', limitations}。
//
// 任何一步失败都会尽量降级而不是丢结果；彻底失败（例如接口不可达）时抛错，
// 由 summarize/index.mjs 回退到离线引擎。
import { clip, cleanText, cjkTerms, jaccard } from '../util.mjs';

// --------------------------------------------------------------------- 常量
const MAP_MAX_CHARS = 12000;      // 每段字符上限（v0.4: 8000）
const MAP_MAX_COUNT = 400;        // 每段消息条数上限（v0.4: 300）
const MAP_OVERLAP_CHARS = 1500;   // 段间重叠，避免一个对话被切断
const MAP_CONCURRENCY = 3;        // 并发请求数（v0.4 串行）
const TOPICS_PER_SEGMENT_MIN = 8; // 提示词里要求的下限
const TOPICS_PER_SEGMENT_MAX = 14;
const MERGE_THRESHOLD = 0.45;     // 标题/关键词 jaccard 合并阈值
const EVIDENCE_CAP = 8;           // 单话题证据上限
const KEYWORD_CAP = 8;
const REDUCE_BATCH = 6;           // 分层 reduce 每组段数
const REDUCE_MAX_LEVELS = 3;
const PROMPT_JSON_CAP = 20000;    // 单次合并请求的 JSON 上限

const SYSTEM_PROMPT = `你是一名中文聊天记录分析助理。你只依据用户提供的聊天片段作答，不编造。
输出严格为 JSON，不要输出 Markdown 代码块或任何解释文字。`;

const BANNED_TITLE = /(回复消息|图片|表情|链接|转发|文件|语音|视频|红包|系统消息|撤回了一条消息|\[[^\]]{0,12}\])/g;
const TITLE_MIN = 5;
const TITLE_MAX = 30;

// ----------------------------------------------------------------- 工具函数

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 标题去重用的规范化键（与 topics.mjs 保持一致的口径）。 */
function normalizeKey(s) {
  return String(s || '').replace(/[\s，,。.!！?？；;：:“”"'‘’（）()【】\[\]·、—…]/g, '').toLowerCase();
}

function fmtStamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** 每个话题按消息量应该保留的数量下限（大群 ≥96，小群至少 1）。 */
function topicFloor(messageCount) {
  return Math.max(1, Math.min(100, Math.floor(messageCount / 250)));
}

/**
 * 标题清洗：去占位词/消息号/首尾标点，长度收敛到 5–30。
 * 太短时用「去掉占位词后的关键词」补足，仍然不足才退回「时间 + 讨论」。
 */
function stripBanned(s) {
  return String(s || '').replace(BANNED_TITLE, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeTitle(raw, keywords, when) {
  const kws = (keywords || []).map(stripBanned).filter((k) => k.length >= 2);
  let t = stripBanned(cleanText(String(raw || '')));
  t = t.replace(/^[\s\d\-—:：·、，,。.!！?？]+/, '').replace(/[\s\-—:：·、，,。.!！?？]+$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) {
    t = kws.length ? `${kws.slice(0, 2).join('、')}的讨论` : (when ? `${when} 的讨论` : '本段讨论');
  }
  if (t.length < TITLE_MIN) {
    const kw = kws.find((k) => k.length >= 2);
    t = kw ? `${t}·${kw}` : `${t}相关讨论`;
  }
  /* 二次兜底：补足用的关键词本身也可能带占位词，这里再过一遍 */
  t = stripBanned(t);
  if (t.length < TITLE_MIN) t = `${t}讨论`;
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX).trim();
  return t;
}

/** 标题唯一化：同 normalizeKey 冲突时加「（MM-DD HH:mm）」，必要时再追加序号。 */
function uniquifyTitles(entries) {
  const used = new Map();
  for (const e of entries) {
    const key = normalizeKey(e.title);
    if (!used.has(key)) {
      used.set(key, 1);
      continue;
    }
    const stamp = fmtStamp(e.from);
    const base = e.title.length > 16 ? e.title.slice(0, 16) : e.title;
    let candidate = stamp ? `${base}（${stamp}）` : `${base}（${e.rank || 1}）`;
    let k = normalizeKey(candidate);
    let n = 2;
    while (used.has(k) && n < 50) {
      candidate = stamp ? `${base}（${stamp}·${n}）` : `${base}（${e.rank || 1}·${n}）`;
      k = normalizeKey(candidate);
      n++;
    }
    used.set(k, 1);
    e.title = candidate.length > TITLE_MAX ? candidate.slice(0, TITLE_MAX) : candidate;
  }
}

// ------------------------------------------------------------------ 网络层

async function callChat({ baseUrl, apiKey, model, messages, temperature = 0.2, maxTokens = 2000 }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(120000)
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? '请求超时' : (err?.cause?.code || err?.message || '网络错误');
    throw new Error(`无法连接大模型接口 ${url}（${reason}）：请检查接口地址、网络与代理设置`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 返回为空');
  return content;
}

function parseJsonLoose(text) {
  const t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('LLM 返回不是合法 JSON');
  }
}

// -------------------------------------------------------------------- 分块

function chunkMessages(messages, { maxChars = MAP_MAX_CHARS, maxCount = MAP_MAX_COUNT, overlapChars = MAP_OVERLAP_CHARS } = {}) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const m of messages) {
    const line = `[${m.id}] ${m.from}(${new Date(m.t).toLocaleString('zh-CN')}): ${m.text}`;
    if (cur.length && (size + line.length > maxChars || cur.length >= maxCount)) {
      chunks.push(cur);
      const carry = [];
      let carrySize = 0;
      for (let i = cur.length - 1; i >= 0 && carrySize < overlapChars; i--) {
        carry.unshift(cur[i]);
        carrySize += cur[i].length;
      }
      cur = carry.slice(0, Math.max(0, carry.length - 1));
      size = cur.reduce((a, l) => a + l.length, 0);
    }
    cur.push(line);
    size += line.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// --------------------------------------------------------------- 提示词构造

const MAP_PROMPT = (chunk, meta) => `下面是「${meta.chatName}」在 ${meta.fromLabel} 至 ${meta.toLabel} 之间的一段聊天记录（第 ${chunk.index}/${chunk.total} 段，共 ${chunk.lines.length} 条）。
请把这一段按讨论内容**拆成 ${TOPICS_PER_SEGMENT_MIN}–${TOPICS_PER_SEGMENT_MAX} 个话题**，覆盖整段内容（不要只挑最显眼的几条），输出 JSON：
{"topics":[{"title":"话题短标题","summary":"2-4句概括，写清讨论过程与结论","keywords":["3-6个关键词"],"participants":["本段真实发言人"],"evidence":["msgId1","msgId2"]}],
 "conclusions":[{"text":"明确达成的结论或决策","evidence":["msgId"]}],
 "todos":[{"owner":"负责人或待指派","task":"要做的事","due":"时间要求或未说明","evidence":["msgId"]}],
 "risks":[{"text":"风险或隐患","evidence":["msgId"]}]}

硬性要求：
- 话题数必须在 ${TOPICS_PER_SEGMENT_MIN}–${TOPICS_PER_SEGMENT_MAX} 个之间；不同主题不要合并，同一件事不要拆开；
- title 为 5–30 个字的具体中文短标题（例如「周四提测范围收敛」），禁止出现「回复消息」「图片」「表情」「链接」「转发」「[图片]」等占位词，也不要只用「XX的讨论」这种空泛说法；
- title 在本段内不得重复；
- participants 与 evidence 只能引用本段真实出现的人和 msgId（形如方括号里的 id），不要编造；
- 没有依据的字段给空数组。

聊天记录：
${chunk.lines.join('\n')}`;

const MERGE_PROMPT = (batch, meta, withOverview) => `下面是「${meta.chatName}」在 ${meta.fromLabel} 至 ${meta.toLabel} 之间的分段分析结果（第 ${batch.index}/${batch.total} 组，共 ${batch.items.length} 段）。
请把它们合并成去重后的结论 / 待办 / 风险${withOverview ? '，并写总体概述' : ''}，输出 JSON：
{"${withOverview ? 'overview":"3-5句总体概述（覆盖讨论主线、关键决策与最活跃成员）",\n ' : ''}"conclusions":[{"text":"结论","evidence":["msgId"]}],
 "todos":[{"owner":"负责人或待指派","task":"要做的事","due":"时间要求或未说明","evidence":["msgId"]}],
 "risks":[{"text":"风险","evidence":["msgId"]}]}
要求：合并同一件事的重复项，保留具体可执行的表述；evidence 必须是下面出现过的真实 msgId；没有就给空数组。

分段结果：
${JSON.stringify(batch.items).slice(0, PROMPT_JSON_CAP)}`;

// ------------------------------------------------------------------ map 阶段

function toChunkMeta(lines) {
  const ids = [];
  const times = [];
  for (const line of lines) {
    const m = /^\[([^\]]{1,80})\]/.exec(line);
    if (m) ids.push(m[1]);
    const t = /\((\d{4}[^)]*)\)/.exec(line);
    if (t) {
      const d = new Date(t[1]);
      if (!Number.isNaN(d.getTime())) times.push(d);
    }
  }
  return {
    ids,
    from: times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null,
    to: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null
  };
}

/** 把一段的模型输出整理成统一结构，并丢掉不存在的 msgId。 */
function normalizePartial(json, chunkMeta) {
  const ids = new Set(chunkMeta.ids);
  const pickIds = (raw) => (Array.isArray(raw) ? raw : (raw ? [raw] : []))
    .map((x) => String(x).trim())
    .filter((x) => ids.has(x));

  const topics = (Array.isArray(json?.topics) ? json.topics : [])
    .map((t) => {
      if (!t || typeof t !== 'object') return null;
      const title = String(t.title || '').trim();
      if (!title) return null;
      return {
        title,
        summary: String(t.summary || '').trim(),
        keywords: (Array.isArray(t.keywords) ? t.keywords : []).map((k) => String(k).trim()).filter(Boolean).slice(0, KEYWORD_CAP),
        participants: (Array.isArray(t.participants) ? t.participants : []).map((n) => String(n).trim()).filter(Boolean),
        evidenceIds: pickIds(t.evidence),
        from: chunkMeta.from,
        to: chunkMeta.to,
        order: 0
      };
    })
    .filter(Boolean)
    .slice(0, TOPICS_PER_SEGMENT_MAX + 4);

  return {
    topics,
    conclusions: (Array.isArray(json?.conclusions) ? json.conclusions : [])
      .map((c) => (typeof c === 'string'
        ? { text: c, evidenceIds: [] }
        : { text: String(c?.text || '').trim(), evidenceIds: pickIds(c?.evidence) }))
      .filter((c) => c.text)
      .slice(0, 8),
    todos: (Array.isArray(json?.todos) ? json.todos : [])
      .map((t) => (typeof t === 'string'
        ? { owner: '待指派', task: t, due: '未说明', evidenceIds: [] }
        : {
          owner: String(t?.owner || '待指派').trim(),
          task: String(t?.task || '').trim(),
          due: String(t?.due || '未说明').trim(),
          evidenceIds: pickIds(t?.evidence)
        }))
      .filter((t) => t.task)
      .slice(0, 8),
    risks: (Array.isArray(json?.risks) ? json.risks : [])
      .map((r) => (typeof r === 'string'
        ? { text: r, evidenceIds: [] }
        : { text: String(r?.text || '').trim(), evidenceIds: pickIds(r?.evidence) }))
      .filter((r) => r.text)
      .slice(0, 6)
  };
}

async function mapOne(chunk, index, total, meta, llm, chunkMeta, onProgress, stats) {
  const userPrompt = MAP_PROMPT({ index, total, lines: chunk }, meta);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await callChat({
        ...llm,
        maxTokens: 3000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ]
      });
      const parsed = normalizePartial(parseJsonLoose(content), chunkMeta);
      stats.topics += parsed.topics.length;
      return parsed;
    } catch (err) {
      lastErr = err;
    }
  }
  stats.failedSegments++;
  stats.lastError = lastErr?.message || '未知错误';
  return { topics: [], conclusions: [], todos: [], risks: [], failed: true };
}

async function mapChunks(chunks, metas, meta, llm, onProgress, stats) {
  const partials = new Array(chunks.length);
  let next = 0;
  let done = 0;
  const total = chunks.length;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      onProgress('map', 5 + Math.round((done / Math.max(1, total)) * 65), `分析第 ${i + 1}/${total} 段`);
      partials[i] = await mapOne(chunks[i], i + 1, total, meta, llm, metas[i], onProgress, stats);
      done++;
      onProgress('map', 5 + Math.round((done / Math.max(1, total)) * 65), `已完成 ${done}/${total} 段`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAP_CONCURRENCY, total) }, () => worker()));
  return partials;
}

// --------------------------------------------------------------- 话题合并

function topicBag(item) {
  if (!item.__titleTerms) item.__titleTerms = [...new Set(cjkTerms(item.title))];
  if (!item.__kwTerms) item.__kwTerms = [...new Set(item.keywords.map((k) => k.toLowerCase()))];
  return item;
}

function similarity(a, b) {
  topicBag(a);
  topicBag(b);
  const t = jaccard(a.__titleTerms, b.__titleTerms);
  if (t >= MERGE_THRESHOLD) return t;
  return jaccard(a.__kwTerms, b.__kwTerms);
}

function richer(a, b) {
  if (a.evidenceIds.length !== b.evidenceIds.length) return a.evidenceIds.length > b.evidenceIds.length;
  if (a.keywords.length !== b.keywords.length) return a.keywords.length > b.keywords.length;
  return a.order <= b.order;
}

function mergeInto(keep, drop) {
  keep.evidenceIds = [...new Set([...keep.evidenceIds, ...drop.evidenceIds])].slice(0, EVIDENCE_CAP);
  keep.keywords = [...new Set([...keep.keywords, ...drop.keywords])].slice(0, KEYWORD_CAP);
  keep.participants = [...new Set([...keep.participants, ...drop.participants])];
  if (drop.from && (!keep.from || drop.from < keep.from)) keep.from = drop.from;
  if (drop.to && (!keep.to || drop.to > keep.to)) keep.to = drop.to;
  if ((drop.summary || '').length > (keep.summary || '').length) keep.summary = drop.summary;
  delete keep.__titleTerms;
  delete keep.__kwTerms;
}

/**
 * 程序合并：标题或关键词 jaccard ≥ 0.45 视为同一话题，保留证据更多的一条；
 * 合并到「下限」就不再合并，保证大群话题数不塌缩。
 */
function mergeTopics(items, floor) {
  const list = items.map(topicBag);
  const n = list.length;
  if (n <= 1) return list.slice();

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    let x = i;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = similarity(list[i], list[j]);
      if (sim >= MERGE_THRESHOLD) pairs.push({ sim, i, j });
    }
  }
  pairs.sort((a, b) => b.sim - a.sim);

  let alive = n;
  for (const p of pairs) {
    if (alive <= floor) break;
    const a = find(p.i);
    const b = find(p.j);
    if (a === b) continue;
    const keep = richer(list[a], list[b]) ? a : b;
    const drop = keep === a ? b : a;
    mergeInto(list[keep], list[drop]);
    parent[drop] = keep;
    alive--;
  }

  const roots = new Set();
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (roots.has(r)) continue;
    roots.add(r);
    out.push(list[r]);
  }
  return out;
}

// --------------------------------------------------- messageCount / 成员回填

/** 按「首字分桶」建关键词倒排，避免 24k×上百个关键词的 O(n·m) 全量扫描。 */
function buildKeywordPostings(messages, keywords) {
  const uniq = [...new Set(keywords.map((k) => String(k || '').trim()).filter((k) => k.length >= 2 && k.length <= 12))];
  const byFirst = new Map();
  for (const kw of uniq) {
    const c = kw[0];
    if (!byFirst.has(c)) byFirst.set(c, []);
    byFirst.get(c).push(kw);
  }
  const postings = new Map(uniq.map((k) => [k, []]));
  const chars = new Set();
  messages.forEach((m, idx) => {
    const text = m.text || '';
    chars.clear();
    for (const ch of text) chars.add(ch);
    for (const ch of chars) {
      const list = byFirst.get(ch);
      if (!list) continue;
      for (const kw of list) {
        if (text.includes(kw)) postings.get(kw).push(idx);
      }
    }
  });
  return postings;
}

function messageTimes(m, fallbackFrom, fallbackTo) {
  const t = m.t instanceof Date ? m.t : new Date(m.tIso || m.t);
  if (Number.isNaN(t.getTime())) return { from: fallbackFrom, to: fallbackTo };
  return { from: t, to: t };
}

/**
 * 回填真实消息集合：
 *   evidence msgId ∪ 关键词命中（过泛的关键词丢弃） → 归一化到「总和 ≤ 总消息数」。
 */
function backfillTopicCounts(topics, messages, postings, total) {
  const limitPerKeyword = Math.max(50, Math.floor(total * 0.08));
  const raw = [];

  for (const t of topics) {
    const idx = new Set();
    for (const id of t.evidenceIds) {
      // 证据 id 先转成下标；messages 里 id 唯一，这里用一次性索引
      const i = t.__idIndex ? t.__idIndex.get(String(id)) : undefined;
      if (typeof i === 'number') idx.add(i);
    }
    if (!t.__idIndex) {
      // 没有预建索引时按需构建（正常路径已在外面建好）
      t.__idIndex = new Map(messages.map((m, i) => [String(m.id), i]));
      for (const id of t.evidenceIds) {
        const i = t.__idIndex.get(String(id));
        if (typeof i === 'number') idx.add(i);
      }
    }
    for (const kw of t.keywords) {
      const hits = postings.get(String(kw).trim());
      if (!hits || !hits.length) continue;
      if (hits.length > limitPerKeyword) continue; // 过泛的词不参与（如「项目」）
      for (const i of hits) idx.add(i);
    }
    raw.push({ topic: t, idx });
  }

  const rawSum = raw.reduce((a, r) => a + r.idx.size, 0);
  let scale = 1;
  if (rawSum > total && rawSum > 0) scale = total / rawSum;

  const counts = raw.map(({ topic, idx }) => {
    if (!idx.size) return { topic, idx, count: 0 };
    const scaled = Math.max(1, Math.round(idx.size * scale));
    return { topic, idx, count: scaled };
  });

  // 修正：保证总和 ≤ 总消息数
  let sum = counts.reduce((a, c) => a + c.count, 0);
  if (sum > total) {
    const sorted = counts.slice().sort((a, b) => b.count - a.count);
    let overflow = sum - total;
    for (const c of sorted) {
      if (overflow <= 0) break;
      const cut = Math.min(c.count - 1, overflow);
      c.count -= cut;
      overflow -= cut;
    }
    sum = counts.reduce((a, c) => a + c.count, 0);
  }

  return counts.map(({ topic, idx, count }) => {
    const senders = new Map();
    for (const i of idx) {
      const name = messages[i].from;
      senders.set(name, (senders.get(name) || 0) + 1);
    }

    /* 参与者：按比例分配到 count 条以内，且每个人的计数 ≥1、总和 == count */
    let participants = [];
    if (count > 0 && senders.size) {
      const ranked = [...senders.entries()].sort((a, b) => b[1] - a[1]);
      const keep = ranked.slice(0, Math.min(ranked.length, count));
      const memberTotal = keep.reduce((a, x) => a + x[1], 0) || 1;
      let assigned = 0;
      participants = keep.map(([name, n]) => {
        const c = Math.max(1, Math.round((n / memberTotal) * count));
        assigned += c;
        return { name, messageCount: c };
      });
      while (assigned > count) {
        let maxP = null;
        for (const p of participants) {
          if (p.messageCount > 1 && (!maxP || p.messageCount > maxP.messageCount)) maxP = p;
        }
        if (!maxP) break;
        maxP.messageCount--;
        assigned--;
      }
      participants = participants.sort((a, b) => b.messageCount - a.messageCount).slice(0, 12);
    }

    /* 证据兜底：没有任何 evidence msgId 的话题，用它命中的真实消息补 1–3 条 */
    let evidenceIds = topic.evidenceIds.slice();
    if (!evidenceIds.length && idx.size) {
      const arr = [...idx].sort((a, b) => a - b);
      const picks = [arr[0], arr[Math.floor(arr.length / 2)], arr[arr.length - 1]];
      evidenceIds = [...new Set(picks)].filter((i) => typeof i === 'number').map((i) => String(messages[i].id));
    }

    let from = topic.from;
    let to = topic.to;
    for (const i of idx) {
      const tt = messageTimes(messages[i], from, to);
      if (!from || (tt.from && tt.from < from)) from = tt.from;
      if (!to || (tt.to && tt.to > to)) to = tt.to;
    }
    return { topic, idx, count, participants, from, to, evidenceIds };
  });
}

// ------------------------------------------------------------- reduce 阶段

/* reduce 阶段的数据统一用英文键，规则合并与两级合并都能直接吃 */
function digestOf(partial, index, chunkMeta) {
  return {
    seg: index + 1,
    time: chunkMeta?.from && chunkMeta?.to
      ? `${fmtStamp(chunkMeta.from)}~${fmtStamp(chunkMeta.to)}`
      : undefined,
    topics: partial.topics.slice(0, 12).map((t) => clip(t.title, 24)),
    conclusions: partial.conclusions.slice(0, 6).map((c) => ({ text: clip(c.text, 60), evidence: c.evidenceIds.slice(0, 2) })),
    todos: partial.todos.slice(0, 6).map((t) => ({
      owner: clip(t.owner, 12), task: clip(t.task, 50), due: clip(t.due, 12), evidence: t.evidenceIds.slice(0, 2)
    })),
    risks: partial.risks.slice(0, 4).map((r) => ({ text: clip(r.text, 50), evidence: r.evidenceIds.slice(0, 2) }))
  };
}

function ruleMergeDigests(items) {
  const conclusions = [];
  const todos = [];
  const risks = [];
  const seen = new Set();
  for (const it of items) {
    for (const c of it.conclusions || []) {
      const k = `c:${normalizeKey(c.text)}`;
      if (seen.has(k) || !c.text) continue;
      seen.add(k);
      conclusions.push({ text: c.text, evidenceIds: c.evidence || [] });
    }
    for (const t of it.todos || []) {
      const k = `t:${normalizeKey(t.task)}`;
      if (seen.has(k) || !t.task) continue;
      seen.add(k);
      todos.push({ owner: t.owner || '待指派', task: t.task, due: t.due || '未说明', evidenceIds: t.evidence || [] });
    }
    for (const r of it.risks || []) {
      const k = `r:${normalizeKey(r.text)}`;
      if (seen.has(k) || !r.text) continue;
      seen.add(k);
      risks.push({ text: r.text, evidenceIds: r.evidence || [] });
    }
  }
  return { conclusions: conclusions.slice(0, 8), todos: todos.slice(0, 10), risks: risks.slice(0, 8) };
}

function normalizeReduce(json, validIds) {
  const pickIds = (raw) => (Array.isArray(raw) ? raw : (raw ? [raw] : []))
    .map((x) => String(x).trim())
    .filter((x) => validIds.has(x));
  return {
    overview: String(json?.overview || '').trim(),
    conclusions: (Array.isArray(json?.conclusions) ? json.conclusions : [])
      .map((c) => (typeof c === 'string'
        ? { text: c, evidenceIds: [] }
        : { text: String(c?.text || '').trim(), evidenceIds: pickIds(c?.evidence) }))
      .filter((c) => c.text).slice(0, 8),
    todos: (Array.isArray(json?.todos) ? json.todos : [])
      .map((t) => (typeof t === 'string'
        ? { owner: '待指派', task: t, due: '未说明', evidenceIds: [] }
        : {
          owner: String(t?.owner || '待指派').trim(),
          task: String(t?.task || '').trim(),
          due: String(t?.due || '未说明').trim(),
          evidenceIds: pickIds(t?.evidence)
        }))
      .filter((t) => t.task).slice(0, 10),
    risks: (Array.isArray(json?.risks) ? json.risks : [])
      .map((r) => (typeof r === 'string'
        ? { text: r, evidenceIds: [] }
        : { text: String(r?.text || '').trim(), evidenceIds: pickIds(r?.evidence) }))
      .filter((r) => r.text).slice(0, 8)
  };
}

async function reduceHierarchical(digests, meta, llm, validIds, onProgress, notes) {
  let level = digests;
  let levelNo = 0;

  while (level.length > REDUCE_BATCH && levelNo < REDUCE_MAX_LEVELS) {
    levelNo++;
    const batches = [];
    for (let i = 0; i < level.length; i += REDUCE_BATCH) batches.push(level.slice(i, i + REDUCE_BATCH));
    const next = [];
    for (let i = 0; i < batches.length; i++) {
      onProgress('reduce', 70 + Math.round(((i + 1) / (batches.length + 1)) * 15),
        `第 ${levelNo} 层合并 ${i + 1}/${batches.length} 组`);
      let merged;
      try {
        const content = await callChat({
          ...llm,
          maxTokens: 3000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: MERGE_PROMPT({ index: i + 1, total: batches.length, items: batches[i] }, meta, false)
            }
          ]
        });
        merged = normalizeReduce(parseJsonLoose(content), validIds);
      } catch (err) {
        notes.push(`第 ${levelNo} 层第 ${i + 1} 组合并失败，改用规则合并：${err.message}`);
        merged = ruleMergeDigests(batches[i]);
      }
      next.push({
        seg: `L${levelNo}-${i + 1}`,
        topics: [...new Set(batches[i].flatMap((b) => b.topics || []))].slice(0, 20),
        conclusions: merged.conclusions, todos: merged.todos, risks: merged.risks
      });
    }
    level = next;
  }

  onProgress('reduce', 88, '合并结论 / 待办 / 风险并生成概述');
  try {
    const content = await callChat({
      ...llm,
      maxTokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: MERGE_PROMPT({ index: 1, total: 1, items: level }, meta, true)
        }
      ]
    });
    return normalizeReduce(parseJsonLoose(content), validIds);
  } catch (err) {
    notes.push(`最终合并失败，结论/待办/风险改用规则合并：${err.message}`);
    const fallback = ruleMergeDigests(level);
    return { overview: '', ...fallback };
  }
}

// --------------------------------------------------------------- 组装输出

function periodLabel(from, to) {
  return `${fmtStamp(from)}~${fmtStamp(to)}`;
}

function buildFallbackOverview({ chatName, period, topics, members, conclusions, todos, risks }) {
  const topMembers = members.slice(0, 3).map((m) => `${m.name}（${m.messageCount} 条）`).join('、');
  const topTitles = topics.slice(0, 6).map((t) => `「${t.title}」`).join('');
  return [
    `本次总结覆盖「${chatName}」${period} 的聊天记录，共识别 ${topics.length} 个话题、`,
    `${conclusions.length} 项结论、${todos.length} 项待办、${risks.length} 处风险。`,
    topTitles ? `主要话题包括：${topTitles}${topics.length > 6 ? '等' : ''}。` : '',
    topMembers ? `最活跃的成员是 ${topMembers}。` : ''
  ].join('');
}

/**
 * @param {object} args
 * @param {Array} args.messages canonical messages
 * @param {object} args.chat
 * @param {object} args.params normalized params (labels)
 * @param {object} args.llm {baseUrl, apiKey, model}
 * @param {(phase:string, pct:number, msg:string)=>void} [args.onProgress]
 */
export async function summarizeWithLLM({ messages, chat, params, llm, onProgress = () => {} }) {
  const chatName = chat?.name || params?.chatId || '会话';
  const period = `${params?.fromLabel || ''} 至 ${params?.toLabel || ''}`;

  const baseStats = {
    messageCount: messages.length,
    memberCount: new Set(messages.map((m) => m.from)).size,
    charCount: messages.reduce((a, m) => a + (m.text || '').length, 0),
    mediaCount: messages.filter((m) => m.kind !== 'text' && m.kind !== 'system').length,
    systemCount: messages.filter((m) => m.kind === 'system').length,
    spanFrom: messages.length ? messages[0].tIso : null,
    spanTo: messages.length ? messages[messages.length - 1].tIso : null,
    byKind: messages.reduce((acc, m) => { acc[m.kind] = (acc[m.kind] || 0) + 1; return acc; }, {})
  };

  if (!messages.length) {
    return {
      overview: `${chatName} 在 ${period} 内没有符合条件的消息。可能是时间段过窄、关键词过滤过严，或该对象在此期间没有发言。`,
      topics: [], members: [], conclusions: [], todos: [], risks: [],
      stats: { ...baseStats, perMember: [], byDay: [], timeRange: { start: null, end: null }, evidenceCount: 0, topicCount: 0 },
      engine: 'llm',
      limitations: ['无消息可总结']
    };
  }

  const chunks = chunkMessages(messages);
  const metas = chunks.map((lines) => toChunkMeta(lines));
  const stats = { topics: 0, failedSegments: 0, lastError: '' };

  onProgress('llm', 5, `LLM 分析：${messages.length} 条消息分 ${chunks.length} 段，并发 ${MAP_CONCURRENCY}`);
  const partials = await mapChunks(chunks, metas, {
    chatName, fromLabel: params?.fromLabel, toLabel: params?.toLabel
  }, llm, onProgress, stats);

  const usable = partials.filter((p) => !p.failed);
  if (!usable.length) {
    throw new Error(`LLM 全部分段分析失败（${stats.failedSegments}/${chunks.length} 段）：${stats.lastError || '未知错误'}`);
  }

  // ------------------------------------------------ 组装候选话题（保留分段顺序）
  const candidates = [];
  partials.forEach((p, ci) => {
    p.topics.forEach((t, ti) => {
      candidates.push({ ...t, order: ci * 1000 + ti });
    });
  });

  const floor = topicFloor(messages.length);
  onProgress('reduce', 70, `${candidates.length} 个候选话题，按 jaccard≥${MERGE_THRESHOLD} 合并（下限 ${floor}）`);
  const merged = mergeTopics(candidates, floor);

  // ------------------------------------------------ 回填 messageCount / 参与者
  const idIndex = new Map(messages.map((m, i) => [String(m.id), i]));
  const allKeywords = merged.flatMap((t) => t.keywords);
  const postings = buildKeywordPostings(messages, allKeywords);
  for (const t of merged) t.__idIndex = idIndex;
  const counted = backfillTopicCounts(merged, messages, postings, messages.length);

  // ------------------------------------------------ 标题 + 话题对象
  const entries = counted.map((c, i) => {
    const title = sanitizeTitle(c.topic.title, c.topic.keywords, c.from ? fmtStamp(c.from) : '');
    return {
      title,
      summary: c.topic.summary || '',
      keywords: c.topic.keywords.slice(0, KEYWORD_CAP),
      evidenceIds: (c.evidenceIds || c.topic.evidenceIds).slice(0, EVIDENCE_CAP),
      participants: c.participants,
      messageCount: c.count,
      from: c.from,
      to: c.to,
      rank: i + 1
    };
  });
  entries.sort((a, b) => (b.evidenceIds.length - a.evidenceIds.length)
    || (b.messageCount - a.messageCount)
    || ((a.from?.getTime() || 0) - (b.from?.getTime() || 0)));
  entries.forEach((e, i) => { e.rank = i + 1; });
  uniquifyTitles(entries);

  const ev = (id) => {
    const i = idIndex.get(String(id));
    if (typeof i !== 'number') return null;
    const m = messages[i];
    /* 图片/表情等媒体消息清洗后可能为空，quote 用占位说明，避免出现空引用 */
    const quote = clip(m.text, 80) || `[${m.kind === 'text' ? '空消息' : m.kind}]`;
    return { msgId: m.id, sender: m.from, time: m.tIso, quote };
  };
  const evList = (ids) => (Array.isArray(ids) ? ids : (ids ? [ids] : [])).map(ev).filter(Boolean);

  const topics = entries.map((e, i) => ({
    id: `t${i + 1}`,
    rank: i + 1,
    title: e.title,
    summary: e.summary,
    keywords: e.keywords,
    participants: e.participants,
    messageCount: e.messageCount,
    period: { from: e.from ? e.from.toISOString() : null, to: e.to ? e.to.toISOString() : null },
    evidence: evList(e.evidenceIds)
  }));

  // ------------------------------------------------------ reduce（结论/待办/风险）
  const digests = partials.map((p, i) => digestOf(p, i, metas[i]));
  const notes = [];
  for (const p of partials) if (p.failed) notes.push('部分分段分析失败，已跳过（见 limitations）');
  const validIds = new Set(messages.map((m) => String(m.id)));
  const reduced = await reduceHierarchical(digests, {
    chatName, fromLabel: params?.fromLabel, toLabel: params?.toLabel
  }, llm, validIds, onProgress, notes);
  onProgress('llm', 95, '整理摘要结果');

  const conclusions = reduced.conclusions.map((c) => ({ text: c.text, evidence: evList(c.evidenceIds) }));
  const todos = reduced.todos.map((t) => ({
    owner: t.owner || '待指派', task: t.task, due: t.due || '未说明', evidence: evList(t.evidenceIds)
  }));
  const risks = reduced.risks.map((r) => ({ text: r.text, evidence: evList(r.evidenceIds) }));

  // ------------------------------------------------------------------ 成员
  const memberMap = new Map();
  for (const m of messages) {
    const cur = memberMap.get(m.from) || { name: m.from, uin: m.uin, messageCount: 0, charCount: 0 };
    cur.messageCount++;
    cur.charCount += (m.text || '').length;
    memberMap.set(m.from, cur);
  }
  const members = [...memberMap.values()]
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 12)
    .map((m) => {
      const topicLabels = topics
        .map((t) => {
          const mine = t.participants.find((p) => p.name === m.name);
          return mine && mine.messageCount >= 2 && t.messageCount > 0
            ? { title: t.title, share: mine.messageCount / t.messageCount, mine: mine.messageCount }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.share - a.share)
        .slice(0, 3)
        .map((x) => x.title);
      const quotes = topics
        .flatMap((t) => t.evidence)
        .filter((e) => e.sender === m.name)
        .slice(0, 2)
        .map((e) => e.quote);
      return {
        name: m.name,
        uin: m.uin,
        messageCount: m.messageCount,
        charCount: m.charCount,
        topicCount: topicLabels.length,
        topics: topicLabels,
        roleHint: m.messageCount >= Math.max(20, messages.length * 0.12) ? '主要发言人'
          : m.messageCount <= 3 ? '偶发参与' : '参与讨论',
        points: quotes.length ? quotes : ['该成员在本次摘录的证据中出现较少']
      };
    });

  // ---------------------------------------------------------------- 统计
  const dayCount = new Map();
  for (const m of messages) {
    const d = m.t instanceof Date
      ? `${m.t.getFullYear()}-${pad2(m.t.getMonth() + 1)}-${pad2(m.t.getDate())}`
      : String(m.tIso || '').slice(0, 10);
    dayCount.set(d, (dayCount.get(d) || 0) + 1);
  }
  const evidenceIds = new Set();
  for (const bucket of [topics, conclusions, todos, risks]) {
    for (const item of bucket) for (const e of item.evidence || []) evidenceIds.add(String(e.msgId));
  }
  const statsOut = {
    ...baseStats,
    perMember: members.map((m) => ({ name: m.name, uin: m.uin, messageCount: m.messageCount, charCount: m.charCount })),
    byDay: [...dayCount.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
    timeRange: { start: baseStats.spanFrom, end: baseStats.spanTo },
    evidenceCount: evidenceIds.size,
    topicCount: topics.length,
    participantCount: members.length
  };

  const limitations = [
    `LLM 引擎：${llm.model}，${messages.length} 条消息分 ${chunks.length} 段（并发 ${MAP_CONCURRENCY}）分析后合并。`,
    `话题由 ${candidates.length} 个分段候选按标题/关键词相似度合并为 ${topics.length} 个（下限 ${floor}）。`,
    `话题消息数按证据 msgId 与关键词命中回填并归一，合计 ${topics.reduce((a, t) => a + t.messageCount, 0)} 条（总消息 ${messages.length} 条）。`
  ];
  if (stats.failedSegments) {
    limitations.push(`有 ${stats.failedSegments}/${chunks.length} 段分析失败，已跳过这些段（最后一次错误：${clip(stats.lastError, 120)}）。`);
  }
  for (const n of notes) if (!limitations.includes(n)) limitations.push(n);

  const overview = reduced.overview || buildFallbackOverview({
    chatName, period, topics, members, conclusions, todos, risks
  });

  return {
    overview,
    topics,
    members,
    conclusions,
    todos,
    risks,
    stats: statsOut,
    engine: 'llm',
    limitations
  };
}

export async function checkLLM(llm) {
  const content = await callChat({
    ...llm,
    messages: [{ role: 'user', content: '只回复 JSON：{"ok":true}' }],
    maxTokens: 20
  });
  return parseJsonLoose(content).ok === true;
}
