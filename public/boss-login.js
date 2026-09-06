const form = document.querySelector('#login-form');
const errorLabel = document.querySelector('#login-error');
async function checkSession() {
  const response = await fetch('/api/me');
  if (response.ok && (await response.json()).user.role === 'admin') location.replace('/boss');
}
checkSession().catch(() => {});
fetch('/api/health').then((response) => response.json()).then((data) => {
  document.querySelector('#login-health').textContent = data.codex ? '本机 Codex 在线' : 'Codex 正在启动';
}).catch(() => { document.querySelector('#login-health').textContent = '无法连接本机服务'; });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorLabel.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/boss/login', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || '登录失败');
    form.elements.password.value = '';
    location.replace('/boss');
  } catch (error) { errorLabel.textContent = error.message; }
  finally { button.disabled = false; }
});
