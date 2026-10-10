import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { graphLayout, WorkGraphUI } from '../public/work-graph.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const boss = fs.readFileSync(new URL('../public/boss.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const workGraph = fs.readFileSync(new URL('../public/work-graph.js', import.meta.url), 'utf8');

test('delivery drawer exposes multi-upload, confined paths, immutable thumbnails and two node modes', () => {
  assert.match(workGraph, /id="graph-upload-input" type="file" multiple/);
  assert.ok(workGraph.includes('zone.ondrop'));
  assert.ok(workGraph.includes('crypto.subtle.digest'));
  assert.ok(workGraph.includes('工作区文件路径（每行一个）'));
  assert.ok(workGraph.includes('name="nodeReviewMode"'));
  assert.ok(workGraph.includes('value="manual">老板人工审核'));
  assert.ok(workGraph.includes('AI 自动审核 · 推进 / 打回'));
  assert.ok(workGraph.includes('老板审核 · AI 提供意见'));
  assert.ok(workGraph.includes('&preview=1'));
  assert.ok(workGraph.includes('r.detail.coverage'));
  assert.ok(workGraph.includes('确认提交结果（重试）'));
  assert.ok(styles.includes('.graph-attachment img'));
});

test('selected uploads can fulfill a required file rather than always creating unrelated attachments', () => {
  const ui = new WorkGraphUI({ toast: () => assert.fail('unexpected upload rejection') });
  ui.detail = { uploads: [], node: { task: { id: 'task' }, version: 1, requiredOutputs: ['reports/result.pdf'] } };
  ui.renderUploads = () => {};
  ui.addUploads([new File(['document'], 'result.pdf'), new File(['notes'], 'notes.txt')]);
  assert.equal(ui.detail.uploads[0].path, 'reports/result.pdf');
  assert.match(ui.detail.uploads[1].path, /^deliveries\/task\/v1\//);
  assert.equal(ui.detail.uploads[0].owned, false);
  ui.detail.submissionBody = { idempotencyKey: 'uncertain' };
  ui.addUploads([new File(['later'], 'later.txt')]);
  assert.equal(ui.detail.uploads.length, 2);
});

function frontendFunction(name) {
  const match = app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `missing frontend function ${name}`);
  return Function(`${match[0]}; return ${name};`)();
}

test('authenticated workbench load failures do not masquerade as login failures', () => {
  assert.ok(app.includes('error.status = response.status'));
  assert.ok(app.includes("if (error.status === 401) return;"));
  assert.ok(app.includes('工作台加载失败：${error.message}'));
  assert.ok(!app.includes('} catch { showLogin(); }'));
});

test('file upload uses an in-app dialog and stays distinct from download', () => {
  assert.ok(html.includes('id="upload-dialog"'));
  assert.ok(html.includes('id="upload-destination"'));
  assert.ok(html.includes('↑ 上传'));
  assert.ok(html.includes('↓ 下载'));
  assert.ok(app.includes("event.target.value = '';"));
  assert.ok(app.includes('state.pendingUpload = { file, projectId: state.selectedProject.id };'));
  assert.ok(app.includes('项目中已有同名文件；如需替换，请勾选允许覆盖。'));
  assert.ok(app.includes('await openFile(destination);'));
  assert.ok(!app.includes("window.prompt('上传到项目路径'"));
});

test('new chat, file, and folder use an accessible in-app dialog instead of window.prompt', () => {
  assert.ok(html.includes('id="text-dialog"'));
  assert.ok(html.includes('id="text-dialog-input"'));
  assert.ok(app.includes("openTextDialog({"));
  assert.equal(app.includes('window.prompt('), false);
});

test('phone workbench gives projects and chats independent scroll areas with large tap targets', () => {
  assert.match(styles, /@media\(max-width:720px\)\{[\s\S]*?\.project-rail\{min-height:0;max-height:none;overflow:visible/);
  assert.ok(styles.includes('.project-list,.chat-list{flex:none;min-height:156px;overflow-y:auto'));
  assert.ok(styles.includes('.chat-list{min-height:192px;max-height:min(40vh,360px)}'));
  assert.ok(styles.includes('.project-item,.chat-item{min-height:64px;'));
  assert.ok(styles.includes('.square-button{width:48px;height:48px;'));
});

test('HTML artifacts open as a sandboxed rendered preview while retaining source mode', () => {
  assert.ok(app.includes("const HTML_PREVIEW_EXTENSIONS = new Set(['.html', '.htm']);"));
  assert.ok(app.includes('if (HTML_PREVIEW_EXTENSIONS.has(extension))'));
  assert.ok(app.includes("frame.className = 'preview-html';"));
  assert.ok(app.includes("frame.setAttribute('sandbox', 'allow-scripts');"));
  assert.equal(app.includes("frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');"), false);
  assert.ok(app.includes('state.viewerMode = SOURCE_FIRST_EXTENSIONS.has(extension) ? \'source\' : \'preview\';'));
  assert.ok(html.includes('id="source-tab"'));
});

test('turn mode is stored per chat and defaults to project-local EXECUTE access', () => {
  assert.ok(html.indexOf('<option value="execute">') < html.indexOf('<option value="edit">'));
  assert.ok(html.includes('EXECUTE · 文件＋命令'));
  assert.ok(app.includes("data.chat.preferredMode || 'execute'"));
  assert.ok(app.includes("body: { preferredMode }"));
});

test('boss metrics describe multi-employee worktrees and the Portal root-turn limit', () => {
  assert.ok(boss.includes('每名员工一个独立 worktree'));
  assert.ok(boss.includes('codex.maxRootTurns || 11'));
  assert.equal(boss.includes('项目终身固定首位员工'), false);
  assert.ok(boss.includes("result.restored ? '已恢复该员工原有 worktree、对话与授权。'"));
});

test('destructive and context-reset actions use in-app confirmations', () => {
  const bossHtml = fs.readFileSync(new URL('../public/boss.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="confirm-dialog"'));
  assert.ok(bossHtml.includes('id="confirm-dialog"'));
  assert.equal(app.includes('window.confirm('), false);
  assert.equal(boss.includes('confirm('), false);
  assert.ok(app.includes('pendingConfirmAction'));
  assert.ok(boss.includes('pendingRevoke'));
  assert.ok(app.includes("event.submitter || $('#confirm-dialog-submit')"));
  assert.ok(boss.includes("event.submitter || $('#confirm-dialog-submit')"));
});

test('per-user memory UI exposes chat controls, multiline editing, references, and share confirmation', () => {
  assert.ok(html.includes('data-view="memories"'));
  assert.ok(html.includes('id="memory-create-form"'));
  assert.ok(html.includes('id="use-memory"'));
  assert.ok(html.includes('id="save-memory"'));
  assert.ok(html.includes('id="memory-ref-panel"'));
  assert.ok(html.includes('id="text-dialog-textarea"'));
  assert.ok(app.includes("multiline: true"));
  assert.ok(app.includes('/memory-references') || app.includes('/memory`'));
  assert.ok(boss.includes('MEMORY_SHARE_CONFIRMATION_REQUIRED'));
  assert.ok(boss.includes('pendingMemoryShare'));
  assert.ok(boss.includes('memoryConfirmationToken'));
});

test('private chat UI labels the local engine and keeps approvals and project memory explicit', () => {
  assert.match(html, /id="project-type-label"[^>]*>[\s\S]*?<select name="projectType">/);
  assert.ok(html.includes('id="memory-scope"'));
  assert.ok(html.includes('id="local-control"'));
  assert.ok(app.includes('data-search-query'));
  assert.ok(app.includes('QWEN · LOCAL'));
  const apply = frontendFunction('applyJournalEvent');
  const entry = { engineLabel: '本地 Qwen', mode: 'edit', events: [] };
  apply(entry, { eventType: 'turn_status', payload: { status: 'running' } });
  assert.equal(entry.statusText, '本地 Qwen 正在执行 · EDIT');
  apply(entry, { eventType: 'approval_resolved' });
  assert.equal(entry.statusText, '本地 Qwen 继续执行…');
  apply(entry, { eventType: 'turn_completed' });
  assert.equal(entry.statusText, '本地 Qwen 已完成');
});

test('work graph keeps long task titles readable and distinguishes its three projections', () => {
  assert.ok(styles.includes('.graph-canvas .graph-node{position:absolute;height:176px;min-height:0;overflow-y:auto'));
  assert.ok(styles.includes('.graph-node-title{font-size:15px;line-height:1.45'));
  assert.ok(styles.includes('.graph-list{display:grid;'));
  assert.ok(styles.includes('max-height:min(68vh,720px);overflow-y:auto'));
  assert.equal(styles.includes('-webkit-line-clamp'), false);
  assert.ok(workGraph.includes('依赖图：按前后置关系排列任务'));
  assert.ok(workGraph.includes("button.setAttribute('aria-pressed', String(active))"));
  assert.ok(workGraph.includes("button.disabled = this.mode !== 'graph'"));

  const layout = graphLayout([
    { key: 'first', dependsOn: [] },
    { key: 'second', dependsOn: [] },
  ]);
  assert.ok(layout.positions.get('second').y - layout.positions.get('first').y >= 176);
});

test('turn recovery paginates the durable journal instead of skipping to its latest cursor', () => {
  assert.ok(app.includes('do {\n    data = await api(`/api/chats/${entry.chatId}/events?after=${cursor}&limit=5000`)'));
  assert.ok(app.includes('cursor = Math.max(cursor, Number(event.id || 0));'));
  assert.ok(app.includes('} while (cursor < latestEventId);'));
  assert.ok(app.includes("event.eventType === 'tool_started'"));
  assert.ok(app.includes("event.eventType === 'approval_required'"));
  assert.ok(app.includes("request.files.join('\\n')"));
  assert.ok(app.includes("if (['queued', 'starting', 'running'].includes(data.latestTurnRun?.status)) await resumePersistedTurn(data);"));
});

test('running turn recovery never synthesizes an empty user message', () => {
  const shouldAppendLivePrompt = frontendFunction('shouldAppendLivePrompt');
  const existing = [{ role: 'user', content: 'keep the visible prompt' }];

  assert.equal(shouldAppendLivePrompt(existing, { prompt: '' }), false);
  assert.equal(shouldAppendLivePrompt(existing, { prompt: '   ' }), false);
  assert.equal(shouldAppendLivePrompt(existing, { prompt: 'keep the visible prompt' }), false);
  assert.equal(shouldAppendLivePrompt(existing, { prompt: 'append this missing prompt' }), true);
  assert.ok(app.includes('renderLiveTurn(running, shouldAppendLivePrompt(data.messages, running))'));
});

test('model selector restores each chat and prevents edits while saving or without a chat', () => {
  const source = app.match(/function updateModelSelect\([^)]*\) \{[\s\S]*?\n\}/)[0];
  const select = { classList: { toggle() {} } };
  const state = { selectedChat: null, inputQueues: new Map() };
  const other = { classList: { toggle() {} }, closest() { return this; } };
  const update = Function('state', '$', 'selectedChatRunning', 'updateConcurrencyIndicator', `${source}; return updateModelSelect;`)(state,
    selector => selector === '#model-select' ? select : other, () => false, () => {});
  update(); assert.equal(select.disabled, true); assert.equal(select.value, '');
  state.selectedChat = { id: 'chat', preferredModel: 'gpt-6-astra', preferredEffort: 'max' };
  update(); assert.equal(select.disabled, false); assert.equal(select.value, 'gpt-6-astra');
  assert.equal(other.value, 'max');
  state.inputQueues.set('chat', [{}]); update(); assert.equal(select.disabled, true); assert.equal(other.disabled, true);
  state.inputQueues.clear();
  state.selectedChat = { preferredModel: 'gpt-5.6-terra' };
  update(); assert.equal(select.value, 'gpt-5.6-terra');
  state.modelSaving = true;
  update(); assert.equal(select.disabled, true);
  state.modelSaving = false; state.selectedChat = { preferredModel: null };
  update(); assert.equal(select.value, '');
  assert.match(html, /id="model-select"[^>]+aria-label="对话模型"/);
});

test('running chats keep the composer enabled and show editable, escaped queued messages', () => {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { disabled: true, textContent: '', placeholder: '',
      classList: { toggle() {} }, setAttribute() {} });
    return elements.get(selector);
  };
  const source = app.match(/function setComposer\([^)]*\) \{[\s\S]*?\n\}/)[0];
  const selected = { id: 'chat', title: 'Running', status: 'running', threadState: 'ready' };
  const state = { selectedChat: selected, selectedProject: { name: 'Project' }, selectedTask: null, queueSending: false };
  const setComposer = Function('state', '$', 'selectedChatRunning', 'renderInputQueue', 'updateModelSelect', 'taskConversationState', 'renderTaskNotice',
    `${source}; return setComposer;`)(state, element, () => true, () => {}, () => {}, () => ({ canWork: true }), () => {});
  setComposer(true);
  assert.equal(element('#prompt-input').disabled, false);
  assert.equal(element('#send-button').disabled, false);
  assert.match(element('#prompt-input').placeholder, /排队/);
  selected.threadState = 'resume_failed'; setComposer(true);
  assert.equal(element('#send-button').disabled, true);
});

test('queue submit retains the draft and reuses its ID if the HTTP acknowledgement is lost', async () => {
  const source = app.match(/async function submitQueuedInput\([^)]*\) \{[\s\S]*?\n\}/)[0];
  const state = { selectedChat: { id: 'chat' }, pendingInput: null, queueSending: false };
  const prompt = { value: 'draft survives network loss', style: {} };
  const requests = [];
  let attempt = 0;
  const submit = Function('state', '$', 'crypto', 'api', 'setComposer', 'refreshInputQueue', 'toast',
    `${source}; return submitQueuedInput;`)(state,
    (selector) => selector === '#prompt-input' ? prompt : { value: selector === '#mode-select' ? 'edit' : 'low' },
    { randomUUID: () => 'stable-browser-message-id' }, async (url, request) => {
      requests.push(request.body);
      if (++attempt === 1) throw new Error('connection lost');
      return { input: { status: 'sent' } };
    }, () => {}, async () => {}, () => {});
  await assert.rejects(submit(), /connection lost/);
  assert.equal(prompt.value, 'draft survives network loss');
  assert.equal(state.queueSending, false);
  await submit();
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(prompt.value, '');
});
