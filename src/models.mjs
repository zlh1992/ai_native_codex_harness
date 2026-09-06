import { invariant } from './errors.mjs';

// Portal-approved root models; upstream account availability is checked by Codex.
export const ROOT_MODELS = Object.freeze([
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
]);

export function validateModel(model) {
  invariant(model === null || ROOT_MODELS.some((entry) => entry.id === model), 400, 'INVALID_MODEL', '请选择支持的模型。');
  return model;
}

export function rootModel(config, chat, user) {
  return user.role === 'admin' && chat?.preferredModel
    ? validateModel(chat.preferredModel) : config.codexModel;
}
