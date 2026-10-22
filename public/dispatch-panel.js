const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
const status = { accepted: '已受理，等待整理结束', preparing: '正在准备项目与授权', published: '任务已发布', needs_attention: '需要处理', cancelled: '已取消', paused: '已暂停' };
const delivery = { queued: '等待微信通知', sent: '微信已发送（不代表已读）', failed: '微信发送失败', uncertain: '微信发送结果不确定', not_bound: '未绑定微信，网页待办有效' };
export class DispatchPanel {
  constructor({ api, toast, getContext, insert }) {
    Object.assign(this, { api, toast, getContext, insert }); this.epoch = 0;
    this.button = document.createElement('button'); this.button.className = 'secondary hidden'; this.button.textContent = '派发资料';
    document.querySelector('#browser-button').after(this.button);
    this.dialog = document.createElement('dialog'); this.dialog.className = 'work-graph-drawer dialog-form'; document.body.append(this.dialog);
    this.button.onclick = () => this.open().catch(e => toast(e.message, 'error'));
    this.dialog.onclose = () => { this.epoch++; clearInterval(this.poller); this.dialog.replaceChildren(); };
  }
  configure(enabled) { this.button.classList.toggle('hidden', !enabled); }
  reset() { this.epoch++; clearInterval(this.poller); this.dialog.close(); this.dialog.replaceChildren(); this.configure(false); }
  async open() {
    const { project, chat } = this.getContext();
    if (!chat || project?.projectType === 'local_private' || project?.accessKind !== 'owner') throw new Error('请先选择自己的普通项目对话。');
    clearInterval(this.poller); const epoch = ++this.epoch; this.context = { project, chat };
    this.dialog.innerHTML = '<button class="secondary" data-close>关闭</button><h2>派发资料</h2><p>先上传或引用资料，再在当前对话明确说明交给谁、做什么。上传不会派发。</p><label>上传附件（每批最多 30 个、50 MiB）<input type="file" multiple></label><p role="status"></p><div data-files></div><button class="primary" data-select>将选中的资料带回对话</button><h3>派发回执</h3><div data-receipts></div>';
    this.dialog.querySelector('[data-close]').onclick = () => this.dialog.close();
    this.dialog.querySelector('input').onchange = event => this.upload([...event.target.files], epoch).catch(e => this.toast(e.message, 'error'));
    this.dialog.querySelector('[data-select]').onclick = () => {
      const files = this.files.filter(f => this.dialog.querySelector(`input[value="${f.id}"]`)?.checked);
      if (!files.length) return this.toast('请选择资料。', 'error');
      this.insert(`\n选定资料：${files.map(f => `${f.name}（资料 ID：${f.id}）`).join('、')}。\n`); this.dialog.close();
    };
    if (!this.dialog.open) this.dialog.showModal();
    await this.refresh(epoch);
    if (epoch !== this.epoch || !this.dialog.open) return;
    this.poller = setInterval(() => { if (this.dialog.open) this.refresh(epoch, true).catch(() => {}); }, 5000);
  }
  async upload(files, epoch) {
    if (files.length > 30 || files.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024) throw new Error('每批最多 30 个、合计 50 MiB。');
    const { project, chat } = this.context;
    const input = this.dialog.querySelector('input[type=file]'); input.disabled = true;
    try {
      for (const file of files) {
        if (epoch !== this.epoch) return;
        this.dialog.querySelector('[role=status]').textContent = `正在接收 ${file.name}…`;
        await this.api(`/api/projects/${project.id}/materials?chat=${chat.id}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: file });
      }
      if (epoch !== this.epoch) return;
      this.dialog.querySelector('[role=status]').textContent = '资料已收到，尚未派发。'; await this.refresh(epoch);
    } finally { if (epoch === this.epoch) input.disabled = false; }
  }
  async refresh(epoch, receiptsOnly = false) {
    const request = this.refreshRequest = (this.refreshRequest || 0) + 1;
    const { project, chat } = this.context;
    const [data, receipts] = await Promise.all([receiptsOnly ? null : this.api(`/api/projects/${project.id}/materials?chat=${chat.id}`), this.api(`/api/task-dispatches?chat=${chat.id}`)]);
    if (epoch !== this.epoch || request !== this.refreshRequest) return;
    if (data) { this.files = data.materials; this.dialog.querySelector('[data-files]').innerHTML = this.files.map(f => `<label><input type="checkbox" value="${esc(f.id)}"> ${esc(f.name)} · ${f.size} B</label>`).join('') || '<p>暂无资料。也可在对话中请 Agent 整理项目内文件。</p>'; }
    this.dialog.querySelector('[data-receipts]').innerHTML = receipts.dispatches.map(r => `<section><b>${esc(r.title)}</b><p>${esc(status[r.status] || r.status)} · ${esc(r.projectName || '等待准备项目')} · 附件 ${r.attachmentCount} 个${r.errorCode ? ` · ${esc(r.errorCode)}` : ''}</p>${r.tasks.map(t => `<p>${esc(t.employee)} · ${esc(t.title)} · ${esc(delivery[t.weixin] || t.weixin)}</p>`).join('')}</section>`).join('') || '<p>尚无派发记录。</p>';
  }
}
