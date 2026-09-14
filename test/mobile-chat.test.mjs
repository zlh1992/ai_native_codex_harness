import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/portal-ui.css', import.meta.url), 'utf8');
const mobile = css.slice(css.indexOf('/* Shared boss/employee mobile chat:'));

test('mobile chat reserves readable history and a multiline, touch-friendly composer', () => {
  assert.match(mobile, /@media\(max-width:820px\)/);
  assert.match(mobile, /\.chat-stage\{[^}]*height:auto;min-height:100svh;overflow:visible/);
  assert.match(mobile, /\.message-list\{[^}]*height:65svh;min-height:360px;overflow:auto/);
  assert.match(mobile, /\.message-body\{font-size:16px;line-height:1.75/);
  assert.match(mobile, /textarea\{[^}]*min-height:96px;max-height:180px;font-size:16px/);
  assert.match(mobile, /\.send-button\{width:48px;height:48px/);
  assert.match(mobile, /env\(safe-area-inset-bottom\)/);
});

test('mobile auxiliary panels scroll without hiding approvals, files or project selectors', () => {
  assert.match(mobile, /\.turn-insights\{max-height:180px/);
  assert.match(mobile, /\.input-queue,\.chat-stage \.task-flow-notice\{max-height:160px;overflow:auto/);
  assert.doesNotMatch(mobile, /position:fixed/);
  assert.match(css, /\.files-panel\{display:grid;position:static/);
});
