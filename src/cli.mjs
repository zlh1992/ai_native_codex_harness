#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hashPassword } from './auth.mjs';
import { loadConfig, ROOT_DIR } from './config.mjs';
import { HarnessDatabase } from './db.mjs';
import { WorkspaceService } from './fs-service.mjs';

function loadDotEnv() {
  const file = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

async function hiddenQuestion(prompt) {
  if (!stdin.isTTY) return String(process.env.CODEX_HARNESS_ADMIN_PASSWORD || '');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (character) => {
      if (character === '\r' || character === '\n') {
        stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); resolve(value);
      } else if (character === '\u0003') {
        stdin.setRawMode(false); process.exit(130);
      } else if (character === '\u007f') value = value.slice(0, -1);
      else value += character;
    };
    stdin.on('data', onData);
  });
}

loadDotEnv();
process.umask(0o077);
const config = loadConfig();
const db = new HarnessDatabase(config);
const workspace = new WorkspaceService(config);
const command = process.argv[2];

try {
  if (command === 'create-admin') {
    const usernameArg = process.argv.find((value) => value.startsWith('--username='));
    let username = usernameArg?.slice('--username='.length) || '';
    if (!username && stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      username = await rl.question('超级管理员用户名: ');
      rl.close();
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username)) throw new Error('用户名须为 3–32 位字母、数字、点、下划线或连字符。');
    if (db.getUserAuthByUsername(username)) throw new Error('用户名已存在。');
    const password = await hiddenQuestion('超级管理员密码（至少 12 位）: ');
    const confirmation = stdin.isTTY ? await hiddenQuestion('再次输入密码: ') : password;
    if (password !== confirmation) throw new Error('两次输入的密码不一致。');
    const user = db.createUser({
      username, displayName: '超级管理员', passwordHash: await hashPassword(password), role: 'admin',
      networkAccess: true, maxProjects: 1000, maxStorageBytes: 1024 * 1024 * 1024 * 1024,
      maxConcurrentTurns: config.codexMaxConcurrentTurns,
    });
    workspace.ensureUserRoot(user.id);
    db.audit({ actorUserId: user.id, action: 'admin.create_cli', targetType: 'user', targetId: user.id, detail: { username } });
    stdout.write(`超级管理员已创建: ${username}\n`);
  } else if (command === 'reset-password') {
    const usernameArg = process.argv.find((value) => value.startsWith('--username='));
    const username = usernameArg?.slice('--username='.length) || '';
    const row = db.getUserAuthByUsername(username);
    if (!row) throw new Error('用户不存在。');
    const password = await hiddenQuestion('新密码（至少 12 位）: ');
    const confirmation = stdin.isTTY ? await hiddenQuestion('再次输入密码: ') : password;
    if (password !== confirmation) throw new Error('两次输入的密码不一致。');
    db.updateUser(row.id, { passwordHash: await hashPassword(password) });
    db.deleteUserSessions(row.id);
    db.audit({ actorUserId: row.id, action: 'password.reset_cli', targetType: 'user', targetId: row.id });
    stdout.write(`密码已重置: ${username}\n`);
  } else if (command === 'list-users') {
    stdout.write(`${JSON.stringify(db.listUsers(), null, 2)}\n`);
  } else {
    stdout.write('用法:\n  node src/cli.mjs create-admin --username=superadmin\n  node src/cli.mjs reset-password --username=superadmin\n  node src/cli.mjs list-users\n');
    process.exitCode = command ? 2 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
