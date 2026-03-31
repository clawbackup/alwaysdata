const path = require('path');
const fs = require('fs');
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const fastifyStatic = require('@fastify/static');
const { CONFIG } = require('./config');
const { routes } = require('./routes');
const { scheduleAll, scheduleGlobalTask } = require('./scheduler');
const { prisma } = require('./db');
const { initAuth } = require('./auth');

async function buildServer() {
  const fastify = Fastify({ logger: true });
  if (CONFIG.NODE_ENV !== 'production') {
    await fastify.register(cors, { origin: true, credentials: true });
  }

  // Static file path for Docker: /app/web/dist (when __dirname is /app/src)
  const staticRoot = path.join(__dirname, '..', 'web', 'dist');
  const hasStaticRoot = fs.existsSync(staticRoot);
  const indexPath = path.join(staticRoot, 'index.html');
  const indexHtml = hasStaticRoot && fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
  
  if (hasStaticRoot) {
    await fastify.register(require('@fastify/static'), {
      root: staticRoot,
      prefix: '/',
      decorateReply: false // 避免冲突
    });
  }

  await fastify.register(routes);

  if (indexHtml) {
    fastify.setNotFoundHandler((req, reply) => {
      // For SPA, serve index.html for non-API routes
      if (!req.url.startsWith('/api/')) {
        return reply.type('text/html').send(indexHtml);
      }
      reply.code(404).send({ error: 'Not found' });
    });
  }

  // 初始化认证模块
  await initAuth(fastify);

  await scheduleAll(fastify);
  
  // 加载全局定时任务配置
  try {
    const scheduleConfig = await prisma.scheduleConfig.findFirst();
    if (scheduleConfig) {
      await scheduleGlobalTask(scheduleConfig, fastify);
      fastify.log.info({ config: scheduleConfig }, 'Global schedule task initialized');
    }
  } catch (e) {
    fastify.log.warn({ err: e.message }, 'Failed to initialize global schedule task');
  }
  
  return fastify;
}

async function startServer() {
  const app = await buildServer();
  const listenHost = process.env.IP || process.env.HOST || '::';
  await app.listen({ port: Number(process.env.PORT || CONFIG.PORT || 8100), host: listenHost });
  return app;
}

if (require.main === module) {
  startServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildServer, startServer };
