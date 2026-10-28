// Orchestrates one summarize run and guarantees the output contract:
//   { summary: {overview, topics[], members[], conclusions[], todos[], risks[], stats},
//     markdown, meta }
import { summarizeOffline } from './offline.mjs';
import { summarizeWithLLM } from './llm.mjs';
import { renderMarkdown } from './render.mjs';
import { resolveApiKey } from '../config.mjs';

export async function runSummary({ chat, messages, params, settings, onProgress = () => {} }) {
  const engineWanted = settings?.engine === 'llm' ? 'llm' : 'offline';
  const apiKey = resolveApiKey(settings);
  let summary;
  let engineUsed = 'offline';
  const warnings = [];

  if (engineWanted === 'llm') {
    if (!apiKey) {
      warnings.push('未检测到 LLM API Key（环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY），已回退到离线引擎。');
    } else {
      try {
        onProgress('llm', 5, `调用 LLM：${settings.llm.model}`);
        summary = await summarizeWithLLM({
          messages,
          chat,
          params,
          llm: { baseUrl: settings.llm.baseUrl, model: settings.llm.model, apiKey },
          onProgress: (phase, pct, msg) => onProgress(phase, pct, msg)
        });
        engineUsed = 'llm';
      } catch (err) {
        warnings.push(`LLM 调用失败，已回退到离线引擎：${err.message}`);
      }
    }
  }

  if (!summary) {
    onProgress('offline', 30, '离线引擎：抽取话题、结论与待办');
    summary = summarizeOffline({ chat, messages, params });
    engineUsed = 'offline';
  }

  if (warnings.length) summary.limitations = [...(summary.limitations || []), ...warnings];

  const meta = {
    engine: engineUsed,
    model: engineUsed === 'llm' ? settings.llm.model : null,
    generatedAt: new Date().toISOString(),
    version: '0.6.0',
    chat: { id: chat?.id, name: chat?.name, type: params.chatType },
    from: params.from,
    to: params.to,
    fromLabel: params.fromLabel,
    toLabel: params.toLabel,
    range: { from: params.from, to: params.to },
    warnings
  };
  onProgress('render', 95, '渲染 Markdown');
  const markdown = renderMarkdown({ summary, chat, params, meta });
  return { summary, markdown, meta };
}
