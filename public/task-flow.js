// UI guidance only; the server remains authoritative for every task action.
export function taskConversationState(task, chat) {
  if (!chat?.taskId) return { canWork: true, message: '' };
  if (!task || task.id !== chat.taskId) return { canWork: false, message: '任务已不可用，请返回任务看板确认当前授权。' };
  if (task.version !== chat.taskVersion) return { canWork: false, canOpenCurrent: ['active', 'rework'].includes(task.status)
    && (!task.workflowRunId || task.workflowStatus === 'running'), message: `当前任务已更新到 V${task.version}；此对话保留 V${chat.taskVersion} 历史，请进入当前版本继续。` };
  if (task.workflowRunId && task.workflowStatus !== 'running') return { canWork: false,
    message: task.workflowStatus === 'passed' ? '整张工作图已完成。可查看验收记录和最终交付。'
      : task.workflowStatus === 'paused' ? '工作图已暂停，等待老板恢复后继续。' : '此工作图已停止，请返回任务看板查看当前任务。' };
  if (task.status === 'submitted') return { canWork: false, message: task.blockedReason === 'WAITING_OWNER_REVIEW'
    ? '成果已提交，需要老板查看审核意见后决定。'
    : task.reviewMode === 'auto' ? '成果已提交，AI 正在审核；通过后自动交付并推进下一位员工。'
      : task.reviewMode === 'assisted' ? '成果已提交，AI 提供意见后由老板决定。' : '成果已提交，正在按项目策略验收。' };
  if (task.status === 'passed') return { canWork: false, message: '此任务已通过并交付。返回任务看板查看后续任务；无需再次提交。' };
  if (!['active', 'rework'].includes(task.status)) return { canWork: false, message: '等待前序验收和任务下发，暂不能执行。' };
  return { canWork: true, message: task.status === 'rework' ? '请先查看返工意见，修改后重新提交当前版本。'
    : '完成后点击最终回复的“提交任务 Done”，或在任务详情提交文件；AI 完成回复不等于已提交验收。' };
}
