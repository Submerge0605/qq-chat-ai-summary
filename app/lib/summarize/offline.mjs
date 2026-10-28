// Offline (no-network) summary engine — v0.5.
//
// Pipeline:
//   messages -> topic segmentation (topics.mjs) -> conclusions / todos / risks
//            -> overview + stats
// Topic discovery is data-driven and scales with the chat volume; the old
// fixed taxonomy + 7-topic cap is gone (it collapsed a 24k group into seven
// identical 「回复消息、raven」 titles).
import { buildTopics, topicBudget } from './topics.mjs';
import {
  rankTerms, INTENT, extractMentionNames, clip, cleanText, fmtTime,
  dayLabel, weekdayLabel, jaccard, cjkTerms
} from '../util.mjs';

const FILLER = new Set(['收到', '好的', '嗯嗯', '明白', '好', 'ok', '可以', '哈哈', '👍',
  '在', '辛苦了', '我看看', '稍等', '没问题', '同意', '按这个来']);

function isFiller(m) {
  const t = m.text.trim().toLowerCase();
  return t.length <= 3 || FILLER.has(t) || (/^[\[（(].{1,6}[\]）)]$/.test(t) && t.length <= 6);
}

function isQuestion(m) {
  return /[?？]\s*$/.test(m.text) || /(会不会|能不能|要不要|是不是|有没有|行不行|可以吗)/.test(m.text);
}

function informativeScore(m, termScores) {
  if (isFiller(m)) return 0;
  if (m.kind !== 'text') return 0.3;
  const len = m.text.length;
  let s = Math.min(len, 60) / 22;
  if (len < 10) s *= 0.5;
  if (len > 140) s *= 0.7;
  for (const t of cjkTerms(m.text)) s += (termScores.get(t) || 0) * 0.2;
  if (INTENT.decision.test(m.text)) s += 2.0;
  if (INTENT.todo.test(m.text)) s += 1.2;
  if (INTENT.risk.test(m.text)) s += 1.0;
  if (isQuestion(m)) s *= 0.6;
  return s;
}

function evidenceOf(m, max = 64) {
  return { msgId: m.id, sender: m.from, time: m.tIso, quote: clip(m.text, max) };
}

function dedupeByText(items, pickKey, threshold = 0.6) {
  const kept = [];
  for (const it of items) {
    const terms = cjkTerms(pickKey(it));
    if (kept.some((k) => jaccard(terms, cjkTerms(pickKey(k))) > threshold)) continue;
    kept.push(it);
  }
  return kept;
}

export function summarizeOffline({ chat, messages, params }) {
  const stats = {
    messageCount: messages.length,
    memberCount: new Set(messages.map((m) => m.from)).size,
    charCount: messages.reduce((a, m) => a + m.text.length, 0),
    mediaCount: messages.filter((m) => m.kind !== 'text' && m.kind !== 'system').length,
    systemCount: messages.filter((m) => m.kind === 'system').length,
    spanFrom: messages.length ? messages[0].tIso : null,
    spanTo: messages.length ? messages[messages.length - 1].tIso : null
  };
  stats.byKind = messages.reduce((acc, m) => { acc[m.kind] = (acc[m.kind] || 0) + 1; return acc; }, {});
  const memberMap = new Map();
  for (const m of messages) {
    const cur = memberMap.get(m.from) || { name: m.from, uin: m.uin, messageCount: 0, charCount: 0 };
    cur.messageCount++;
    cur.charCount += m.text.length;
    memberMap.set(m.from, cur);
  }
  stats.perMember = [...memberMap.values()].sort((a, b) => b.messageCount - a.messageCount);

  const period = `${params.fromLabel} 至 ${params.toLabel}`;
  const chatName = chat?.name || params.chatId;

  if (!messages.length) {
    return {
      overview: `${chatName} 在 ${period} 内没有符合条件的消息。可能是时间段过窄、关键词过滤过严，或该对象在此期间没有发言。建议放宽时间范围或去掉过滤条件后重试。`,
      topics: [], members: [], conclusions: [], todos: [], risks: [],
      stats, engine: 'offline', limitations: ['无消息可总结']
    };
  }

  const termScores = (() => {
    const ranked = rankTerms(messages.filter((m) => !isFiller(m)), { minCount: 2, limit: 120 });
    const map = new Map();
    ranked.forEach((t, i) => map.set(t.term, (ranked.length - i) / ranked.length + 0.15));
    return map;
  })();

  // ---------------------------------------------------------------- topics
  const built = buildTopics(messages);
  const topics = built.topics;

  // --------------------------------------------------------------- members
  const members = stats.perMember.slice(0, 12).map((p) => {
    const own = messages.filter((m) => m.from === p.name);
    const quotes = own
      .map((m) => ({ m, s: informativeScore(m, termScores) }))
      .filter((x) => x.s > 1)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .map((x) => clip(x.m.text, 52));
    const topicLabels = topics
      .map((t) => {
        const mine = t.participants.find((x) => x.name === p.name);
        return mine ? { t, share: mine.messageCount / t.messageCount, mine: mine.messageCount } : null;
      })
      .filter((x) => x && x.mine >= 2 && x.share >= 0.08)
      .sort((a, b) => b.share - a.share)
      .slice(0, 3)
      .map((x) => x.t.title);
    const roleHint = p.messageCount >= Math.max(20, stats.messageCount * 0.12)
      ? '主要发言人'
      : p.messageCount <= 3 ? '偶发参与' : '参与讨论';
    return {
      name: p.name,
      uin: p.uin,
      messageCount: p.messageCount,
      charCount: p.charCount,
      topicCount: topicLabels.length,
      topics: topicLabels,
      roleHint,
      points: quotes.length ? quotes : ['该时间段内发言较少，以简短回应为主']
    };
  });

  // ----------------------------------------------------------- conclusions
  const conclusionMsgs = messages.filter((m) => {
    if (m.kind !== 'text' || isFiller(m) || isQuestion(m)) return false;
    if (!INTENT.decision.test(m.text)) return false;
    if (m.text.length < 6) return false;
    if (/(等|还没|没有|未|待)定/.test(m.text)) return false;
    if (/^(按这个来|同意|可以|好的|收到|就这么办|没问题|那就这样)/.test(m.text)) return false;
    return true;
  });
  const conclusions = dedupeByText(conclusionMsgs, (m) => m.text, 0.55)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 8)
    .map((m) => ({ text: clip(m.text, 80), evidence: [evidenceOf(m, 80)] }));

  // ----------------------------------------------------------------- todos
  const ACTION = /(整理|统计|排|出|发|给|提交|更新|确认|准备|写|做|跟进|落实|推进|对接|安排|复盘|拆解|报名|评审)/;
  const FIRST_PERSON = /我[^，。]{0,8}(来|给|整理|做|接|负责|改|出|发|排|跟|写|确认|盯着|补|查|统计|安排|准备|提交|更新|落实|推进|对接|复盘|拆解)/;
  const todoMsgs = messages.filter((m) => {
    if (m.kind !== 'text' || isFiller(m) || isQuestion(m)) return false;
    if (m.text.length < 8) return false;
    if ((m.text.match(/；/g) || []).length >= 2 && (m.text.match(/、/g) || []).length >= 3) return false;
    if (!ACTION.test(m.text)) return false;
    if (INTENT.todo.test(m.text)) return true;
    if (FIRST_PERSON.test(m.text) && INTENT.due.test(m.text)) return true;
    return false;
  });
  const todos = dedupeByText(todoMsgs, (m) => m.text, 0.5).slice(0, 10).map((m) => {
    const mentions = extractMentionNames(m.text);
    const known = new Set(stats.perMember.map((p) => p.name));
    const ownerFromMention = mentions.find((n) => known.has(n));
    const selfCommit = FIRST_PERSON.test(m.text);
    const dueMatch = m.text.match(INTENT.due);
    const task = cleanText(m.text).replace(/^@\S+[\s，,]*/, '');
    return {
      owner: ownerFromMention || (selfCommit ? m.from : '待指派'),
      task: clip(task, 64),
      due: dueMatch ? dueMatch[0] : '未说明',
      evidence: [evidenceOf(m, 70)]
    };
  });

  // ----------------------------------------------------------------- risks
  const riskMsgs = messages.filter((m) => m.kind === 'text' && INTENT.risk.test(m.text) && !isFiller(m) && m.text.length >= 6);
  const risks = dedupeByText(riskMsgs, (m) => m.text, 0.5).slice(0, 8).map((m) => ({
    text: clip(m.text, 76),
    evidence: [evidenceOf(m, 76)]
  }));

  // --------------------------------------------------------------- overview
  const topMemberNames = stats.perMember.slice(0, 3).map((p) => `${p.name}（${p.messageCount} 条）`).join('、');
  const topTitles = topics.slice(0, 8).map((t) => `「${t.title}」`);
  const keyDecision = conclusions.length
    ? conclusions.slice().sort((a, b) => b.text.length - a.text.length)[0].text
    : '';
  const overviewParts = [
    `本次总结覆盖「${chatName}」${period} 的聊天记录：共 ${stats.messageCount} 条消息、${stats.memberCount} 位成员参与，其中媒体消息 ${stats.mediaCount} 条。`,
    topics.length
      ? `按讨论时段与词汇变化切分出 ${topics.length} 个话题（预算约 ${topicBudget(stats.messageCount)} 个），主要话题包括：${topTitles.join('')}${topics.length > 8 ? '等' : ''}。`
      : '讨论比较零散，未形成明显话题。',
    `共识别 ${conclusions.length} 项结论/决策、${todos.length} 项待办、${risks.length} 处风险提示。`,
    topMemberNames ? `最活跃的成员是 ${topMemberNames}。` : '',
    keyDecision ? `核心决策是「${clip(keyDecision, 44)}」。` : ''
  ].filter(Boolean);

  // ---------------------------------------------------------------- stats+
  const dayCount = new Map();
  for (const m of messages) {
    const d = `${m.t.getFullYear()}-${String(m.t.getMonth() + 1).padStart(2, '0')}-${String(m.t.getDate()).padStart(2, '0')}`;
    dayCount.set(d, (dayCount.get(d) || 0) + 1);
  }
  stats.byDay = [...dayCount.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));
  stats.timeRange = { start: stats.spanFrom, end: stats.spanTo };
  stats.participantCount = stats.memberCount;
  stats.topicCount = topics.length;
  const evIds = new Set();
  for (const bucket of [topics, conclusions, todos, risks]) {
    for (const item of bucket) {
      for (const e of item.evidence || []) if (e && e.msgId) evIds.add(String(e.msgId));
    }
  }
  stats.evidenceCount = evIds.size;

  return {
    overview: overviewParts.join(''),
    topics,
    members,
    conclusions,
    todos,
    risks,
    stats,
    engine: 'offline',
    limitations: [
      '离线引擎为抽取式摘要：句子取自原始消息，未改写润色。',
      `话题按发言时段与词汇变化切分（本轮 ${topics.length} 个，预算随消息量增长），同一时段若混聊多个主题可能合并为一个。`,
      '如需生成式摘要（改写、归纳、跨话题综合），请启用 LLM 引擎。'
    ]
  };
}
