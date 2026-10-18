import { sessionFetch } from './employee-session.js';

export class BrowserPanel {
  constructor({ button, api, toast }) {
    this.api = api; this.toast = toast; this.button = button; this.epoch = 0; this.state = { state: 'closed' }; this.actions = Promise.resolve();
    this.root = document.createElement('dialog'); this.root.className = 'browser-drawer';
    this.root.setAttribute('aria-label', '对话浏览器');
    this.root.innerHTML = `<header><b>对话浏览器</b><span data-status role="status"></span><button data-hide class="secondary">收起</button></header>
      <p data-reason></p><div class="browser-controls">
      <button data-back class="secondary">返回</button><button data-reload class="secondary">刷新</button>
      <select data-tabs aria-label="浏览器标签页"></select><button data-takeover>接管</button>
      <button data-continue>完成，继续</button><button data-cancel class="danger-button">取消等待</button>
      <button data-end class="danger-button">结束会话</button></div>
      <canvas width="1100" height="760" aria-label="网页实时画面"></canvas>
      <label class="browser-input">点选网页输入框后在此输入（支持中文）<input type="password" data-keyboard autocomplete="off" aria-label="网页键盘输入"></label>
      <p data-error role="alert"></p><small>登录状态仅在本次运行内保留；停止运行会关闭浏览器。</small>`;
    document.body.append(this.root);
    this.find = selector => this.root.querySelector(selector);
    this.canvas = this.find('canvas'); this.context = this.canvas.getContext('2d');
    this.input = this.find('[data-keyboard]');
    button.addEventListener('click', () => this.show());
    this.find('[data-hide]').onclick = () => this.root.close();
    this.find('[data-takeover]').onclick = () => this.control('takeover');
    this.find('[data-continue]').onclick = () => this.control('continue');
    this.find('[data-cancel]').onclick = () => this.control('cancel');
    this.find('[data-end]').onclick = async () => { try { await this.api(this.url(), { method: 'DELETE' }); await this.refresh(); } catch (e) { this.error(e); } };
    this.find('[data-back]').onclick = () => this.action({ action: 'back' });
    this.find('[data-reload]').onclick = () => this.action({ action: 'reload' });
    this.find('[data-tabs]').onchange = event => this.action({ action: 'tab', tabId: event.target.value });
    const pointer = (event, action) => {
      if (!this.human()) return;
      event.preventDefault(); const rect = this.canvas.getBoundingClientRect();
      this.action({ action, x: (event.clientX - rect.left) * 1100 / rect.width, y: (event.clientY - rect.top) * 760 / rect.height });
    };
    this.canvas.onpointerdown = event => { if (!this.human()) return; this.dragging = true; this.canvas.setPointerCapture(event.pointerId); pointer(event, 'pointerdown'); this.input.focus(); };
    this.canvas.onpointermove = event => { if (this.dragging && Date.now() - (this.lastMove || 0) > 60) { this.lastMove = Date.now(); pointer(event, 'pointermove'); } };
    this.canvas.onpointerup = event => { if (this.dragging) { this.dragging = false; pointer(event, 'pointerup'); } };
    this.canvas.onpointercancel = event => { if (this.dragging) { this.dragging = false; pointer(event, 'pointerup'); } };
    this.canvas.addEventListener('wheel', event => { if (this.human()) { event.preventDefault(); this.action({ action: 'scroll', deltaY: event.deltaY }); } }, { passive: false });
    const insert = () => { const text = this.input.value; this.input.value = ''; if (text && this.human()) this.action({ action: 'text', text }); };
    this.input.addEventListener('input', event => { if (!event.isComposing && !this.composing) insert(); });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; insert(); });
    this.input.addEventListener('keydown', event => {
      if (event.isComposing || this.composing || !this.human()) return;
      const key = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' ? 'Control+A' : event.key;
      if (/^(Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Control\+A)$/.test(key)) {
        event.preventDefault(); event.stopPropagation(); this.action({ action: 'press', key });
      }
    });
    this.timer = setInterval(() => { if (this.chatId && this.root.open && !document.hidden) void this.refresh(); }, 700);
    this.reset();
  }
  url(suffix = '') { return `/api/chats/${this.chatId}/browser${suffix}`; }
  human() { return this.state.state === 'ready' && this.state.control === 'human' && this.state.canControl !== false; }
  reset(chatId = '') {
    this.epoch++; this.chatId = chatId; this.announced = ''; this.state = { state: 'closed', tabs: [] }; this.root.close(); this.input.value = '';
    this.context.clearRect(0, 0, 1100, 760); this.button.disabled = !chatId; this.button.textContent = '浏览器'; this.find('[data-error]').textContent = '';
  }
  select(chatId) { this.reset(chatId); if (chatId) void this.refresh(); }
  onEvent(chatId, data) { if (this.chatId === chatId) { if (data.handoff) this.show(); else void this.refresh(); } }
  show() { if (!this.chatId) return; if (!this.root.open) this.root.showModal(); void this.refresh(); }
  error(error) { this.find('[data-error]').textContent = error.message; }
  async control(decision) {
    const epoch = this.epoch;
    try { const state = await this.api(this.url('/control'), { method: 'POST', body: { decision } }); if (epoch === this.epoch) { this.state = state; this.render(); } }
    catch (e) { if (epoch === this.epoch) this.error(e); }
  }
  action(body) {
    const epoch = this.epoch, url = this.url('/actions');
    this.actions = this.actions.catch(() => {}).then(async () => {
      if (epoch !== this.epoch || !this.human()) return;
      try { await this.api(url, { method: 'POST', body }); }
      catch (e) { if (epoch === this.epoch) this.error(e); }
    });
    return this.actions;
  }
  render() {
    const s = this.state, human = this.human(), ready = s.state === 'ready';
    this.button.textContent = s.handoff ? '浏览器 · 等待接管' : ready ? '浏览器 · 已打开' : '浏览器';
    this.find('[data-status]').textContent = s.state === 'closed' ? '会话已结束' : s.state === 'starting' ? '正在启动' : human ? '你正在操作' : s.control === 'human' ? '另一登录会话正在操作' : s.handoff ? '等待你接管' : 'Agent 正在操作';
    this.find('[data-reason]').textContent = s.reason || '';
    for (const name of ['back', 'reload', 'tabs', 'keyboard']) this.find(`[data-${name}]`).disabled = !human;
    this.find('[data-takeover]').disabled = !ready || human;
    this.find('[data-continue]').disabled = !human;
    this.find('[data-cancel]').disabled = !(human || s.handoff && s.control === 'agent');
    this.find('[data-end]').disabled = s.state === 'closed';
    const tabs = this.find('[data-tabs]');
    const signature = JSON.stringify(s.tabs || []);
    if (tabs.dataset.signature !== signature) {
      tabs.replaceChildren(...(s.tabs || []).map((tab, index) => { const option = document.createElement('option'); option.value = tab.id; option.textContent = `${index + 1}. ${tab.url}`; return option; }));
      tabs.dataset.signature = signature;
    }
    tabs.value = s.tabId || '';
    if (!ready) this.context.clearRect(0, 0, 1100, 760);
  }
  async refresh() {
    if (!this.chatId || this.busy === this.epoch) return;
    const epoch = this.epoch, url = this.url(); this.busy = epoch;
    try {
      const s = await this.api(url); if (epoch !== this.epoch) return;
      this.state = s; this.render();
      if (s.handoff && this.announced !== s.id) { this.announced = s.id; if (!this.root.open) this.root.showModal(); }
      if (s.state === 'ready' && this.root.open && !document.hidden) {
        const response = await sessionFetch(url + '/frame', { cache: 'no-store' });
        if (!response.ok) { if (response.status === 401) await this.api('/api/me'); return; }
        const bitmap = await createImageBitmap(await response.blob());
        try { if (epoch === this.epoch && this.root.open) this.context.drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
      }
    } catch (e) { if (epoch === this.epoch) this.error(e); }
    finally { if (this.busy === epoch) this.busy = null; }
  }
}
