import { sessionFetch } from './employee-session.js';

export class BrowserPanel {
  constructor({ button, api, toast }) {
    this.api = api; this.toast = toast; this.button = button; this.epoch = 0; this.state = { state: 'closed' }; this.actions = Promise.resolve(); this.revision = 0; this.controlBusy = false;
    this.root = document.createElement('dialog'); this.root.className = 'browser-drawer';
    this.root.setAttribute('aria-label', '对话浏览器');
    this.root.innerHTML = `<header><b>对话浏览器</b><span data-status role="status"></span><button data-hide class="secondary">收起</button></header>
      <p data-guide role="status"></p><p data-reason></p><form data-address-form class="browser-address"><input data-address type="url" required placeholder="https://example.com" aria-label="网页地址"><button class="primary" data-open>打开网页</button></form><div class="browser-controls">
      <button data-back class="secondary">返回</button><button data-reload class="secondary">刷新</button>
      <select data-tabs aria-label="浏览器标签页"></select><button data-takeover class="primary">开始接管</button>
      <button data-continue class="primary">操作完成，交还 Agent</button><button data-cancel class="secondary">取消本次接管</button>
      <button data-end class="danger-button">结束会话</button></div>
      <canvas width="1100" height="760" aria-label="网页实时画面"></canvas>
      <label class="browser-input">点选网页输入框后在此输入（支持中文）<input type="password" data-keyboard autocomplete="off" aria-label="网页键盘输入"></label>
      <p data-error role="alert"></p><small>先点击“开始接管”，再点击/滚动网页；需要打字时使用下方输入栏。操作完成后交还 Agent。结束会话或停止运行会清除登录状态。</small>`;
    document.body.append(this.root);
    this.find = selector => this.root.querySelector(selector);
    this.canvas = this.find('canvas'); this.context = this.canvas.getContext('2d');
    this.input = this.find('[data-keyboard]');
    button.addEventListener('click', () => this.show());
    this.find('[data-address-form]').onsubmit = event => { event.preventDefault(); void this.openAddress(); };
    this.find('[data-hide]').onclick = () => this.root.close();
    this.find('[data-takeover]').onclick = () => this.control('takeover');
    this.find('[data-continue]').onclick = () => this.control('continue');
    this.find('[data-cancel]').onclick = () => this.control('cancel');
    this.find('[data-end]').onclick = () => { const url = this.url(); return this.mutateControl(() => this.api(url, { method: 'DELETE' })); };
    this.find('[data-back]').onclick = () => this.action({ action: 'back' });
    this.find('[data-reload]').onclick = () => this.action({ action: 'reload' });
    this.find('[data-tabs]').onchange = event => this.action({ action: 'tab', tabId: event.target.value });
    const pointer = (event, action) => {
      if (!this.human() || this.controlBusy) return;
      event.preventDefault(); const rect = this.canvas.getBoundingClientRect();
      this.action({ action, x: (event.clientX - rect.left) * 1100 / rect.width, y: (event.clientY - rect.top) * 760 / rect.height });
    };
    this.canvas.onpointerdown = event => { if (!this.human() || this.controlBusy) return; this.dragging = true; this.canvas.setPointerCapture(event.pointerId); pointer(event, 'pointerdown'); this.input.focus(); };
    this.canvas.onpointermove = event => { if (this.dragging && Date.now() - (this.lastMove || 0) > 60) { this.lastMove = Date.now(); pointer(event, 'pointermove'); } };
    this.canvas.onpointerup = event => { if (this.dragging) { this.dragging = false; pointer(event, 'pointerup'); } };
    this.canvas.onpointercancel = event => { if (this.dragging) { this.dragging = false; pointer(event, 'pointerup'); } };
    this.canvas.addEventListener('wheel', event => { if (this.human() && !this.controlBusy) { event.preventDefault(); this.action({ action: 'scroll', deltaY: event.deltaY }); } }, { passive: false });
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
    this.epoch++; this.revision++; this.controlBusy = false; this.chatId = chatId; this.announced = ''; this.state = { state: 'closed', tabs: [] }; this.root.close(); this.input.value = '';
    this.find('[data-address]').value = ''; this.context.clearRect(0, 0, 1100, 760); this.button.disabled = !chatId; this.button.textContent = '浏览器'; this.find('[data-error]').textContent = '';
  }
  select(chatId) { this.reset(chatId); if (chatId) void this.refresh(); }
  onEvent(chatId, data) { if (this.chatId === chatId) { if (data.handoff) this.show(); else void this.refresh(); } }
  show() { if (!this.chatId) return; if (!this.root.open) this.root.showModal(); void this.refresh(); }
  error(error) { this.find('[data-error]').textContent = error.message; }
  async mutateControl(operation) {
    if (this.controlBusy) return;
    const epoch = this.epoch; this.controlBusy = true; this.revision++; this.render();
    const run = this.actions.catch(() => {}).then(async () => {
      if (epoch !== this.epoch) return;
      try { await operation(); if (epoch === this.epoch) this.find('[data-error]').textContent = ''; }
      catch (e) { if (epoch === this.epoch) this.error(e); }
      finally {
        if (epoch === this.epoch) { this.controlBusy = false; this.revision++; this.busy = null; await this.refresh(); }
      }
    });
    this.actions = run.catch(() => {}); return run;
  }
  control(decision) {
    const url = this.url('/control');
    return this.mutateControl(() => this.api(url, { method: 'POST', body: { decision } }));
  }
  openAddress() {
    const url = this.url(), address = this.find('[data-address]').value.trim();
    return this.mutateControl(() => this.api(url, { method: 'POST', body: { url: address } }));
  }
  action(body) {
    if (this.controlBusy) return Promise.resolve();
    const epoch = this.epoch, url = this.url('/actions');
    this.actions = this.actions.catch(() => {}).then(async () => {
      if (epoch !== this.epoch || !this.human()) return;
      try { await this.api(url, { method: 'POST', body }); if (epoch === this.epoch) this.find('[data-error]').textContent = ''; }
      catch (e) { if (epoch === this.epoch) this.error(e); }
    });
    return this.actions;
  }
  render() {
    const s = this.state, human = this.human(), ready = s.state === 'ready';
    this.button.textContent = s.handoff ? '浏览器 · 等待接管' : ready ? '浏览器 · 已打开' : '浏览器';
    this.find('[data-guide]').textContent = this.controlBusy ? '正在处理，请稍候…' : s.state === 'closed' ? '输入网址并点击“打开网页”，即可直接浏览；也可以在对话中让 Agent 打开网页。' : human ? '你已接管：可以点击、拖动或滚动网页。完成登录/验证后，点击“操作完成，交还 Agent”。' : s.control === 'human' ? '浏览器由另一个登录会话控制，请在该会话中完成操作。' : s.handoff ? 'Agent 正在等你操作：① 点击“开始接管” ② 在网页中完成操作 ③ 点击“操作完成，交还 Agent”。' : s.manual ? '已交还控制权；回到对话发送任务，Agent 将使用这个浏览器。' : 'Agent 正在使用浏览器。需要自己操作时，点击“开始接管”。';
    this.find('[data-status]').textContent = s.state === 'closed' ? '会话已结束' : s.state === 'starting' ? '正在启动' : human ? '你正在操作' : s.control === 'human' ? '另一登录会话正在操作' : s.handoff ? '等待你接管' : s.manual ? '等待下一轮任务' : 'Agent 正在操作';
    this.find('[data-reason]').textContent = s.reason || '';
    for (const name of ['back', 'reload', 'tabs', 'keyboard']) this.find(`[data-${name}]`).disabled = !human || this.controlBusy;
    this.find('[data-open]').disabled = this.controlBusy || s.state === 'starting' || (s.control === 'human' && !human);
    this.find('[data-address]').disabled = this.find('[data-open]').disabled;
    this.find('[data-takeover]').disabled = !ready || human || this.controlBusy || s.control === 'human';
    this.find('[data-continue]').disabled = !human || this.controlBusy;
    this.find('[data-cancel]').disabled = this.controlBusy || !(human || s.handoff && s.control === 'agent');
    this.find('[data-end]').disabled = this.controlBusy || s.state === 'closed';
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
    const epoch = this.epoch, revision = this.revision, url = this.url(); this.busy = epoch;
    try {
      const s = await this.api(url); if (epoch !== this.epoch || revision !== this.revision) return;
      this.state = s; this.render();
      if (s.handoff && this.announced !== s.id) { this.announced = s.id; if (!this.root.open) this.root.showModal(); }
      if (s.state === 'ready' && this.root.open && !document.hidden) {
        const response = await sessionFetch(url + '/frame', { cache: 'no-store' });
        if (!response.ok) { if (response.status === 401) await this.api('/api/me'); return; }
        const bitmap = await createImageBitmap(await response.blob());
        try { if (epoch === this.epoch && revision === this.revision && this.root.open) this.context.drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
      }
    } catch (e) { if (epoch === this.epoch) this.error(e); }
    finally { if (this.busy === epoch) this.busy = null; }
  }
}
