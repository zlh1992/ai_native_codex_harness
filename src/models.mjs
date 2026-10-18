import { invariant } from './errors.mjs';

// Portal-approved root models mirror the visible models in the current desktop Codex catalog.
export const ROOT_MODELS = Object.freeze([
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
]);

export function validateModel(model) {
  invariant(model === null || ROOT_MODELS.some((entry) => entry.id === model), 400, 'INVALID_MODEL', '请选择支持的模型。');
  return model;
}

export function rootModel(config, chat, user) {
  // Retired preferences stay stored for history, but run with the current
  // configured default. New API selections still pass through validateModel.
  return chat?.preferredModel && ROOT_MODELS.some((entry) => entry.id === chat.preferredModel)
    ? chat.preferredModel : config.codexModel;
}

export const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
export function defaultEffort(config, user) {
  return user.role === 'user' ? 'medium' : config.codexReasoningEffort || 'high';
}
export function validateEffort(value) {
  invariant(value === null || EFFORTS.has(value), 400, 'INVALID_EFFORT', '请选择支持的推理强度。');
  return value;
}
export function rootEffort(config, chat, user, explicit) {
  if (explicit !== undefined && explicit !== null) return validateEffort(explicit);
  return validateEffort(chat?.preferredEffort ?? defaultEffort(config, user));
}
