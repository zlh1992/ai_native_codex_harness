import { createHmac } from 'node:crypto';
import { invariant } from './errors.mjs';
import { checkOwner, desktopTarget } from './wechat-owner-library.mjs';
import { submitDesktopInput } from './desktop-task-queue.mjs';

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const reviewPath = '/boss/wechat-instruction';
const unavailable = () => invariant(false, 403, 'INSTRUCTION_UNAVAILABLE', '该任务当前不可接收指令。');
export function bossPortalUrl(config) {
  return config.bossPublicOrigin || config.publicOrigin || `http://127.0.0.1:${config.port}`;
}

function verifyPortalTarget(ctx, id) {
  const chat = ctx.db.getChat(id);
  const access = chat && ctx.db.getProjectForUser(chat.projectId, ctx.owner.id);
  if (!chat || chat.userId !== ctx.owner.id || !access || access.userId !== ctx.owner.id
    || access.accessKind !== 'owner' || access.accessId !== chat.projectAccessId) return unavailable();
  return chat;
}

function receipt(ctx, desktop, id, duplicate) {
  const text = desktop
    ? '在老板 Portal 核对并发送这条桌面指令：\n' + bossPortalUrl(ctx.config) + reviewPath + '?id=' + id
    : '指令已交给原 Portal 对话的输入队列。可用 /chat 查看原任务回复。';
  return { ok: true, status: 'completed', duplicate, text };
}

export async function acceptInstruction(ctx, command) {
  const policy = checkOwner(ctx);
  const { db, binding, externalScopeId, eventId } = ctx;
  const target = command.target;
  const desktop = target?.startsWith('d-');
  const id = desktop ? target.slice(2) : target;
  const prompt = command.relative?.trim();
  if (!uuid.test(id || '') || !prompt || command.page !== 1) return { ok: true, status: 'completed', text: '用法：/tell 对话ID 指令。发送 /chats 项目ID 获取对话ID。' };
  if (desktop) await desktopTarget(ctx, policy, target);
  else verifyPortalTarget(ctx, id);
  const marker = 'owner-task/' + createHmac('sha256', ctx.secret).update(externalScopeId + '\0' + ctx.text).digest('hex');
  db.db.exec('BEGIN IMMEDIATE');
  try {
    if (JSON.stringify(checkOwner(ctx)) !== JSON.stringify(policy)) return unavailable();
    const event = db.createChannelEvent({ channel: 'wechat', externalEventId: eventId, externalScopeId, chatId: binding.chatId });
    if (!event.created && (event.externalScopeId !== externalScopeId || event.chatId !== binding.chatId || event.responseText !== marker)) return unavailable();
    if (event.created) {
      if (desktop) {
        db.db.prepare('INSERT INTO wechat_desktop_instructions(event_id,owner_id,binding_id,thread_id,prompt) VALUES(?,?,?,?,?)')
          .run(event.id, ctx.owner.id, binding.id, id, prompt);
      } else {
        verifyPortalTarget(ctx, id);
        ctx.inputQueue.enqueue(id, { id: event.id, prompt });
      }
      db.completeChannelEvent('wechat', eventId, { responseText: marker });
    }
    db.db.exec('COMMIT');
    return receipt(ctx, desktop, event.id, !event.created);
  } catch (error) { db.db.exec('ROLLBACK'); throw error; }
}

// Kept separate from the relay. Only a fresh boss Web session can perform a desktop send.
export async function reviewDesktopInstruction({ config, db, authorize, id, send, deliver = submitDesktopInput }) {
  const current = () => {
    const owner = authorize();
    const row = db.db.prepare(`SELECT i.*,e.external_scope_id,e.chat_id FROM wechat_desktop_instructions i
      JOIN channel_events e ON e.id=i.event_id WHERE i.event_id=? AND i.owner_id=?`).get(id, owner.id);
    if (!row) return unavailable();
    const binding = db.getChannelBinding('wechat', row.external_scope_id);
    if (!binding || binding.id !== row.binding_id || binding.chatId !== row.chat_id) return unavailable();
    const project = db.getProjectForUser(binding.projectId, owner.id);
    if (!project) return unavailable();
    const ctx = { config, db, owner, project, binding, senderId: row.external_scope_id, externalScopeId: row.external_scope_id };
    return { ctx, policy: checkOwner(ctx), row };
  };
  const { ctx, policy, row } = current();
  const resolveTarget = () => desktopTarget(ctx, policy, 'd-' + row.thread_id);
  const target = await resolveTarget();
  function recheck() {
    const state = current();
    if (JSON.stringify(state.policy) !== JSON.stringify(policy)) return unavailable();
    return state.row;
  }
  const state = recheck();
  if (!send || state.status !== 'pending') return { title: target.title, threadId: row.thread_id, prompt: state.prompt, status: state.status };
  let claimed = false;
  try {
    const status = await deliver({ target, prompt: row.prompt, requestId: id,
      revalidate: async () => {
        if (JSON.stringify(await resolveTarget()) !== JSON.stringify(target)) return unavailable();
        recheck();
      },
      claimed: () => {
        recheck();
        const result = db.db.prepare("UPDATE wechat_desktop_instructions SET status='uncertain',prompt='' WHERE event_id=? AND status='pending'").run(id);
        invariant(result.changes === 1, 409, 'INSTRUCTION_ALREADY_SENT', '指令已被处理，请刷新。');
        claimed = true;
      },
    });
    invariant(claimed && ['queued', 'queued_waiting'].includes(status), 502, 'DESKTOP_QUEUE_UNCONFIRMED', '投递状态待核对。');
    db.db.prepare('UPDATE wechat_desktop_instructions SET status=? WHERE event_id=?').run(status, id);
    return { status };
  } catch {
    if (claimed) return { status: 'uncertain' };
    invariant(false, 409, 'DESKTOP_UNAVAILABLE', '桌面任务暂不可接收。请核对任务状态后再发送。');
  }
}
