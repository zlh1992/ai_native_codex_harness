import { ROOT_MODELS, rootModel, validateModel } from './models.mjs';

export function parseWechatCommand(text) {
  const value = String(text || '').trim();
  if (/^\/new$/iu.test(value)) return { type: 'new' };
  if (/^\/models$/iu.test(value)) return { type: 'models' };
  const match = value.match(/^\/model(?:\s+(.+?))?$/iu);
  if (match) return { type: 'model', value: match[1]?.trim() || null };
  return null;
}

export function formatWechatModelCatalog({ config, chat, user }) {
  const current = rootModel(config, chat, user);
  const lines = ROOT_MODELS.map(({ id, label }) => `- ${id}（${label}）`);
  return `Portal 当前模型（${current}）：\n${lines.join('\n')}\n\n使用 /model <模型 ID> 切换，使用 /model default 恢复默认模型。`;
}

export function resolveWechatModel(value) {
  if (value === null || /^default$/iu.test(value)) return null;
  return validateModel(value);
}
