/** Local-only UI acceptance fixture. Never connects to MySQL or production. */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../server/src/app.ts';
import { loadConfig } from '../../server/src/config.ts';
import { hashPassword } from '../../server/src/auth.ts';
import { createFakeRepository } from '../../server/src/testing/fakeRepository.ts';

const repository = createFakeRepository();
const passwordHash = await hashPassword('Preview-only-2026');
repository.seedUser({ id: 'preview-admin', email: 'admin@example.test', username: '本地测试管理员', passwordHash, role: 'admin' });
repository.seedUser({ id: 'preview-learner', email: 'learner@example.test', username: '本地测试学习者', passwordHash });
const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'local-preview-only-secret-0123456789abcdef', APP_ORIGIN: 'http://127.0.0.1:5177', COOKIE_SECURE: 'false' });
const requestLogging = process.env.PREVIEW_LOG_REQUESTS === '1';
const app = buildApp({
  config,
  repository,
  logger: requestLogging ? {
    level: 'info',
    // Keep diagnostics useful without exposing passwords, cookies, authorization, or bodies.
    serializers: {
      req(request) { return { method: request.method, url: request.url }; },
      res(reply) { return { statusCode: reply.statusCode }; },
    },
    redact: {
      paths: ['req.headers', 'req.body', 'res.headers', 'req.raw.headers', 'res.raw.headers'],
      censor: '[REDACTED]',
    },
  } : false,
});
await app.listen({ host: '127.0.0.1', port: 3002 });
const vite = await createServer({
  configFile: fileURLToPath(new URL('./vite.config.mjs', import.meta.url)),
  server: { host: '127.0.0.1', port: 5177, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3002' } },
});
await vite.listen();
console.log('Local memory-only preview: http://127.0.0.1:5177 (not MySQL acceptance)');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await vite.close();
  await app.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
