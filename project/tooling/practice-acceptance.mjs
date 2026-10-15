/** UI acceptance against preview-fixture.mjs only. Never target a deployed site. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const modulePath = process.env.CET_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(modulePath);
const { expect } = require(`${modulePath}/test`);
const origin = 'http://127.0.0.1:5177';
const output = process.env.CET_ACCEPTANCE_OUTPUT || '/tmp/cet-practice-acceptance';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CET_CHROME_PATH ? { executablePath: process.env.CET_CHROME_PATH } : {}),
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const checks = [];
const passed = name => { checks.push(name); console.log(`PASS ${name}`); };
const capture = async name => {
  // Visibility assertions do not wait for opacity animations or view snapshots.
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
  await page.screenshot({ path: join(output, name), fullPage: true, animations: 'disabled' });
};
const api = async (path, options = {}) => {
  const response = await context.request.fetch(`${origin}${path}`, {
    ...options, headers: { origin, ...options.headers },
  });
  assert.ok(response.ok(), `${options.method || 'GET'} ${path}: ${response.status()}`);
  return response.status() === 204 ? null : response.json();
};
const progressSnapshot = async () => {
  const words = (await api('/api/words')).words;
  return JSON.stringify(words.map(({ id, progress }) => ({ id, progress })));
};
const action = () => page.locator('.practice-spelling-card button[type="submit"]');
const input = () => page.getByLabel('英文拼写', { exact: true });
const currentWord = words => {
  return page.locator('.practice-spelling-card h1').innerText().then(meaning => {
    const entry = words.find(word => word.meaning === meaning);
    assert.ok(entry, `Unknown prompt: ${meaning}`);
    return entry.word;
  });
};

try {
  await mkdir(output, { recursive: true });
  const email = `practice-${Date.now()}@example.test`;
  const password = 'Preview-only-2026';
  await api('/api/auth/login', { method: 'POST', data: { email: 'admin@example.test', password } });
  await api('/api/admin/users', { method: 'POST', data: { email, username: '练习体验验收', password } });
  await api('/api/auth/logout', { method: 'POST' });
  await page.goto(`${origin}/#/login`);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '加载示例', exact: true }).click();
  await page.getByRole('link', { name: /开始新学/ }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
  await page.getByRole('button', { name: /开始学习本组/ }).click();
  await expect(page.locator('.practice-session h1')).toBeFocused();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}`);
    await capture(`new-study-${width}.png`);
  }
  passed('focus layout, new-study focus, and 320/390/1440px widths');
  await page.setViewportSize({ width: 390, height: 844 });
  for (let index = 0; index < 3; index++) {
    const label = index === 2 ? '完成本组新学' : '已了解，下一个词';
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '已认识 3 个新词' })).toBeVisible();
  await expect(page.getByRole('link', { name: '拼写今天新学的词', exact: true })).toBeVisible();
  // Let the onFinished refresh finish, then ensure the completion panel survived.
  await expect(page.getByRole('status').filter({ hasText: '正在更新学习数据' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '已认识 3 个新词' })).toBeVisible();
  let words = (await api('/api/words')).words;
  assert.ok(words.every(word => word.progress.firstLearnedAt && word.progress.recognitionScore === 0 && word.progress.spellingScore === 0));
  passed('new-study completion survives refresh and preserves score semantics');

  await page.getByRole('link', { name: '拼写今天新学的词', exact: true }).click();
  await page.getByRole('button', { name: /开始拼写 3 个词/ }).click();
  await expect(input()).toBeFocused();
  const originalInput = await input().elementHandle();
  const originalY = (await action().boundingBox()).y;
  await input().dispatchEvent('compositionstart');
  await input().press('Enter');
  await expect(input()).toBeEditable();
  await input().dispatchEvent('compositionend');
  await input().fill('incorrect-answer');
  await input().press('Enter');
  await expect(page.getByText('还差一点，再记一次', { exact: true })).toBeVisible();
  assert.ok(await originalInput.evaluate(el => el.isConnected), 'Input was unmounted after submit');
  assert.ok(Math.abs((await action().boundingBox()).y - originalY) <= 2, 'Short feedback moved the action');
  await expect(action()).toBeFocused();
  await action().press('Enter');
  await expect(input()).toBeFocused();
  await expect(input()).toHaveValue('');
  passed('IME Enter ignored; wrong answer, stable controls, retry, and focus');

  let spellingAttempts = 0;
  const spellingKeys = [];
  await page.route('**/api/spelling/complete', async route => {
    spellingAttempts++;
    spellingKeys.push(route.request().postDataJSON().submissionKey);
    if (spellingAttempts === 1) {
      await new Promise(resolve => setTimeout(resolve, 400));
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: '本地验收模拟保存失败，请重试。' } }) });
    } else await route.continue();
  });
  for (let index = 0; index < 3; index++) {
    const word = await currentWord(words);
    assert.equal(await page.locator('.practice-spelling-card').getByText(word, { exact: true }).count(), 0, 'Unchecked answer leaked into DOM');
    await input().fill(word);
    await page.keyboard.down('Enter');
    await expect(page.getByText('拼写正确', { exact: true })).toBeVisible();
    await expect(action()).toBeFocused();
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(page.getByText('拼写正确', { exact: true })).toBeVisible();
    if (index < 2) {
      await action().press('Enter');
      await expect(input()).toBeFocused();
      await expect(input()).toHaveValue('');
    } else {
      await action().click();
      await expect(action()).toBeDisabled();
      await expect(action()).toHaveText('保存中…');
      await expect(page.getByText('服务器暂时异常，数据没有确认保存，请稍后重试。', { exact: true })).toBeVisible();
      await expect(action()).toBeEnabled();
      await action().click();
    }
  }
  await expect(page.getByRole('heading', { name: '已完成 3 个词', exact: true })).toBeVisible();
  assert.equal(spellingAttempts, 2);
  assert.ok(spellingKeys[0] && spellingKeys[0] === spellingKeys[1], 'Retry changed idempotency key');
  await expect(page.getByRole('status').filter({ hasText: '正在更新学习数据' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '已完成 3 个词', exact: true })).toBeVisible();
  passed('daily spelling Enter flow, saving lock, failure retry, idempotency, retained result');
  await page.unroute('**/api/spelling/complete');

  for (const word of words) await api(`/api/words/${word.id}/restore`, { method: 'POST' });
  await page.goto(`${origin}/#/review/review`);
  await page.reload();
  await page.getByRole('button', { name: '开始主动回忆', exact: true }).click();
  let recognitionCount = 0;
  while (await page.getByRole('button', { name: '想起来了', exact: true }).count()) {
    await expect(page.locator('.practice-session h1')).toBeFocused();
    await page.getByRole('button', { name: recognitionCount === 0 ? '还没想起' : '想起来了', exact: true }).click();
    await expect(page.locator('.practice-session h1')).toBeFocused();
    await page.getByRole('button', { name: '对上了', exact: true }).click();
    recognitionCount++;
    assert.ok(recognitionCount <= 4);
  }
  assert.equal(recognitionCount, 4, 'Missed word was not requeued');
  await expect(page.getByRole('heading', { name: '所有错词已回炉通过' })).toBeVisible();
  await page.getByRole('button', { name: '开始拼写验证', exact: true }).click();
  for (let index = 0; index < 3; index++) {
    await input().fill(await currentWord(words));
    await input().press('Enter');
    await expect(action()).toBeFocused();
    if (index === 2) {
      await page.route('**/api/review/complete', async route => {
        await new Promise(resolve => setTimeout(resolve, 400));
        await route.continue();
      });
      await action().click();
      await expect(action()).toBeDisabled();
      await expect(action()).toHaveText('保存中…');
    } else await action().press('Enter');
  }
  await expect(page.getByRole('heading', { name: '已处理 3 个词', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '正在更新学习数据' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '已处理 3 个词', exact: true })).toBeVisible();
  passed('recognition focus, missed-word requeue, review saving state, retained review result');

  await page.goto(`${origin}/#/spell?scope=library&filter=all`);
  await page.getByRole('button', { name: '开始拼写 3 个词', exact: true }).click();
  const beforeLibrary = await progressSnapshot();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Spelling overflow at ${width}`);
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await capture('spelling-dark-reduced.png');
  assert.equal(await page.locator('.route-transition-content').evaluate(el => getComputedStyle(el).transform), 'none');
  for (let index = 0; index < 3; index++) {
    await input().fill(await currentWord(words));
    await input().press('Enter');
    await action().press('Enter');
  }
  await expect(page.getByRole('heading', { name: '已完成 3 个词', exact: true })).toBeVisible();
  assert.equal(await progressSnapshot(), beforeLibrary, 'Library practice changed learning progress');
  await expect(page.getByRole('link', { name: '回到词库', exact: true })).toHaveCount(1);
  await capture('library-result-dark-reduced.png');
  passed('library practice isolation, mobile/desktop spelling widths, dark/reduced motion, clear exit');
  assert.deepEqual(errors, []);
  passed('no browser runtime errors');
  console.log(JSON.stringify({ passed: checks.length, output, fixture: 'memory only, not MySQL' }));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  console.error((await page.locator('main').innerText().catch(() => '')).slice(0, 2500));
  throw error;
} finally {
  await browser.close();
}
