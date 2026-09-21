const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[c]);
const number = value => Number(value || 0).toLocaleString('zh-CN');
const day = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0,10);
const kinds = { root: '主对话', subagent: '子代理', search: '联网搜索', summary: '工具摘要', compaction: '本地压缩' };
export function usageValue(value) { return value.missingCalls && value.missingCalls === value.calls ? '—' : number(value.totalTokens); }
export class TokenDashboard {
  constructor({ root, api, onError = () => {} }) {
    this.root = root; this.api = api; this.onError = onError; this.generation = 0; this.request = 0;
  }
  stop() { ++this.generation; ++this.request; clearInterval(this.timer); this.root.replaceChildren(); this.active = false; }
  start(users) {
    if (this.active) return;
    this.active = true;
    this.root.innerHTML = `<div class="panel-title"><div><p class="eyebrow">TOKEN USAGE</p><h2>模型用量</h2><p>此网站全部调用 · 北京时间 · 仅计 Token</p></div><button class="secondary" data-refresh>刷新用量</button></div>
      <form class="usage-filters"><label>时间范围<select name="period"><option value="1">今日</option><option value="7" selected>近 7 天</option><option value="30">近 30 天</option><option value="custom">自定义</option></select></label>
      <label>开始日期<input name="from" type="date" required></label><label>结束日期<input name="to" type="date" required></label>
      <label>用户<select name="userId"><option value="">全部用户</option>${users.map(u => `<option value="${escape(u.id)}">${escape(u.displayName)}${u.role === 'admin' ? ' · 老板' : ''}</option>`).join('')}</select></label>
      <label>引擎<select name="engine"><option value="">全部引擎</option><option value="gpt">GPT</option><option value="deepseek">本地 DeepSeek</option></select></label>
      <label>模型<select name="model"><option value="">全部模型</option></select></label><button class="primary" type="submit">应用筛选</button></form>
      <p data-status role="status"></p><p data-error class="form-error" role="alert"></p><div data-results></div>`;
    const form = this.root.querySelector('form');
    const field = name => form.querySelector(`[name="${name}"]`);
    const dates = () => {
      const period = field('period').value;
      if (period === 'custom') return;
      field('to').value = day(Date.now()); field('from').value = day(Date.now() - (Number(period)-1)*86400000);
    };
    dates();
    field('period').addEventListener('change', dates);
    for (const key of ['from','to']) field(key).addEventListener('change', () => { field('period').value = 'custom'; });
    form.addEventListener('submit', event => { event.preventDefault(); void this.refresh(); });
    this.root.querySelector('[data-refresh]').addEventListener('click', () => { dates(); void this.refresh(); });
    this.timer = setInterval(() => { if (!document.hidden) { dates(); void this.refresh(); } }, 30000);
    void this.refresh();
  }
  async refresh() {
    if (!this.active) return;
    const generation = this.generation, request = ++this.request;
    const params = new URLSearchParams();
    for (const name of ['from','to','userId','engine','model']) {
      const value = this.root.querySelector(`[name="${name}"]`).value;
      if (value) params.set(name, value);
    }
    try {
      const data = await this.api(`/api/admin/token-usage?${params}`);
      if (!this.active || generation !== this.generation || request !== this.request) return;
      this.root.querySelector('[data-error]').textContent = '';
      this.render(data);
    } catch (error) {
      if (!this.active || generation !== this.generation || request !== this.request) return;
      this.root.querySelector('[data-error]').textContent = `用量更新失败：${error.message}。保留上次结果。`;
      this.onError(error);
    }
  }
  render(data) {
    const model = this.root.querySelector('[name="model"]'), selected = model.value;
    model.innerHTML = `<option value="">全部模型</option>${[...new Set([...data.availableModels, ...(selected ? [selected] : [])])].map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join('')}`;
    model.value = selected;
    const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
    this.root.querySelector('[data-status]').textContent = `采集始于 ${formatter.format(new Date(data.startedAt))}；不回填旧账、不含网站外调用。更新于 ${formatter.format(new Date(data.updatedAt))}。`;
    const cards = [['gpt','GPT 总量'],['bossGpt','老板 GPT'],['employeeGpt','员工 GPT'],['deepseek','本地 DeepSeek']];
    const note = value => value.incompleteCalls ? `${value.incompleteCalls} 次调用数据不完整（${value.missingCalls} 次未上报，${value.pendingCalls} 次进行中）；显示已上报量` : `${value.calls} 次已计量调用`;
    const details = (items, name) => `<div class="table-wrap"><table><thead><tr><th>${name}</th><th>总 Token</th><th>输入</th><th>输出</th><th>缓存命中</th><th>缓存写入</th><th>推理</th><th>完整性</th></tr></thead><tbody>${items.map(item => `<tr><td>${escape(item.label)}</td><td>${usageValue(item)}</td><td>${number(item.inputTokens)}</td><td>${number(item.outputTokens)}</td><td>${number(item.cachedInputTokens)}</td><td>${number(item.cacheWriteInputTokens)}</td><td>${number(item.reasoningOutputTokens)}</td><td>${escape(note(item))}</td></tr>`).join('') || '<tr><td colspan="8">此范围暂无已采集调用</td></tr>'}</tbody></table></div>`;
    const max = Math.max(1, ...data.days.map(item => Math.max(item.gpt.totalTokens, item.deepseek.totalTokens)));
    this.root.querySelector('[data-results]').innerHTML = `<div class="metric-grid usage-metrics">${cards.map(([key,label]) => {
      const value = data.totals[key]; return `<article class="metric"><small>${label}</small><b>${usageValue(value)}</b><span>${escape(note(value))}${key === 'deepseek' && !data.localDeepSeek?.enabled ? ' · 引擎未启用' : ''}</span><span>输入 ${number(value.inputTokens)} · 输出 ${number(value.outputTokens)}</span></article>`;
    }).join('')}</div>
      <p class="usage-note">输入包含缓存 Token，输出包含已报告的推理 Token；这些细项不重复相加。未上报数据不会被视为实际零消耗。</p>
      <h3>每日趋势</h3><div class="usage-trend table-wrap"><table><thead><tr><th>日期</th><th>GPT</th><th>本地 DeepSeek</th></tr></thead><tbody>${data.days.map(item => `<tr><td>${item.date}</td>${['gpt','deepseek'].map(engine => `<td><meter min="0" max="${max}" value="${item[engine].totalTokens}" aria-label="${item.date} ${engine} Token"></meter><span>${usageValue(item[engine])}${item[engine].incompleteCalls ? ' · 不完整' : ''}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <h3>员工 GPT 用量</h3>${details(data.employees.map(item => ({ ...item, label: item.displayName || '已删除用户' })), '员工')}
      <h3>模型与推理强度</h3>${details(data.models.map(item => ({ ...item, label: `${item.model}${item.effort ? ' · '+item.effort : ''}` })), '模型')}
      <h3>调用类别</h3>${details(data.kinds.map(item => ({ ...item, label: `${item.engine === 'gpt' ? 'GPT' : 'DeepSeek'} · ${kinds[item.kind] || item.kind}` })), '类别')}`;
  }
}
