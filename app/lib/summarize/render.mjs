// Markdown renderer for the structured summary. Same input always produces the
// same section order, so results stay comparable across runs and engines.
const pad = (n) => String(n).padStart(2, '0');

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function evidenceLines(ev = []) {
  return ev.map((e) => `  > ${e.sender}（${fmt(e.time)}，${e.msgId}）：${e.quote}`);
}

export function renderMarkdown({ summary, chat, params, meta = {} }) {
  const s = summary;
  const lines = [];
  lines.push('# 聊天记录 AI 总结');
  lines.push('');
  lines.push(`- 对象：${chat?.name || params.chatId}（${params.chatType === 'group' ? '群聊' : '好友'}）`);
  lines.push(`- 时间段：${params.fromLabel} 至 ${params.toLabel}`);
  lines.push(`- 数据量：${s.stats.messageCount} 条消息 / ${s.stats.memberCount} 位成员 / ${s.stats.charCount} 字符`);
  lines.push(`- 引擎：${s.engine === 'llm' ? `LLM（${meta.model || '已配置模型'}）` : '离线抽取式引擎（无需联网）'}`);
  lines.push(`- 生成时间：${fmt(meta.generatedAt || new Date().toISOString())}`);
  if (s.stats.spanFrom) lines.push(`- 实际覆盖：${fmt(s.stats.spanFrom)} 至 ${fmt(s.stats.spanTo)}`);
  lines.push('');
  lines.push('## 一、概述');
  lines.push('');
  lines.push(s.overview);
  lines.push('');

  lines.push('## 二、关键话题');
  lines.push('');
  if (!s.topics.length) {
    lines.push('_该时间段内没有识别出明显话题。_');
  } else {
    s.topics.forEach((t, i) => {
      lines.push(`### ${i + 1}. ${t.title}`);
      lines.push('');
      lines.push(t.summary);
      lines.push('');
      if (t.keywords?.length) lines.push(`关键词：${t.keywords.join('、')}　参与：${t.participants.map((p) => `${p.name}(${p.messageCount})`).join('、')}`);
      if (t.evidence?.length) {
        lines.push('');
        lines.push('证据：');
        lines.push(...evidenceLines(t.evidence));
      }
      lines.push('');
    });
  }

  lines.push('## 三、参与成员要点');
  lines.push('');
  if (!s.members.length) {
    lines.push('_无成员数据。_');
  } else {
    lines.push('| 成员 | 消息数 | 角色倾向 | 主要话题 | 代表发言 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const m of s.members) {
      const points = m.points.map((p) => p.replace(/\|/g, '\\|')).join('；');
      lines.push(`| ${m.name} | ${m.messageCount} | ${m.roleHint || '—'} | ${(m.topics || []).join('、') || '—'} | ${points} |`);
    }
  }
  lines.push('');

  lines.push('## 四、重要结论');
  lines.push('');
  if (!s.conclusions.length) {
    lines.push('_该时间段内没有识别出明确结论或决策。_');
  } else {
    s.conclusions.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.text}`);
      if (c.evidence?.length) lines.push(...evidenceLines(c.evidence));
    });
  }
  lines.push('');

  lines.push('## 五、待办事项');
  lines.push('');
  if (!s.todos.length) {
    lines.push('_未识别到明确待办。_');
  } else {
    lines.push('| # | 负责人 | 事项 | 时间要求 | 证据 |');
    lines.push('| --- | --- | --- | --- | --- |');
    s.todos.forEach((t, i) => {
      const ev = t.evidence?.[0];
      const evText = ev ? `${ev.msgId}` : '—';
      lines.push(`| ${i + 1} | ${t.owner} | ${t.task.replace(/\|/g, '\\|')} | ${t.due} | ${evText} |`);
    });
  }
  lines.push('');

  lines.push('## 六、风险提示');
  lines.push('');
  if (!s.risks.length) {
    lines.push('_未识别到明显风险。_');
  } else {
    s.risks.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.text}`);
      if (r.evidence?.length) lines.push(...evidenceLines(r.evidence));
    });
  }
  lines.push('');

  lines.push('## 七、数据统计');
  lines.push('');
  const kinds = Object.entries(s.stats.byKind || {}).map(([k, v]) => `${k}: ${v}`).join('，');
  lines.push(`- 消息总数：${s.stats.messageCount}`);
  lines.push(`- 参与成员：${s.stats.memberCount}`);
  lines.push(`- 媒体消息：${s.stats.mediaCount}（${kinds || '—'}）`);
  if (s.stats.byDay?.length) {
    lines.push(`- 每日消息量：${s.stats.byDay.map((d) => `${d.date} ${d.count}`).join('，')}`);
  }
  lines.push(`- 成员发言分布：${(s.stats.perMember || []).slice(0, 8).map((p) => `${p.name} ${p.messageCount}`).join('，')}`);
  lines.push(`- 证据引用：${s.stats.evidenceCount ?? '—'} 条（均可回溯到 msgId）`);
  lines.push('');
  lines.push('---');
  lines.push(`> 生成说明：${s.engine === 'llm' ? 'LLM 生成式摘要，结论基于所给消息片段。' : '离线抽取式摘要：句子取自原始消息，未改写。'}`);
  if (s.limitations?.length) {
    lines.push('>');
    for (const l of s.limitations) lines.push(`> - ${l}`);
  }
  lines.push('');
  return lines.join('\n');
}
