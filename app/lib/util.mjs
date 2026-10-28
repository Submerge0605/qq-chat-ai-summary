// Shared helpers: time parsing, Chinese-ish tokenization, text scoring.
// Zero dependencies so the app runs offline on plain Node.

export const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const LATIN_WORD = /[A-Za-z][A-Za-z0-9_+.#/-]{1,20}/g;

export function parseTimeAny(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const d = new Date(n > 1e12 ? n : n * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  // "2026-10-23 11:09[:ss]" / "2026/10/23 11:09" / datetime-local
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
    const hh = Number(m[4] || 0), mi = Number(m[5] || 0), ss = Number(m[6] || 0);
    // Strict calendar validation: Date() silently rolls 02-30 over to 03-02,
    // which would make an invalid input look like a valid one.
    if (mo < 1 || mo > 12 || day < 1 || day > 31 || hh > 23 || mi > 59 || ss > 59) return null;
    const d = new Date(y, mo - 1, day, hh, mi, ss);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
    return d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function dayLabel(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function weekdayLabel(d) {
  return '周' + '日一二三四五六'[d.getDay()];
}

// ---------------------------------------------------------------- tokenizer

const STOP_TERMS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什么', '因为', '所以', '但是', '然后',
  '现在', '可以', '应该', '需要', '没有', '一个', '一下', '有点', '真的', '就是', '还是', '已经',
  '还有', '不过', '而且', '如果', '的话', '时候', '这样', '那样', '这里', '那里', '自己', '大家',
  '感觉', '觉得', '知道', '看到', '辛苦', '谢谢', '哈哈', '哈哈哈', '好的', '收到', '嗯嗯', '在吗',
  '今天', '明天', '后天', '昨天', '上午', '下午', '晚上', '中午', '早上', '最近', '之前', '之后',
  '第一', '第二', '第三', '不会', '不能', '不是', '不要', '不用', '可能', '一般', '比较', '非常',
  '特别', '其实', '主要', '直接', '马上', '赶紧', '顺便', '关于', '对于', '通过', '进行', '一些',
  '所有', '每个', '其他', '另外', '以及', '或者', '并且', '虽然', '当然', '确实', '肯定', '好像',
  '估计', '差不多', '有点点', '一下下', '好的吧', '行吧', '好吧', '没问题', '辛苦了', '麻烦了',
  '这边', '那边', '这块', '那块', '刚才', '刚看到', '晚点', '早点', '先这样', '就这样', '按这个来',
  '收到啦', '明白啦', '我看一下', '看一下', '问一下', '说一下', '讲一下', '来一下', '一起', '各位',
  '咱们', '人家', '怎么办', '怎么样', '什么样', '一句话', '一件', '两个', '三个', '几次', '时间上'
]);

const STOP_HEAD = new Set('的了是我你他她它就都也在这那不和与有个要会能被把让给上下啊吧呢吗哦嗯呀哈啦嘛呗去来到对从向再又还只才更最很太挺没'.split(''));
const STOP_TAIL = new Set('的了是我你他她它就都也在这那不和与有个要会能被把让给上下啊吧呢吗哦嗯呀哈啦嘛呗去来到对从向再又还只才更最很太挺没'.split(''));

export const DOMAIN_LEXICON = [
  '上线', '提测', '灰度', '回滚', '压测', '联调', '接口', '排期', '工期', '需求', '评审', '方案',
  '预算', '超支', '成本', '报价', '合同', '报销', '推广', '拉新', '投放', '转化', '留存', '活动',
  '奖品', '文案', '设计稿', '视觉', '交互', '用例', '回归', '冒烟', '缺陷', '故障', '报警', '日志',
  '服务', '服务器', '数据库', '部署', '版本', '发布', '客户', '投诉', '客服', '团建', '聚餐',
  '加班', '调休', '招聘', '面试', '外包', '转正', '绩效', '晋升', '方案', '风险', '延期', '里程碑'
];

const LEXICON_SET = new Set(DOMAIN_LEXICON);

export function cjkTerms(text) {
  const out = [];
  const t = String(text || '');
  const runs = t.match(CJK_RUN) || [];
  for (const run of runs) {
    if (run.length < 2) continue;
    // latin/number words embedded inside are ignored here
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const term = run.slice(i, i + n);
        if (STOP_TERMS.has(term)) continue;
        if (n === 2 && STOP_HEAD.has(term[0]) && STOP_TAIL.has(term[1])) continue;
        if (n > 2 && (STOP_HEAD.has(term[0]) || STOP_TAIL.has(term[term.length - 1]))) continue;
        out.push(term);
      }
    }
  }
  return out;
}

export function latinTerms(text) {
  return (String(text || '').match(LATIN_WORD) || [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));
}

/**
 * Score terms across a set of messages. Returns [{term, score, count, msgs:[idx]}]
 * Longer terms and lexicon hits are boosted; terms that are substrings of a
 * higher-scoring term with similar support are pruned.
 */
export function rankTerms(messages, { minCount = 2, limit = 40 } = {}) {
  const stats = new Map();
  messages.forEach((m, idx) => {
    const seen = new Set();
    for (const term of [...cjkTerms(m.text), ...latinTerms(m.text)]) {
      if (seen.has(term)) continue;
      seen.add(term);
      let s = stats.get(term);
      if (!s) {
        s = { term, count: 0, msgs: [] };
        stats.set(term, s);
      }
      s.count += 1;
      s.msgs.push(idx);
    }
  });
  const list = [];
  for (const s of stats.values()) {
    if (s.count < minCount) continue;
    const lenBoost = 1 + (s.term.length - 2) * 0.35;
    const lexBoost = LEXICON_SET.has(s.term) ? 1.6 : 1;
    s.score = s.count * lenBoost * lexBoost;
    list.push(s);
  }
  list.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const cand of list) {
    const shadowed = kept.some((k) =>
      (k.term.includes(cand.term) || cand.term.includes(k.term)) &&
      Math.abs(k.count - cand.count) <= Math.max(1, Math.round(k.count * 0.35)));
    if (!shadowed) kept.push(cand);
    if (kept.length >= limit) break;
  }
  return kept.map((k) => ({ ...k, msgs: [...new Set(k.msgs)] }));
}

// ------------------------------------------------------------- regex intents

export const INTENT = {
  decision: /(决定|定了|确定下来|确定|敲定|结论|最终|统一|同意|通过|拍板|就这么|按.{0,6}(执行|来)|采纳|不含糊|明确了)/,
  todo: /(记得|别忘了|需要你|你来|负责|安排给|跟进|落实|推进|准备一下|整理|统计|更新一下|提交|发我|给出|搞定|落实一下|务必)/,
  due: /(今天|今晚|明天|明早|后天|本周|这周|下周|周一|周二|周三|周四|周五|周六|周日|\d{1,2}\s*[月/]\s*\d{1,2}|\d{1,2}号|月底|月初|之前|截止|下班前|中午前)/,
  risk: /(风险|担心|来不及|卡住|阻塞|超支|投诉|隐患|延期|人手不够|不太稳|崩了|挂掉|问题在于|质量.{0,2}(风险|问题)|节奏.{0,2}紧|来不及)/,
  question: /[?？]$|(怎么办|怎么弄|能不能|可不可以|要不要|是不是)/
};

export function extractMentionNames(text) {
  const names = [];
  for (const m of String(text || '').matchAll(/@([^\s@,，。.!！?？、:：]{1,12})/g)) {
    names.push(m[1]);
  }
  return names;
}

export function cleanText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]{1,12}\]/g, '')   // [图片] [表情] 之类占位
    .trim();
}

export function clip(text, max = 90) {
  const t = cleanText(text);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
