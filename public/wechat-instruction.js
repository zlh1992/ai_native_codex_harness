import { loginPage } from './navigation.js';

const id = new URLSearchParams(location.search).get('id') || '';
const status = document.getElementById('status');
const review = document.getElementById('review');
const send = document.getElementById('send');
const endpoint = '/api/boss/wechat-instructions/' + encodeURIComponent(id);
const labels = {
  queued: '原桌面任务已接收这条指令。可在微信用 /chat 查看回复。',
  queued_waiting: '指令已进入原任务队列。请在 Codex 中打开该任务继续处理。',
  uncertain: '尚未确认投递结果。请先查看原任务及其队列，避免重复发送。',
};
let csrf;

async function request(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  if (response.status === 401) {
    location.replace(loginPage('/boss/wechat-instruction', location.pathname + location.search));
    throw new Error('请登录老板工作台。');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '请求失败，请刷新重试。');
  return data;
}

function display(data) {
  review.hidden = data.status !== 'pending';
  status.textContent = labels[data.status] || '请核对任务与指令。';
  if (data.status !== 'pending') return;
  document.getElementById('target').textContent = data.title;
  document.getElementById('thread').textContent = 'd-' + data.threadId;
  document.getElementById('prompt').textContent = data.prompt;
}

send.addEventListener('click', async () => {
  send.disabled = true;
  try { display(await request(endpoint, { method: 'POST', headers: { 'x-csrf-token': csrf } })); }
  catch (error) { status.textContent = error.message + ' 可刷新本页核对状态。'; }
});

try {
  if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error('指令链接无效。');
  const session = await request('/api/me');
  if (session.user.role !== 'admin') throw new Error('请使用老板账号查看指令。');
  csrf = session.csrfToken;
  display(await request(endpoint));
} catch (error) { status.textContent = error.message; }
