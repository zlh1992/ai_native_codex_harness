// Derive choices only from the current user's authorized task projection.
export const taskGraphKey = task => task.roadmapId ? `graph:${task.roadmapId}` : 'ungrouped';

export function taskGraphChoices(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const id = taskGraphKey(task);
    const group = groups.get(id) || { id, label: task.roadmapId
      ? `${task.projectName || '项目'} · ${task.roadmapTitle || '未命名工作图'}` : '未归入工作图的任务', count: 0 };
    group.count++; groups.set(id, group);
  }
  return [...groups.values()];
}

export function selectTaskGraph(tasks, selected = '') {
  const choices = taskGraphChoices(tasks);
  const id = choices.some(choice => choice.id === selected) ? selected : '';
  return { choices, id, tasks: id ? tasks.filter(task => taskGraphKey(task) === id) : tasks };
}
