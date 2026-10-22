const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
const labels = { active: '已连接', reconnecting: '暂时断线，正在重连', pending: '等待微信扫码确认', expired: '二维码已过期或连接失败，请重新扫码', blocked: '权限已变化或当前禁网，请联系老板' };
export class WeixinPanel {
  constructor({ api, toast, getContext }) {
    Object.assign(this, { api, toast, getContext }); this.epoch = 0;
    this.button = document.createElement('button'); this.button.className = 'secondary hidden'; this.button.textContent = '微信连接';
    document.querySelector('#user-chip').after(this.button);
    this.dialog = document.createElement('dialog'); this.dialog.className = 'work-graph-drawer dialog-form'; document.body.append(this.dialog);
    this.button.onclick = () => this.open().catch(e => toast(e.message, 'error'));
    this.dialog.onclose = () => { this.epoch++; clearInterval(this.poller); this.dialog.replaceChildren(); };
  }
  configure(enabled) { this.button.classList.toggle('hidden', !enabled); }
  reset() { this.epoch++; clearInterval(this.poller); this.dialog.close(); this.dialog.replaceChildren(); this.configure(false); }
  async open() {
    clearInterval(this.poller); const epoch = ++this.epoch; const { user, projects, project } = this.getContext();
    this.dialog.innerHTML = `<button class="secondary" data-close>关闭</button><h2>微信连接</h2><p>绑定身份：${esc(user.displayName)} · ${user.role === 'admin' ? '老板' : '员工'}</p><p>每人一个连接，只进入当前获准的普通项目。任务通知无需切换当前项目；网页待办始终可用。</p><label>微信当前项目<select>${projects.filter(p => p.projectType !== 'local_private').map(p => `<option value="${esc(p.id)}" ${p.id === project?.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><div data-state role="status"></div><div data-qr></div><div class="dialog-actions"><button class="primary" data-bind>扫码绑定 / 重新扫码</button><button class="secondary" data-switch>切换到所选项目</button><button class="secondary" data-unbind>解绑</button></div><p>确认扫码后，请在微信发一条消息建立通知上下文。登录不会自动执行任务。处理指定任务时，使用通知内的“处理任务”指令。</p><div data-deliveries></div>`;
    this.dialog.querySelector('[data-close]').onclick = () => this.dialog.close();
    for (const [attribute, method] of [['bind', 'POST'], ['switch', 'PATCH'], ['unbind', 'DELETE']]) {
      this.dialog.querySelector(`[data-${attribute}]`).onclick = async event => {
        const button = event.currentTarget; button.disabled = true;
        try { await this.api('/api/me/weixin', { method, body: { projectId: this.dialog.querySelector('select').value } }); if (epoch === this.epoch) await this.refresh(epoch); }
        catch (e) { this.toast(e.message, 'error'); } finally { if (epoch === this.epoch) button.disabled = false; }
      };
    }
    this.dialog.showModal(); await this.refresh(epoch, true);
    if (epoch !== this.epoch || !this.dialog.open) return;
    this.poller = setInterval(() => this.refresh(epoch).catch(() => {}), 2000);
  }
  async refresh(epoch, initial = false) {
    const request = this.refreshRequest = (this.refreshRequest || 0) + 1;
    const { connection } = await this.api('/api/me/weixin'); if (epoch !== this.epoch || request !== this.refreshRequest) return;
    this.dialog.querySelector('[data-state]').textContent = connection ? `${labels[connection.status] || connection.status} · 当前项目：${connection.projectName}${connection.taskId ? ` · 任务：${connection.taskId}` : ''}` : '尚未绑定微信';
    if (initial && connection?.projectId) this.dialog.querySelector('select').value = connection.projectId;
    const qr = this.dialog.querySelector('[data-qr]');
    if (qr.dataset.src !== (connection?.qr || '')) { qr.replaceChildren(); qr.dataset.src = connection?.qr || ''; if (connection?.qr) { const image = document.createElement('img'); image.src = connection.qr; image.alt = '使用自己的微信扫码绑定'; qr.append(image); } }
    this.dialog.querySelector('[data-switch]').disabled = connection?.status !== 'active';
    this.dialog.querySelector('[data-unbind]').disabled = !connection;
    this.dialog.querySelector('[data-deliveries]').textContent = (connection?.deliveries || []).map(d => ({ sent: '微信已发送，不代表已读', uncertain: '发送结果不确定，未自动重发', failed: '微信发送失败，网页任务仍然有效', queued: '等待微信通知', cancelled: '旧通知已取消', sending: '正在发送' })[d.status] || d.status).join('；');
  }
}
