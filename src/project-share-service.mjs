import { randomUUID } from 'node:crypto';
import { invariant } from './errors.mjs';

export class ProjectShareService {
  constructor({ db, workspace, worktrees, codex, store }) { Object.assign(this, { db, workspace, worktrees, codex, store }); }

  usage(userId) { return this.workspace.usageForUser(userId, this.db.listProjectsForUser(userId)); }
  checkQuota(project, user, treePath) {
    invariant(this.db.listProjectsForUser(user.id).length < Math.min(user.maxProjects, 100), 413, 'PROJECT_QUOTA', '员工项目配额已满。');
    const bytes = this.workspace.projectUsage({ ...project, treePath, accessKind: 'shared', accessUserId: user.id }).bytes;
    invariant(this.usage(user.id).bytes + bytes <= user.maxStorageBytes, 413, 'STORAGE_QUOTA', '授权工作树将超过员工存储配额。');
  }

  async grant({ project, userId, authorize, scope = 'files_and_history' }) {
    invariant(['files_only', 'files_and_history'].includes(scope), 400, 'INVALID_SHARE_SCOPE', '分享范围无效。');
    const check = () => {
      authorize();
      const target = this.db.getUserById(userId);
      invariant(target?.status === 'active' && target.role === 'user', 404, 'EMPLOYEE_NOT_FOUND', '员工不存在或账号未启用。');
      invariant(!this.db.getProjectForUser(project.id, userId), 409, 'SHARE_EXISTS', '该员工已经拥有此项目的有效授权。');
      return target;
    };
    const target = check();
    const revoked = this.db.latestRevokedProjectAccess(project.id, userId);
    if (revoked && this.worktrees.isReusableShare({ treePath: revoked.treePath })) {
      this.checkQuota(project, target, revoked.treePath);
      check();
      return { access: this.db.restoreProjectAccess(revoked.id), restored: true, copiedChats: 0 };
    }
    invariant(!this.codex.workspaceBusy(project.accessId), 409, 'WORKSPACE_BUSY', '项目正在执行或共享，请稍后重试。');
    this.codex.sharingAccesses.add(project.accessId);
    const accessId = randomUUID();
    let tree; let access;
    try {
      const sources = scope === 'files_and_history' ? this.db.listChats({ projectId: project.id, userId: project.userId }) : [];
      tree = this.worktrees.createShare({ projectRoot: this.workspace.projectRoot(project), projectId: project.id, accessId });
      const shared = { ...project, accessKind: 'shared', accessUserId: userId, accessId, treePath: tree.treePath };
      const snapshots = scope === 'files_and_history'
        ? await this.codex.prepareSharedChats({ sources, project: shared, user: target, authorize: check }) : [];
      const current = check();
      this.checkQuota(project, current, tree.treePath);
      access = this.db.grantProjectAccessWithChats({ id: accessId, projectId: project.id, userId,
        treePath: tree.treePath, branchName: tree.branchName, baseSha: tree.baseSha }, snapshots);
      return { access, restored: false, copiedChats: snapshots.length, includedLocalChanges: tree.includedLocalChanges,
        untrackedFiles: tree.untrackedFiles, scope };
    } catch (error) {
      if (tree && !access) try { this.worktrees.discardUnboundShare({ projectRoot: this.workspace.projectRoot(project), ...tree }); } catch { /* retain for recovery */ }
      throw error;
    } finally { this.codex.sharingAccesses.delete(project.accessId); }
  }

  cleanupCancelled(runId) {
    const run = this.store.run(runId);
    invariant(run?.status === 'cancelled', 409, 'WORKFLOW_STATE_INVALID', '仅清理已取消运行的未发布资源。');
    const project = this.store.owner(run.projectId, run.ownerId);
    const authorization = structuredClone(run.authorization);
    for (const member of authorization.members) {
      const prepared = member.prepared;
      if (prepared?.kind !== 'new' || this.db.getProjectAccessById(prepared.id)) continue;
      const treePath = this.worktrees.treePath(prepared.id);
      // This identity was never published to a user. Preserve any unexpected dirty work.
      if (this.worktrees.isReusableShare({ treePath })) {
        const result = this.worktrees.removeShare({ projectRoot: this.workspace.projectRoot(project), treePath });
        if (!result.removed) continue;
      }
      delete member.prepared;
    }
    this.store.sql.prepare("UPDATE workflow_runs SET authorization_json=? WHERE id=? AND status='cancelled'")
      .run(JSON.stringify(authorization), run.id);
  }

  prepareWorkflow(job) {
    const run = this.store.assertRun(job.runId, job.generation, ['preparing']);
    this.store.assertJob(job.id, job.leaseToken);
    const project = this.store.owner(run.projectId, run.ownerId);
    invariant(!this.codex.workspaceBusy(project.accessId), 409, 'WORKSPACE_BUSY', '等待老板工作区空闲后分享。');
    this.codex.sharingAccesses.add(project.accessId);
    try {
      const root = this.workspace.projectRoot(project);
      const authorization = structuredClone(run.authorization);
      const baseline = authorization.baseline || this.worktrees.snapshotProject(root);
      authorization.baseline = baseline;
      const persist = () => this.db.db.prepare('UPDATE workflow_runs SET authorization_json=? WHERE id=? AND generation=?')
        .run(JSON.stringify(authorization), run.id, run.generation);
      persist();
      for (const member of authorization.members) {
        this.store.assertJob(job.id, job.leaseToken);
        const user = this.db.getUserById(member.userId);
        invariant(user?.status === 'active' && user.role === 'user' && this.store.policyEpoch(user.id) === member.epoch,
          403, 'MEMBER_POLICY_CHANGED', '员工账号策略已变化。');
        const current = this.db.getProjectForUser(run.projectId, user.id);
        if (member.accessId) {
          invariant(current?.accessId === member.accessId, 403, 'PROJECT_ACCESS_REVOKED', '已授权员工的项目权限已撤销。');
          member.prepared = { kind: 'existing', id: current.accessId };
          continue;
        }
        if (current) { member.accessId = current.accessId; member.prepared = { kind: 'existing', id: current.accessId }; continue; }
        if (!member.prepared) {
          const revoked = this.db.latestRevokedProjectAccess(run.projectId, user.id);
          member.prepared = revoked && this.worktrees.isReusableShare({ treePath: revoked.treePath })
            ? { kind: 'restore', id: revoked.id, treePath: revoked.treePath, baseSha: revoked.baseSha }
            : { kind: 'new', id: randomUUID() };
          persist(); // Identity exists durably before any filesystem side effect.
        }
        const prepared = member.prepared;
        if (prepared.kind === 'new') {
          const target = this.worktrees.treePath(prepared.id);
          if (!this.worktrees.isReusableShare({ treePath: target })) {
            const tree = this.worktrees.createShare({ projectRoot: root, projectId: project.id, accessId: prepared.id, baseline });
            Object.assign(prepared, tree);
          } else {
            prepared.treePath = target;
            prepared.baseSha = baseline.commitSha;
            prepared.branchName = `portal/share/${project.id.replaceAll('-', '').slice(0, 8)}/${prepared.id.replaceAll('-', '').slice(0, 8)}`;
          }
        }
        this.checkQuota(project, user, prepared.treePath);
        persist();
        this.store.heartbeat(job.id, job.leaseToken);
      }
      this.store.transaction(() => {
        this.store.assertJob(job.id, job.leaseToken);
        for (const member of authorization.members) {
          const prepared = member.prepared;
          if (prepared.kind === 'new') this.db.grantProjectAccess({ ...prepared, projectId: project.id, userId: member.userId });
          else if (prepared.kind === 'restore') this.db.restoreProjectAccess(prepared.id);
          member.accessId = prepared.id;
          this.db.db.prepare('UPDATE tasks SET assigned_access_id=?,blocked_reason=? WHERE workflow_run_id=? AND assignee_user_id=?')
            .run(prepared.id, 'WAITING_DEPENDENCIES', run.id, member.userId);
          // Internal preparation paths must never be returned in public run payloads.
          delete member.prepared;
        }
        this.db.setProjectRepoKind(project.id, 'git');
        this.db.db.prepare("UPDATE workflow_runs SET status='running',revision=revision+1,authorization_json=?,updated_at=? WHERE id=?")
          .run(JSON.stringify(authorization), new Date().toISOString(), run.id);
        this.db.db.prepare("UPDATE roadmaps SET status='active' WHERE id=?").run(run.roadmapId);
        this.store.event({ projectId: project.id, runId: run.id, type: 'workflow.running', payload: { count: authorization.members.length } });
        this.store.enqueue({ projectId: project.id, ownerId: run.ownerId, runId: run.id, generation: run.generation,
          type: 'workflow.reconcile', dedupeKey: `prepared:${run.id}:${run.generation}` });
      });
      return { members: authorization.members.length };
    } finally { this.codex.sharingAccesses.delete(project.accessId); }
  }
}
