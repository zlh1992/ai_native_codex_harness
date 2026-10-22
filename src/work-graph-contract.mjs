import { invariant } from './errors.mjs';
import path from 'node:path';

export const GRAPH_LIMITS = Object.freeze({ nodes: 32, edges: 96, bytes: 256 * 1024 });
const RESERVED = new Set(['.git', '.codex', '.trash', '.home', '.tmp']);

export function graphText(value, name, max = 4000, optional = false) {
  invariant(typeof value === 'string' && value.trim().length <= max && (optional || value.trim().length > 0),
    400, 'INVALID_GRAPH_FIELD', `${name} 须为 ${optional ? 0 : 1}–${max} 字符。`);
  return value.trim();
}

export function graphRelativePath(value) {
  const raw = graphText(value, '成果路径', 500).replaceAll('\\', '/');
  invariant(!raw.startsWith('/') && !/^[a-z]:/i.test(raw) && !raw.includes('\0')
    && !raw.split('/').some((p) => p === '..' || RESERVED.has(p.normalize('NFKC').toLowerCase())),
  400, 'INVALID_GRAPH_PATH', '只允许项目内普通文件路径。');
  const normalized = raw.split('/').filter((p) => p && p !== '.').join('/');
  invariant(normalized, 400, 'INVALID_GRAPH_PATH', '成果路径不能为空。');
  return normalized;
}

export function reviewPolicy(value = {}) {
  const mode = value.mode || 'assisted';
  const finalMode = value.finalMode || mode;
  invariant(['manual', 'assisted', 'auto'].includes(mode) && ['manual', 'assisted', 'auto'].includes(finalMode),
    400, 'INVALID_REVIEW_POLICY', '审核模式无效。');
  const maxRework = value.maxRework ?? 3;
  const maxModelCalls = value.maxModelCalls ?? 100;
  invariant(Number.isInteger(maxRework) && maxRework >= 1 && maxRework <= 10
    && Number.isInteger(maxModelCalls) && maxModelCalls >= 1 && maxModelCalls <= 500,
  400, 'INVALID_REVIEW_BUDGET', '返工轮数须为 1–10，模型调用预算须为 1–500。');
  return { mode, finalMode, maxRework, maxModelCalls };
}

// Only the submission boundary accepts absolute paths. Generic file/tools stay relative-only.
export function deliveryRelativePath(value, root, canonicalRoot = root) {
  const raw = graphText(value, '交付路径', 2000).replaceAll('\\', '/');
  invariant(!raw.split('/').includes('..'), 400, 'INVALID_GRAPH_PATH', '交付路径不能包含上级目录。');
  if (!path.isAbsolute(raw)) return graphRelativePath(raw);
  const candidates = [root, canonicalRoot].map(base => path.relative(base, raw));
  const relative = candidates.find(p => p && p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p));
  invariant(relative, 400, 'INVALID_GRAPH_PATH', '只允许当前任务工作区内的文件。');
  return graphRelativePath(relative);
}

export function nodeReviewMode(node, policy) {
  return node.reviewMode || (node.completionGate ? policy.finalMode : policy.mode);
}

export function validateGraph(input, { candidateIds = null, employeeFor = null } = {}) {
  invariant(input && typeof input === 'object' && !Array.isArray(input)
    && Buffer.byteLength(JSON.stringify(input)) <= GRAPH_LIMITS.bytes,
  400, 'INVALID_GRAPH', '计划格式无效或超过大小限制。');
  invariant(input.schemaVersion === 1, 400, 'GRAPH_SCHEMA_VERSION', '只支持 Work Graph schemaVersion=1。');
  const title = graphText(input.title, '计划标题', 160);
  invariant(Array.isArray(input.nodes) && input.nodes.length >= 1 && input.nodes.length <= GRAPH_LIMITS.nodes,
    400, 'GRAPH_NODE_LIMIT', '计划必须包含 1–32 个任务节点。');
  const nodes = input.nodes.map((node) => {
    invariant(node && typeof node === 'object' && !Array.isArray(node), 400, 'INVALID_GRAPH_NODE', '任务节点格式无效。');
    const key = graphText(node.key, '节点标识', 60);
    invariant(/^[a-zA-Z0-9_-]+$/.test(key), 400, 'INVALID_NODE_KEY', '节点标识只允许字母、数字、下划线和连字符。');
    const assigneeUserId = graphText(node.assigneeUserId, '员工标识', 80);
    const employee = employeeFor?.(assigneeUserId);
    invariant((!candidateIds || candidateIds.includes(assigneeUserId))
      && (!employeeFor || (employee?.role === 'user' && employee.status === 'active')),
    400, 'INVALID_ASSIGNEE', '任务员工不在授权候选范围内或已停用。');
    invariant(Array.isArray(node.dependsOn) && node.dependsOn.every((k) => typeof k === 'string')
      && new Set(node.dependsOn).size === node.dependsOn.length,
    400, 'INVALID_DEPENDENCIES', '依赖必须为不重复的节点标识列表。');
    invariant(Array.isArray(node.checklist) && node.checklist.length >= 1 && node.checklist.length <= 30,
      400, 'INVALID_CHECKLIST', '任务清单须包含 1–30 项。');
    const checklist = node.checklist.map((item, index) => ({ id: `item-${index + 1}`,
      text: graphText(typeof item === 'string' ? item : item?.text, '清单项', 1000), done: false }));
    invariant(Array.isArray(node.outputs) && node.outputs.length <= 30,
      400, 'INVALID_OUTPUTS', '成果须为最多 30 个相对文件路径；人工说明任务可为空。');
    const outputs = node.outputs.map(graphRelativePath);
    invariant(node.reviewMode == null || ['manual', 'auto', 'assisted'].includes(node.reviewMode),
      400, 'INVALID_REVIEW_POLICY', '节点审核方式无效。');
    invariant(new Set(outputs).size === outputs.length, 400, 'INVALID_OUTPUTS', '成果路径不能重复。');
    let dueAt = null;
    if (node.dueAt) {
      invariant(typeof node.dueAt === 'string' && Number.isFinite(Date.parse(node.dueAt)), 400, 'INVALID_DUE_DATE', '截止日期无效。');
      dueAt = new Date(node.dueAt).toISOString();
    }
    const inputAttachmentIds = node.inputAttachmentIds || [];
    invariant(Array.isArray(inputAttachmentIds) && inputAttachmentIds.length <= 30 && new Set(inputAttachmentIds).size === inputAttachmentIds.length && inputAttachmentIds.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)), 400, 'INVALID_MATERIALS', '输入资料引用无效。');
    return { key, assigneeUserId, inputAttachmentIds, title: graphText(node.title, '任务标题', 160),
      acceptance: graphText(node.acceptance, '验收标准'), dependsOn: [...node.dependsOn], checklist, outputs,
      dueAt, completionGate: node.completionGate === true,
      ...(node.reviewMode ? { reviewMode: node.reviewMode } : {}),
      requiresIndependentValidation: node.requiresIndependentValidation === true };
  });
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  invariant(byKey.size === nodes.length, 400, 'DUPLICATE_NODE', '节点标识不能重复。');
  invariant(nodes.reduce((n, node) => n + node.dependsOn.length, 0) <= GRAPH_LIMITS.edges,
    400, 'GRAPH_EDGE_LIMIT', '图最多支持 96 条依赖。');
  for (const node of nodes) invariant(node.dependsOn.every((key) => byKey.has(key) && key !== node.key),
    400, 'INVALID_DEPENDENCIES', '依赖不存在或节点依赖自身。');
  const ordered = [];
  const remaining = new Set(byKey.keys());
  while (remaining.size) {
    const ready = nodes.filter((n) => remaining.has(n.key) && n.dependsOn.every((k) => !remaining.has(k)));
    invariant(ready.length, 400, 'GRAPH_CYCLE', '计划包含循环依赖。');
    for (const node of ready) { ordered.push(node); remaining.delete(node.key); }
  }
  const parents = new Set(nodes.flatMap((node) => node.dependsOn));
  const sinks = nodes.filter((node) => !parents.has(node.key));
  invariant(sinks.length === 1 && sinks[0].completionGate && nodes.filter((n) => n.completionGate).length === 1,
    400, 'COMPLETION_GATE_REQUIRED', '计划须有一个最终交付节点，全部任务汇合至该节点。');
  return { schemaVersion: 1, title, nodes: ordered,
    assumptions: graphText(input.assumptions || '', '计划假设', 4000, true) };
}

export function validateProfile(input) {
  invariant(input && typeof input === 'object', 400, 'INVALID_PROFILE', '员工资料格式无效。');
  const tags = input.skills || [];
  invariant(Array.isArray(tags) && tags.length <= 30, 400, 'INVALID_PROFILE', '能力标签最多 30 个。');
  const availability = input.availability || 'available';
  invariant(['available', 'limited', 'unavailable'].includes(availability), 400, 'INVALID_PROFILE', '可用性无效。');
  return {
    jobTitle: graphText(input.jobTitle || '', '岗位', 120, true),
    responsibilities: graphText(input.responsibilities || '', '职责', 4000, true),
    skills: [...new Set(tags.map((s) => graphText(s, '能力标签', 80)))],
    deliveryPreference: graphText(input.deliveryPreference || '', '交付偏好', 1000, true),
    availability,
    notes: graphText(input.notes || '', '能力说明', 4000, true),
  };
}
