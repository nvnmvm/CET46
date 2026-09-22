import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const adminApp = readFileSync(new URL('../src/AdminApp.tsx', import.meta.url), 'utf8');
const adminPage = readFileSync(new URL('../src/pages/AdminUsersPage.tsx', import.meta.url), 'utf8');
const adminHtml = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../../project/tooling/vite.config.mjs', import.meta.url), 'utf8');

test('管理员后台拥有独立页面入口，学习端只保留旧链接迁移提示', () => {
  assert.match(adminHtml, /src="\/src\/admin-main\.tsx"/);
  assert.match(viteConfig, /admin\.html/);
  assert.match(adminApp, /<AdminUsersPage/);
  assert.doesNotMatch(app, /import .*AdminUsersPage/);
  assert.match(app, /href="\/admin\.html"/);
});

test('管理员后台先校验权限，敏感操作使用可访问的模态确认框', () => {
  assert.match(adminApp, /apiClient\.adminStatus\(\)/);
  assert.match(adminApp, /此账号不能进入管理员后台/);
  assert.match(adminPage, /<ModalPortal>/);
  assert.match(adminPage, /role="dialog"/);
  assert.match(adminPage, /aria-modal="true"/);
  assert.match(adminPage, /modalManager\.register/);
});
