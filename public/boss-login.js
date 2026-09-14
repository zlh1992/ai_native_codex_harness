import { safeReturnTo, defaultPage } from './navigation.js';
import { createSessionClient, setAuthState, watchSession } from './session-ui.js';
const form = document.querySelector('#login-form');
const errorLabel = document.querySelector('#login-error');
const client = createSessionClient({ getCsrf: () => '', onExpired: () => setAuthState('guest') });
let checking = false;
function destination() {
  const params = new URLSearchParams(location.search);
  return safeReturnTo(params.get('returnTo') || `/boss/workbench?${params}`, 'admin');
}
async function checkSession() {
  if (checking) return;
  checking = true; setAuthState('checking');
  try {
    const data = await client.request('/api/me', { sessionCheck: true, timeoutMs: 12_000 });
    location.replace(data.user.role === 'admin' ? destination() : defaultPage('user'));
  } catch (error) {
    if (error.status === 401) setAuthState('guest');
    else setAuthState('error', '暂时无法连接服务，登录状态尚未确认。请重试，无需重新输入密码。', checkSession);
  } finally { checking = false; }
}
const changes = watchSession(checkSession);
checkSession();
fetch('/api/health').then((response) => response.json()).then((data) => {
  document.querySelector('#login-health').textContent = data.codex ? '本机 Codex 在线' : 'Codex 正在启动';
}).catch(() => { document.querySelector('#login-health').textContent = '无法连接本机服务'; });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorLabel.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await client.request('/api/boss/login', { method: 'POST',
      body: { username: form.elements.username.value, password: form.elements.password.value } });
    form.elements.password.value = '';
    changes.announce(); location.replace(destination());
  } catch (error) { errorLabel.textContent = error.message; }
  finally { button.disabled = false; }
});
