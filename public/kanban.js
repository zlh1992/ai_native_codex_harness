export const escapeCard = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
export const taskColumns = [
  { id: 'waiting', title: '待开始', tone: 'waiting' }, { id: 'active', title: '进行中', tone: 'active' },
  { id: 'review', title: '待验收', tone: 'review' }, { id: 'blocked', title: '返工 / 阻塞', tone: 'blocked' },
  { id: 'done', title: '已通过', tone: 'done' },
];
export function taskColumn(task) {
  if (task.status === 'passed') return 'done';
  if (task.status === 'rework' || (task.blockedReason && !['WAITING_DEPENDENCIES', 'WAITING_EMPLOYEE', 'WAITING_REVIEW', 'WAITING_OWNER_REVIEW', 'PREPARING'].includes(task.blockedReason))) return 'blocked';
  return ({ active: 'active', submitted: 'review' })[task.status] || 'waiting';
}
export function orderedCards(cards, ids = []) {
  const position = new Map(ids.map((id, index) => [id, index]));
  return [...cards].sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity));
}
export class KanbanBoard {
  constructor(root, { key, onOpen, storage, loadSortable = () => import('/vendor/sortable.js') }) {
    this.root = root; this.key = `portal-board:${key}`; this.onOpen = onOpen; this.loadSortable = loadSortable;
    try { this.storage = storage ?? globalThis.localStorage; } catch { this.storage = null; }
    try { this.order = JSON.parse(this.storage?.getItem(this.key) || '{}'); } catch { this.order = {}; }
    this.order = this.order && typeof this.order === 'object' && !Array.isArray(this.order) ? this.order : {};
    this.sortables = []; this.generation = 0;
    this.onClick = event => {
      const card = event.target.closest('[data-card]'); if (!card || !this.root.contains(card)) return;
      const move = event.target.closest('[data-move]');
      if (move) {
        const list = card.parentElement; const sibling = move.dataset.move === 'up' ? card.previousElementSibling : card.nextElementSibling;
        if (sibling?.matches('[data-card]')) {
          if (move.dataset.move === 'up') list.insertBefore(card, sibling); else list.insertBefore(sibling, card);
          this.saveOrder(list); move.focus();
        }
      } else if (event.target.closest('[data-open-card]')) this.onOpen(card.dataset.card);
    };
    root.addEventListener('click', this.onClick);
  }
  saveOrder(list) {
    this.order[list.dataset.column] = [...list.querySelectorAll('[data-card]')].map(node => node.dataset.card);
    try { this.storage?.setItem(this.key, JSON.stringify(this.order)); } catch { /* Private mode still permits in-page sorting. */ }
    this.signature = null;
    this.root.querySelector('.board-live').textContent = '已调整个人显示顺序，任务状态和员工权限未改变。';
  }
  render(columns, cards, query = '') {
    if (this.dragging) return;
    const signature = JSON.stringify([columns, cards, query, this.order]);
    if (signature === this.signature) return;
    this.signature = signature;
    const generation = ++this.generation;
    this.sortables.forEach(instance => instance.destroy()); this.sortables = [];
    const scrollLeft = this.root.querySelector('.kanban-board')?.scrollLeft || 0;
    const scrolls = new Map([...this.root.querySelectorAll('.kanban-items')].map(el => [el.dataset.column, el.scrollTop]));
    const focused = this.root.contains(document.activeElement) ? document.activeElement.closest('[data-card]')?.dataset.card : null;
    const search = query.trim().toLocaleLowerCase();
    const visible = cards.filter(card => !search || card.search.toLocaleLowerCase().includes(search));
    this.root.innerHTML = `<div class="kanban-board" aria-label="卡片看板">${columns.map(column => {
      const items = orderedCards(visible.filter(card => card.column === column.id), Array.isArray(this.order[column.id]) ? this.order[column.id] : []);
      return `<section class="kanban-column" data-tone="${escapeCard(column.tone)}"><header><h3>${escapeCard(column.title)}</h3><span class="kanban-count">${items.length}</span></header><div class="kanban-items" data-column="${escapeCard(column.id)}">${items.map(card => `<article class="kanban-card" data-card="${escapeCard(card.id)}"><div class="card-top"><span class="card-tag">${escapeCard(card.tag || '')}</span><span class="card-order"><button type="button" data-move="up" aria-label="上移卡片" title="上移">↑</button><button type="button" data-move="down" aria-label="下移卡片" title="下移">↓</button><span class="card-drag" aria-hidden="true" title="仅同列个人排序">⠿</span></span></div><button type="button" class="card-open" data-open-card><h4>${escapeCard(card.title)}</h4><p>${escapeCard(card.description || '')}</p></button><footer><span class="card-person"><span class="card-avatar">${escapeCard([...String(card.person || '未分配')].slice(0, 1).join(''))}</span>${escapeCard(card.person || '未分配')}</span><span class="card-meta">${escapeCard(card.meta || '')}</span></footer></article>`).join('') || '<div class="kanban-empty">暂无卡片</div>'}</div></section>`;
    }).join('')}</div><div class="board-live" role="status" aria-live="polite">${search ? `找到 ${visible.length} 张卡片。` : '拖动把手或使用 ↑ ↓ 调整同列个人顺序。状态由实际流程更新。'}</div>`;
    this.root.querySelector('.kanban-board').scrollLeft = scrollLeft;
    for (const list of this.root.querySelectorAll('.kanban-items')) list.scrollTop = scrolls.get(list.dataset.column) || 0;
    if (focused) [...this.root.querySelectorAll('[data-card]')].find(el => el.dataset.card === focused)?.querySelector('[data-open-card]')?.focus({ preventScroll: true });
    this.loadSortable().then(({ default: Sortable }) => {
      if (generation !== this.generation) return;
      this.sortables = [...this.root.querySelectorAll('.kanban-items')].map(list => new Sortable(list, {
        group: { name: `${this.key}:${list.dataset.column}`, pull: false, put: false },
        handle: '.card-drag', draggable: '[data-card]', dataIdAttr: 'data-card', animation: 150,
        ghostClass: 'kanban-ghost', chosenClass: 'kanban-chosen', delay: 150, delayOnTouchOnly: true,
        onStart: () => { this.dragging = true; }, onEnd: () => { this.dragging = false; this.saveOrder(list); },
      }));
    }).catch(() => { if (generation === this.generation) this.root.querySelector('.board-live').textContent = '拖拽组件暂不可用，可使用 ↑ ↓ 排序；点击卡片查看详情。'; });
  }
  destroy() { this.generation++; this.sortables.forEach(instance => instance.destroy()); this.sortables = []; this.root.removeEventListener('click', this.onClick); }
}
