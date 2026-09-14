const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function toolDetailHtml(item, open = false) {
  const labels = { running: '运行中', completed: '成功', failed: '失败', interrupted: '已中断 / 未确认结果' };
  const mark = item.status === 'running' ? '↳' : item.status === 'completed' ? '✓' : '✕';
  const seconds = Math.max(0, ((item.endedAt || Date.now()) - item.startedAt) / 1000).toFixed(1);
  const summary = item.summaryStatus === 'ready' ? `Luna-low：${item.summary}`
    : item.summaryStatus === 'pending' ? '摘要生成中（不影响执行）' : item.summaryStatus === 'unavailable' ? '摘要未生成，请查看明细' : '';
  return `<details data-tool-id="${escape(item.id)}" ${open ? 'open' : ''}><summary><span>${mark} ${escape(item.name)} · ${labels[item.status] || '未知'} · ${seconds}s${item.exitCode != null ? ` · exit ${escape(item.exitCode)}` : ''}</span><small>${escape(summary || item.input.slice(0, 160) || '展开查看工具明细')}</small></summary><div class="tool-io"><b>输入参数</b><pre>${escape(item.input || '未提供参数')}</pre><b>输出结果</b><pre>${escape(item.output || (item.status === 'running' ? '尚未返回结果；命令结束后显示输出。' : '未提供输出'))}</pre></div></details>`;
}

export class ToolDetailsPanel {
  constructor({ root, context, api }) {
    this.root = root; this.context = context; this.api = api; this.key = ''; this.items = new Map(); this.cursor = 0;
    this.generation = 0; this.loading = false;
  }
  reset(key) {
    this.key = key; this.generation++; this.items.clear(); this.cursor = 0; this.runId = null; this.rendered = null;
    this.root.innerHTML = ''; this.root.hidden = true;
    this.root.ownerDocument.body.classList.remove('tool-details-ready');
  }
  async refresh() {
    const ctx = this.context();
    const key = ctx ? `${ctx.epoch}:${ctx.chatId}` : '';
    if (key !== this.key) this.reset(key);
    if (!ctx || this.loading) return;
    this.loading = true;
    const generation = this.generation;
    const current = () => { const c = this.context(); return generation === this.generation && c?.chatId === ctx.chatId && c?.epoch === ctx.epoch; };
    try {
      let more = true;
      while (more && current()) {
        const data = await this.api(`/api/chats/${encodeURIComponent(ctx.chatId)}/tool-calls?after=${this.cursor}`);
        if (!current()) return;
        if (this.runId !== data.runId) {
          this.items.clear(); this.cursor = 0; this.runId = data.runId;
          // Cursor belongs to the old run; fetch the new run from zero.
          if (data.runId) continue;
        }
        for (const item of data.items || []) this.items.set(item.id, item);
        this.cursor = data.cursor; more = data.hasMore;
      }
      if (!current()) return;
      const version = `${this.runId}:${this.cursor}`;
      if (this.rendered === version) return;
      this.rendered = version;
      const opened = new Set([...this.root.querySelectorAll('details[open]')].map(el => el.dataset.toolId));
      const scroll = this.root.scrollTop;
      this.root.innerHTML = `<p class="eyebrow">本轮工具明细 · 点击展开</p>${[...this.items.values()].sort((a,b) => a.id-b.id).map(item => toolDetailHtml(item, opened.has(String(item.id)))).join('')}`;
      this.root.hidden = !this.items.size; this.root.scrollTop = scroll;
      this.root.ownerDocument.body.classList.toggle('tool-details-ready', Boolean(this.items.size));
    } catch (error) {
      if (current() && [401,403,404].includes(error.status)) this.reset('');
    } finally { this.loading = false; }
  }
}
