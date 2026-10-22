import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { WeixinRelay } from './weixin-relay.mjs';
import { invariant } from './errors.mjs';
import { MATERIAL_LIMIT, materialName } from './task-materials.mjs';
import { parseWechatCommand, formatWechatModelCatalog, resolveWechatModel } from './wechat-channel-commands.mjs';
import { weixinAttachment, weixinAttachmentName } from './weixin-media.mjs';

const now = () => new Date().toISOString();
const key = value => createHash('sha256').update(value).digest('hex');
export class WeixinService {
  constructor({ config, db, materials, dispatch, graphs, store, codex, relayFactory = options => new WeixinRelay(options) }) {
    Object.assign(this, { config, db, materials, dispatch, graphs, store, codex, relayFactory }); this.sql = db.db;
    this.root = path.join(config.dataDir, 'weixin'); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.relays = new Map(); this.polling = new Set(); this.working = new Set(); this.sending = new Set(); this.logins = new Set(); this.qrs = new Map(); this.nextPoll = new Map();
  }
  enabledFor(userId) { return this.config.weixinEnabled && (!this.config.weixinPilotUserIds?.length || this.config.weixinPilotUserIds.includes(userId)); }
  connection(id) { return this.sql.prepare('SELECT * FROM weixin_connections WHERE id=?').get(id); }
  current(userId) { return this.sql.prepare("SELECT * FROM weixin_connections WHERE user_id=? AND status!='revoked'").get(userId); }
  folder(id) { invariant(/^[a-f0-9-]{36}$/.test(id), 400, 'CONNECTION_INVALID', '连接标识无效。'); const dir = path.join(this.root, id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
  secret(row) { try { return JSON.parse(fs.readFileSync(path.join(this.folder(row.id), 'credentials.json'), 'utf8')); } catch { return {}; } }
  saveSecret(row, data) { const dir = this.folder(row.id); fs.writeFileSync(path.join(dir, 'credentials.tmp'), JSON.stringify(data), { mode: 0o600 }); fs.renameSync(path.join(dir, 'credentials.tmp'), path.join(dir, 'credentials.json')); }
  check(row, { generation = row?.generation, pending = false } = {}) {
    const live = row && this.connection(row.id), user = live && this.db.getUserById(live.user_id);
    invariant(this.enabledFor(live?.user_id) && user?.status === 'active' && user.networkAccess, 403, 'WEIXIN_NETWORK_DISABLED', '当前账号不能使用微信联网，请由老板开启联网权限。');
    invariant(live && live.generation === generation && (live.status === 'active' || (pending && live.status === 'pending')),
      409, 'WEIXIN_CONNECTION_CHANGED', '微信连接已变化，请刷新。');
    invariant(live.credential_epoch === this.store.policyEpoch(user.id), 403, 'WEIXIN_POLICY_CHANGED', '账号策略已变化，旧消息不会自动执行。');
    const project = this.materials.access(user.id, live.project_id, live.access_id);
    return { row: live, user, project };
  }
  public(userId) {
    const row = this.current(userId); if (!row) return { connection: null };
    let available = true, errorCode = null;
    try { this.check(row, { pending: true }); } catch (error) { available = false; errorCode = error.code; }
    const project = this.db.getProjectForUser(row.project_id, userId), user = this.db.getUserById(userId);
    const recent = this.sql.prepare('SELECT status,error_code AS errorCode,created_at AS createdAt FROM weixin_outbox WHERE connection_id=? ORDER BY created_at DESC LIMIT 5').all(row.id);
    return { connection: { id: row.id, status: row.status === 'expired' ? 'expired' : available ? (row.status === 'active' && row.last_error_code ? 'reconnecting' : row.status) : 'blocked', lastPollAt: row.last_poll_at, errorCode: errorCode || row.last_error_code, identity: user.displayName,
      projectId: project?.id || null, projectName: project?.name || '授权已失效', chatId: row.chat_id,
      taskId: row.chat_id ? this.db.getChat(row.chat_id)?.taskId : null,
      qr: this.qrs.get(row.id)?.image || null, expiresAt: this.qrs.get(row.id)?.expiresAt || null, deliveries: recent } };
  }
  relay(row) {
    let relay = this.relays.get(row.id);
    if (relay?.child && !relay.child.connected) { relay.stop(); this.relays.delete(row.id); relay = null; }
    if (!relay) { relay = this.relayFactory({ home: this.folder(row.id), proxyMode: this.config.outboundProxy }); this.relays.set(row.id, relay); }
    return relay;
  }
  revoke(userId) {
    const row = this.current(userId); if (!row) return;
    this.sql.prepare("UPDATE weixin_connections SET status='revoked',generation=generation+1,updated_at=? WHERE id=?").run(now(), row.id);
    this.invalidate(row); for (const name of ['credentials.json', 'credentials.tmp']) fs.rmSync(path.join(this.folder(row.id), name), { force: true }); this.qrs.delete(row.id);
  }
  invalidate(row) {
    this.relays.get(row.id)?.stop(); this.relays.delete(row.id);
    this.sql.prepare("UPDATE weixin_inbox SET status='cancelled',error_code='CONNECTION_CHANGED' WHERE connection_id=? AND status='queued'").run(row.id);
    this.sql.prepare("UPDATE weixin_outbox SET status='cancelled',error_code='CONNECTION_CHANGED',updated_at=? WHERE connection_id=? AND status='queued'").run(now(), row.id);
    if (row.chat_id && this.working.has(row.id)) void this.codex.interrupt(row.chat_id).catch(() => {});
  }
  bindable(project, user) {
    if (user.role === 'admin') invariant(project.accessKind === 'owner'
      && !this.db.listProjectAccess(project.id, { activeOnly: true }).some(a => a.accessKind === 'shared'),
    409, 'WEIXIN_INBOX_SHARED', '老板微信收件请选择尚未共享的自有普通项目；派发时系统会另建协作项目。');
  }
  bind(userId, projectId, authorize = () => {}) {
    invariant(this.enabledFor(userId) && this.config.taskDispatchEnabled, 404, 'WEIXIN_DISABLED', '微信入口尚未启用。');
    const project = this.materials.access(userId, projectId), user = this.db.getUserById(userId);
    invariant(user.networkAccess, 403, 'WEIXIN_NETWORK_DISABLED', '请先由老板开启联网权限。');
    this.bindable(project, user); this.revoke(userId);
    const id = randomUUID();
    this.sql.prepare('INSERT INTO weixin_connections(id,user_id,project_id,access_id,credential_epoch,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, project.id, project.accessId, this.store.policyEpoch(userId), now(), now());
    void this.login(this.connection(id), authorize); return this.public(userId);
  }
  async login(row, authorize = () => {}) {
    const check = () => { authorize(); return this.check(row, { pending: true }); };
    this.logins.add(row.id);
    try {
      check();
      const qr = await this.relay(row).request('qr'); check();
      invariant(qr.qrcode && qr.qrcode_img_content, 502, 'WEIXIN_QR_FAILED', '微信未返回二维码。');
      const expiresAt = Date.now() + 480_000;
      const image = await QRCode.toDataURL(String(qr.qrcode_img_content), { width: 280, margin: 2 }); check();
      this.qrs.set(row.id, { image, expiresAt }); let baseUrl = 'https://ilinkai.weixin.qq.com';
      while (Date.now() < expiresAt && !this.stopping) {
        check();
        const result = await this.relay(row).request('qrStatus', { qrcode: qr.qrcode, baseUrl }); check();
        if (result.status === 'confirmed') {
          invariant(result.ilink_bot_id && result.bot_token && result.ilink_user_id, 502, 'WEIXIN_BIND_FAILED', '微信身份确认失败。');
          invariant(!this.sql.prepare("SELECT id FROM weixin_connections WHERE account_id=? AND status='active'").get(result.ilink_bot_id),
            409, 'WEIXIN_ALREADY_BOUND', '该微信已绑定其他平台账号，请先解绑。');
          this.saveSecret(row, { baseUrl: result.baseurl || baseUrl, token: result.bot_token, cursor: '', contextToken: null });
          this.sql.prepare("UPDATE weixin_connections SET status='active',account_id=?,sender_id=?,updated_at=? WHERE id=? AND generation=?")
            .run(result.ilink_bot_id, result.ilink_user_id, now(), row.id, row.generation);
          this.qrs.delete(row.id); return;
        }
        if (result.status === 'expired') break;
        if (result.status === 'scaned_but_redirect' && result.redirect_host) baseUrl = `https://${result.redirect_host}`;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('WEIXIN_QR_EXPIRED');
    } catch { if (this.connection(row.id)?.status === 'pending') this.sql.prepare("UPDATE weixin_connections SET status='expired',updated_at=? WHERE id=?").run(now(), row.id); }
    finally { this.qrs.delete(row.id); this.logins.delete(row.id); }
  }
  switchProject(userId, projectId) {
    const row = this.current(userId); this.check(row);
    invariant(!this.working.has(row.id) && !this.sql.prepare("SELECT 1 FROM weixin_inbox WHERE connection_id=? AND status='queued'").get(row.id),
      409, 'WEIXIN_BUSY', '当前微信消息尚未处理完，请稍后切换。');
    const project = this.materials.access(userId, projectId);
    this.bindable(project, this.db.getUserById(userId));
    this.invalidate(row);
    this.sql.prepare('UPDATE weixin_connections SET project_id=?,access_id=?,chat_id=NULL,generation=generation+1,updated_at=? WHERE id=?')
      .run(project.id, project.accessId, now(), row.id); return this.public(userId);
  }
  start() {
    if (this.timer || !this.config.weixinEnabled) return;
    this.sql.prepare("UPDATE weixin_connections SET status='expired' WHERE status='pending'").run();
    this.sql.prepare("UPDATE weixin_inbox SET status='uncertain',error_code='RESTART_INTERRUPTED' WHERE status='processing'").run();
    this.sql.prepare("UPDATE weixin_outbox SET status='uncertain',error_code='RESTART_INTERRUPTED' WHERE status='sending'").run();
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.(); this.tick();
  }
  stop() { this.stopping = true; clearInterval(this.timer); this.timer = null; for (const relay of this.relays.values()) relay.stop(); this.relays.clear(); this.qrs.clear(); }
  tick() {
    if (this.stopping) return;
    for (let row of this.sql.prepare("SELECT * FROM weixin_connections WHERE status='active'").all()) {
      if (row.credential_epoch !== this.store.policyEpoch(row.user_id)) {
        this.invalidate(row);
        this.sql.prepare('UPDATE weixin_connections SET generation=generation+1,credential_epoch=?,updated_at=? WHERE id=?').run(this.store.policyEpoch(row.user_id), now(), row.id);
        row = this.connection(row.id);
      }
      try { this.check(row); } catch { this.invalidate(row); continue; }
      if (!this.polling.has(row.id) && Date.now() >= (this.nextPoll.get(row.id) || 0)) void this.poll(row);
      if (!this.working.has(row.id)) void this.process(row);
      if (!this.sending.has(row.id)) void this.deliver(row).catch(() => {});
    }
  }
  async poll(row) {
    this.polling.add(row.id);
    try {
      this.check(row); const credentials = this.secret(row);
      const result = await this.relay(row).request('poll', credentials); this.check(row);
      invariant(!result.ret && !result.errcode, 502, 'WEIXIN_POLL_FAILED', '微信连接需要重新扫码。');
      for (const message of result.msgs || []) {
        if (message.from_user_id !== row.sender_id || message.message_type !== 1 || !message.message_id) continue;
        const payload = JSON.stringify(message); if (Buffer.byteLength(payload) > 256 * 1024) continue;
        this.sql.prepare('INSERT OR IGNORE INTO weixin_inbox(connection_id,generation,external_id,project_id,payload_json,created_at) VALUES (?,?,?,?,?,?)')
          .run(row.id, row.generation, String(message.message_id), row.project_id, payload, now());
        if (message.context_token) credentials.contextToken = message.context_token;
      }
      credentials.cursor = result.get_updates_buf || credentials.cursor; this.saveSecret(row, credentials);
      this.sql.prepare('UPDATE weixin_connections SET last_poll_at=?,last_error_code=NULL WHERE id=? AND generation=?').run(now(), row.id, row.generation);
    } catch (error) {
      this.nextPoll.set(row.id, Date.now() + 5000);
      this.sql.prepare('UPDATE weixin_connections SET last_error_code=? WHERE id=? AND generation=?').run(error.code || 'WEIXIN_OFFLINE', row.id, row.generation);
      if (error.code === 'WEIXIN_POLL_FAILED' && this.connection(row.id)?.generation === row.generation) { this.invalidate(row); this.sql.prepare("UPDATE weixin_connections SET status='expired' WHERE id=?").run(row.id); }
    }
    finally { this.polling.delete(row.id); }
  }
  chat(row, project, user) {
    let chat = row.chat_id && this.db.getChat(row.chat_id);
    if (chat) invariant(chat.userId === user.id && chat.projectAccessId === project.accessId && !chat.archivedAt, 409, 'WEIXIN_CHAT_UNAVAILABLE', '当前对话已归档或不可访问，请切换项目。');
    if (!chat) {
      chat = this.db.createChat({ projectId: project.id, userId: user.id, projectAccessId: project.accessId, treePath: project.treePath,
        title: '微信对话', preferredMode: 'execute' });
      this.sql.prepare('UPDATE weixin_connections SET chat_id=? WHERE id=?').run(chat.id, row.id);
    }
    return chat;
  }
  async process(row) {
    const message = this.sql.prepare("SELECT * FROM weixin_inbox WHERE connection_id=? AND status='queued' ORDER BY id LIMIT 1").get(row.id);
    if (!message) return;
    this.working.add(row.id); let marked = false;
    try {
      const { project, user } = this.check(row, { generation: message.generation });
      if (this.codex.workspaceBusy(project.accessId)) return;
      let chat = this.chat(this.connection(row.id), project, user);
      this.sql.prepare("UPDATE weixin_inbox SET status='processing',chat_id=? WHERE id=?").run(chat.id, message.id); marked = true;
      const payload = JSON.parse(message.payload_json), items = payload.item_list || [];
      const text = items.filter(i => i.type === 1).map(i => i.text_item?.text || '').join('\n').trim();
      const fileItems = items.filter(i => [2, 4].includes(i.type)).map(weixinAttachment);
      invariant(fileItems.length <= 30 && fileItems.reduce((n, f) => n + Number(f?.len || 0), 0) <= MATERIAL_LIMIT,
        413, 'MATERIAL_LIMIT', '每批最多 30 份资料、50 MiB。');
      const files = []; let size = 0;
      for (let index = 0; index < fileItems.length; index++) {
        const file = fileItems[index]; if (file.kind === 'file') materialName(file.file_name); this.check(row);
        const result = await this.relay(row).request('download', { file }); this.check(row);
        const bytes = Buffer.from(result.bytes, 'base64'); size += bytes.length;
        invariant(size <= MATERIAL_LIMIT, 413, 'MATERIAL_LIMIT', '资料超过 50 MiB。');
        files.push(this.materials.storeFile({ userId: user.id, projectId: project.id, chatId: chat.id, bytes, name: weixinAttachmentName(file, bytes, index),
          idempotencyKey: key(`${row.id}:${message.external_id}:${index}`) }));
      }
      if (files.length && user.role !== 'admin') this.materials.importFiles(project, files);
      if (files.length) this.db.addMessage({ id: `weixin-files:${message.id}`, chatId: chat.id, role: 'user', kind: 'material_receipt',
        content: `微信资料已接收，尚未派发：\n${files.map(f => `${f.name} · ${f.size} B · ${f.path} · 资料 ID ${f.id} · SHA-256 ${f.sha256}`).join('\n')}` });
      let response;
      const taskCommand = text.match(/^(?:处理任务\s*|\/task\s+)([a-f0-9-]{36})$/i);
      const command = parseWechatCommand(text);
      if (taskCommand) {
        invariant(!files.length, 400, 'WEIXIN_SWITCH_WITH_FILES', '资料已留在原项目；请单独发送处理任务指令，避免归属不清。');
        const { task } = this.graphs.taskFor(taskCommand[1], user.id);
        invariant(['active', 'rework'].includes(task.status), 409, 'TASK_NOT_ACTIVE', '任务正在等待前置任务或已提交、结束。');
        const target = this.materials.access(user.id, task.projectId, task.assignedAccessId);
        chat = this.db.listChats({ projectId: target.id, userId: user.id }).find(c => c.taskId === task.id && c.taskVersion === task.version && c.projectAccessId === target.accessId && !c.archivedAt)
          || this.db.createChat({ projectId: target.id, userId: user.id, projectAccessId: target.accessId, treePath: target.treePath, title: `任务 · ${task.title}`.slice(0, 120), taskId: task.id, taskVersion: task.version });
        this.sql.prepare('UPDATE weixin_connections SET project_id=?,access_id=?,chat_id=? WHERE id=?').run(target.id, target.accessId, chat.id, row.id);
        response = `已切换到项目「${target.name}」的任务「${task.title}」。后续消息进入该任务对话；尚未调用模型。`;
      } else if (command) {
        if (command.type === 'models') response = formatWechatModelCatalog({ config: this.config, chat, user });
        if (command.type === 'model') { this.db.updateChat(chat.id, { preferredModel: resolveWechatModel(command.value) }); response = '当前微信对话模型已更新。'; }
        if (command.type === 'new') { invariant(!chat.taskId, 409, 'TASK_CHAT_REQUIRED', '任务对话请从任务入口进入；切换普通项目可开始普通对话。'); this.sql.prepare('UPDATE weixin_connections SET chat_id=NULL WHERE id=?').run(row.id); response = '已开启新的普通对话，历史已保留。'; }
      } else if (items.some(i => ![1, 2, 4].includes(i.type))) response = '此消息包含暂不支持的语音或视频，请转为文字或原始文件发送。文字任务尚未执行。';
      else if (!text) response = files.length ? `已收到 ${files.length} 份资料：${files.map(f => f.name).join('、')}。尚未派发，请明确说明交给谁、做什么。`
        : '目前支持文字、图片和原始文件附件。';
      else {
        this.check(row);
        if (chat.taskId) this.graphs.taskFor(chat.taskId, user.id);
        const result = await this.codex.runTurn({ chat, project, user, prompt: text, mode: 'execute', effort: chat.preferredEffort || undefined, emit: (_event, data) => {
          if (data?.turnRunId) this.sql.prepare('UPDATE weixin_inbox SET turn_run_id=? WHERE id=?').run(data.turnRunId, message.id);
        } });
        this.check(row); response = String(result?.text || '本轮结束，请打开前端查看结果。');
      }
      this.sql.prepare("UPDATE weixin_inbox SET status='completed',response_text=? WHERE id=?").run(response, message.id);
      this.queue(row, { dedupeKey: `reply:${message.id}`, inboxId: message.id });
    } catch (error) {
      if (marked) {
        this.sql.prepare("UPDATE weixin_inbox SET status='failed',error_code=?,response_text=? WHERE id=?")
          .run(error.code || 'WEIXIN_PROCESS_FAILED', '消息未完成，请在前端查看当前对话。系统不会自动重复执行。', message.id);
        try { this.check(row); this.queue(row, { dedupeKey: `reply:${message.id}`, inboxId: message.id }); } catch { /* revoked */ }
      } else this.sql.prepare("UPDATE weixin_inbox SET status='cancelled',error_code=? WHERE id=?").run(error.code || 'WEIXIN_FORBIDDEN', message.id);
    } finally { this.working.delete(row.id); }
  }
  queue(row, { dedupeKey, taskId = null, notificationId = null, inboxId = null, dispatchId = null }) {
    this.sql.prepare('INSERT OR IGNORE INTO weixin_outbox(id,connection_id,dedupe_key,task_id,notification_id,inbox_id,dispatch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), row.id, dedupeKey, taskId, notificationId, inboxId, dispatchId, now(), now());
  }
  notificationText(row, notification) {
    const { task } = this.materials.taskAccess(notification.task_id, row.user_id);
    invariant(task.assigneeUserId === row.user_id && task.version === notification.task_version && !['passed', 'cancelled', 'superseded'].includes(task.status),
      409, 'TASK_STALE', '任务已变化。');
    const project = this.db.getProjectForUser(task.projectId, row.user_id);
    const origin = this.config.employeePublicOrigin || this.config.publicOrigin;
    invariant(origin, 503, 'WEIXIN_PUBLIC_URL_MISSING', '未配置员工公网地址。');
    return `项目「${project.name}」\n${notification.kind === 'materials' ? '任务资料已补充' : notification.kind === 'ready' ? '前置任务已完成，可以处理' : '收到任务'}：${task.title}\n${task.acceptance.slice(0, 400)}\n${task.status === 'ready' ? '等待前置任务或准备完成。\n' : ''}查看任务：${origin}/employee?view=tasks&task=${task.id}\n微信处理可回复：处理任务 ${task.id}`;
  }
  async deliver(row) {
    this.sending.add(row.id);
    try {
      this.check(row);
      for (const n of this.sql.prepare('SELECT * FROM task_notifications WHERE user_id=? AND created_at>=?').all(row.user_id, row.created_at))
        this.queue(row, { dedupeKey: `notice:${n.id}`, notificationId: n.id, taskId: n.task_id });
      for (const d of this.sql.prepare("SELECT id FROM task_dispatches WHERE owner_id=? AND status='published' AND created_at>=?").all(row.user_id, row.created_at))
        this.queue(row, { dedupeKey: `dispatch:${d.id}`, dispatchId: d.id });
      const item = this.sql.prepare("SELECT * FROM weixin_outbox WHERE connection_id=? AND status='queued' ORDER BY created_at LIMIT 1").get(row.id);
      if (!item) return;
      let text;
      try {
        if (item.notification_id) text = this.notificationText(row, this.sql.prepare('SELECT * FROM task_notifications WHERE id=?').get(item.notification_id));
        else if (item.dispatch_id) { const receipt = this.dispatch.receipt(item.dispatch_id, row.user_id); text = `任务已发布：${receipt.title}\n项目：${receipt.projectName}\n附件：${receipt.attachmentCount} 份\n${receipt.tasks.map(t => `${t.employee} · ${t.title} · 微信：${t.weixin}`).join('\n')}`; }
        else { const message = this.sql.prepare('SELECT * FROM weixin_inbox WHERE id=?').get(item.inbox_id); invariant(message?.generation === row.generation, 403, 'WEIXIN_STALE_REPLY', '旧连接回复已失效。'); text = message.response_text; }
        this.check(row);
      } catch { this.sql.prepare("UPDATE weixin_outbox SET status='cancelled',error_code='AUTHORIZATION_CHANGED',updated_at=? WHERE id=?").run(now(), item.id); return; }
      const credentials = this.secret(row);
      // Proactive messages require a usable Weixin context, never fabricate one.
      if (!credentials.contextToken) return;
      this.sql.prepare("UPDATE weixin_outbox SET status='sending',updated_at=? WHERE id=? AND status='queued'").run(now(), item.id);
      try {
        this.check(row);
        const result = await this.relay(row).request('send', { ...credentials, senderId: row.sender_id, clientId: item.id,
          text: text.length > 3500 ? `${text.slice(0, 3400)}\n完整结果请在前端查看。` : text });
        // The pinned transport omits default-zero result codes on successful sends.
        const valid = result && typeof result === 'object' && !Array.isArray(result);
        const ret = Number(result?.ret ?? 0), errcode = Number(result?.errcode ?? 0);
        const known = valid && Number.isFinite(ret) && Number.isFinite(errcode);
        const status = !known ? 'uncertain' : ret || errcode ? 'failed' : 'sent';
        this.sql.prepare('UPDATE weixin_outbox SET status=?,error_code=?,updated_at=? WHERE id=?')
          .run(status, status === 'sent' ? null : status === 'failed' ? 'WEIXIN_REJECTED' : 'DELIVERY_UNCONFIRMED', now(), item.id);
      } catch { this.sql.prepare("UPDATE weixin_outbox SET status='uncertain',error_code='DELIVERY_UNCERTAIN',updated_at=? WHERE id=?").run(now(), item.id); }
    } finally { this.sending.delete(row.id); }
  }
}
