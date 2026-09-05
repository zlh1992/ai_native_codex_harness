import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const boss = fs.readFileSync(new URL('../public/boss.js', import.meta.url), 'utf8');

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

test('boss metrics describe multi-employee worktrees and the Portal root-turn limit', () => {
  assert.ok(boss.includes('每名员工一个独立 worktree'));
  assert.ok(boss.includes('codex.maxRootTurns || 11'));
  assert.equal(boss.includes('项目终身固定首位员工'), false);
  assert.ok(boss.includes("result.restored ? '已恢复该员工原有 worktree 与授权。'"));
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

test('turn recovery paginates the durable journal instead of skipping to its latest cursor', () => {
  assert.ok(app.includes('do {\n    data = await api(`/api/chats/${entry.chatId}/events?after=${cursor}&limit=5000`)'));
  assert.ok(app.includes('cursor = Math.max(cursor, Number(event.id || 0));'));
  assert.ok(app.includes('} while (cursor < latestEventId);'));
  assert.ok(app.includes("event.eventType === 'tool_started'"));
  assert.ok(app.includes("event.eventType === 'approval_required'"));
  assert.ok(app.includes("request.files.join('\\n')"));
  assert.ok(app.includes("if (['queued', 'starting', 'running'].includes(data.latestTurnRun?.status)) await resumePersistedTurn(data);"));
});
