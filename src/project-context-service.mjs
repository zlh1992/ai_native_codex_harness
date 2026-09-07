import { invariant } from './errors.mjs';
import { graphRelativePath } from './work-graph-contract.mjs';

export class ProjectContextService {
  constructor({ db, store, workspace, worktrees, graphs }) { Object.assign(this, { db, store, workspace, worktrees, graphs }); }

  collect(projectId, ownerId, { candidateIds, paths } = {}) {
    const project = this.store.owner(projectId, ownerId);
    this.graphs.idle(project.accessId);
    candidateIds ||= this.db.listUsers().filter((u) => u.role === 'user' && u.status === 'active'
      && this.store.profile(u.id).availability !== 'unavailable').map((u) => u.id).slice(0, 32);
    invariant(Array.isArray(candidateIds) && candidateIds.length >= 1 && candidateIds.length <= 32
      && new Set(candidateIds).size === candidateIds.length, 400, 'CANDIDATES_REQUIRED', '请选择 1–32 名候选员工。');
    const employees = candidateIds.map((id) => {
      const user = this.db.getUserById(id); const profile = this.store.profile(id);
      invariant(user?.role === 'user' && user.status === 'active' && profile.availability !== 'unavailable',
        400, 'INVALID_ASSIGNEE', '候选员工不可用。');
      return { id, name: user.displayName, jobTitle: profile.jobTitle, skills: profile.skills,
        responsibilities: profile.responsibilities.slice(0, 500), deliveryPreference: profile.deliveryPreference.slice(0, 200),
        availability: profile.availability, profileRevision: profile.revision };
    });
    const root = this.workspace.projectRoot(project);
    const baseline = this.worktrees.snapshotProject(root);
    this.db.setProjectRepoKind(project.id, 'git');
    if (!paths) paths = this.workspace.tree(project, '', 4, 300).entries
      .filter((file) => file.type === 'file' && /\.(md|txt|json|csv|tsv)$/i.test(file.path)).map((file) => file.path).slice(0, 30);
    invariant(Array.isArray(paths) && paths.length <= 30, 400, 'INVALID_CONTEXT_PATHS', '资料文件最多 30 个。');
    paths = [...new Set(paths.map(graphRelativePath))];
    const files = []; const manifest = []; let remaining = 48 * 1024;
    for (const relative of paths) {
      try {
        const [file] = this.worktrees.readSnapshotFiles({ projectRoot: root, commitSha: baseline.commitSha,
          paths: [relative], maxBytes: Math.min(16 * 1024, remaining) });
        if (!file.readable) { manifest.push({ path: relative, used: false, reason: 'UNSUPPORTED_FORMAT' }); continue; }
        remaining -= file.size;
        files.push({ path: file.path, content: file.content });
        manifest.push({ path: file.path, sha256: file.sha256, size: file.size, used: true });
      } catch (error) {
        if (!['CONTEXT_TOO_LARGE', 'OUTPUT_FILE_REQUIRED'].includes(error.code)) throw error;
        manifest.push({ path: relative, used: false, reason: error.code });
      }
    }
    return { project: { id: project.id, name: project.name, description: project.description },
      candidateIds, employees, files, manifest, baseline };
  }

  review(submissionId, ownerId) {
    const submission = this.db.getSubmission(submissionId);
    const task = submission && this.db.getTask(submission.taskId);
    invariant(task?.workflowRunId, 404, 'SUBMISSION_NOT_FOUND', '工作图交付不存在。');
    const project = this.store.owner(task.projectId, ownerId);
    this.graphs.member(task);
    invariant(task.version === submission.taskVersion && submission.verdict === 'pending', 409, 'SUBMISSION_NOT_PENDING', '交付版本已变化。');
    // Read fixed Git objects from the authorized repository, never the employee's current files.
    const files = []; const omitted = [];
    let remaining = 64 * 1024;
    for (const output of submission.outputsManifest) {
      try {
        const [file] = this.worktrees.readSnapshotFiles({ projectRoot: this.workspace.projectRoot(project),
          commitSha: submission.snapshotCommitSha, paths: [output.path], maxBytes: remaining });
        invariant(file.sha256 === output.sha256, 409, 'OUTPUT_HASH_CHANGED', '交付成果校验失败。');
        if (!file.readable) omitted.push(output.path);
        else { files.push(file); remaining -= file.size; }
      } catch (error) {
        if (error.code !== 'CONTEXT_TOO_LARGE') throw error;
        omitted.push(output.path);
      }
    }
    return { task: { id: task.id, title: task.title, version: task.version, acceptance: task.acceptance,
      checklist: submission.checklistSnapshot, requiresIndependentValidation: this.graphs.node(task).requiresIndependentValidation },
    submission: { id: submission.id, kind: submission.kind, summary: submission.resultSummary,
      finalReply: submission.finalReplySnapshot.slice(0, 12000), note: submission.employeeNote, outputs: submission.outputsManifest },
    upstream: this.graphs.handoffs(task.id, ownerId), files, omitted };
  }
}
