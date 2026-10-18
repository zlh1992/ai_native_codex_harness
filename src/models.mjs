import { invariant } from './errors.mjs';

// Deployment-approved root models, shared by boss, employees and channel commands.
export const ROOT_MODELS = Object.freeze([
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
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
    ? chat.preferredModel : validateModel(config.codexModel);
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
