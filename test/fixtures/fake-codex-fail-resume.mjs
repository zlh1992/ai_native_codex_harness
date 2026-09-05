#!/usr/bin/env node

process.env.FAKE_FAIL_RESUME = '1';
await import('./fake-codex.mjs');
