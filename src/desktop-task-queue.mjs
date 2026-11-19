import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

// Use only the signed-in desktop user's local daemon. The HTTP client selects no RPC or endpoint.
export async function submitDesktopInput({ target, prompt, requestId, revalidate, claimed }) {
  const socketPath = path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
  const st = fs.lstatSync(socketPath);
  if (!st.isSocket() || st.uid !== process.getuid()) throw new Error('DESKTOP_UNAVAILABLE');
  const socket = new WebSocket('ws+unix://' + socketPath + ':/', { handshakeTimeout: 4000, maxPayload: 8 * 1024 * 1024 });
  let seq = 0;
  let pending;
  const closed = () => pending?.reject(new Error('DESKTOP_UNAVAILABLE'));
  socket.on('error', closed);
  socket.on('close', closed);
  socket.on('message', bytes => {
    let msg;
    try { msg = JSON.parse(bytes); } catch { return; }
    if (msg.id !== pending?.id || !pending) return;
    if (msg.error) pending.reject(new Error('DESKTOP_REJECTED'));
    else pending.resolve(msg.result);
  });
  function request(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending = { id, resolve, reject };
      socket.send(JSON.stringify({ id, method, params }), error => { if (error) reject(error); });
    });
  }
  const timeout = setTimeout(() => socket.terminate(), 18000);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('DESKTOP_UNAVAILABLE')));
    });
    await request('initialize', { clientInfo: { name: 'wechat_owner_portal', version: '1.0' }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized' }));
    const { thread } = await request('thread/read', { threadId: target.id, includeTurns: false });
    if (thread.id !== target.id || thread.cwd !== target.cwd || thread.path !== target.file
      || thread.source !== 'vscode' || thread.originator !== 'Codex Desktop' || thread.canAcceptDirectInput === false) throw new Error('DESKTOP_REJECTED');
    // Compare the session, binding, source metadata and request state immediately before dispatch.
    await revalidate();
    claimed();
    const input = [{ type: 'text', text: prompt, text_elements: [] }];
    const added = await request('thread/queue/add', { threadId: target.id, clientUserMessageId: requestId, input });
    if (added?.queuedSubmission?.clientUserMessageId !== requestId) throw new Error('DESKTOP_UNCERTAIN');
    // Native queue semantics: a loaded task consumes its own queue. Wake an unloaded task
    // only after this submission has been acknowledged, without changing its permissions.
    if (thread.status?.type === 'notLoaded') {
      try {
        await revalidate();
        const resumed = await request('thread/resume', { threadId: target.id, excludeTurns: true });
        if (resumed?.thread?.id !== target.id) return 'queued_waiting';
      } catch { return 'queued_waiting'; }
    }
    return 'queued';
  } finally {
    clearTimeout(timeout);
    socket.terminate();
  }
}
