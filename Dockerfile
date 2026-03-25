# 构建前端静态资源
FROM node:18-alpine AS webbuild
WORKDIR /web

COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build && npm cache clean --force

# 构建服务端并生成 Prisma Client
FROM node:18-alpine AS serverbuild
WORKDIR /server

COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY server/prisma ./prisma
RUN npx prisma generate

COPY server/src ./src
COPY server/scripts ./scripts
RUN npm prune --omit=dev && npm cache clean --force

# 生产运行镜像
FROM node:18-alpine AS runtime
LABEL maintainer="AI Model Monitor"
LABEL description="AI中转站模型监测系统"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL="file:/app/data/db.sqlite"

RUN apk add --no-cache openssl \
    && addgroup -S appgroup \
    && adduser -S appuser -G appgroup \
    && mkdir -p /app/data /app/prisma /app/web/dist \
    && chown -R appuser:appgroup /app

COPY --from=serverbuild --chown=appuser:appgroup /server/package.json ./package.json
COPY --from=serverbuild --chown=appuser:appgroup /server/node_modules ./node_modules
COPY --from=serverbuild --chown=appuser:appgroup /server/src ./src
COPY --from=serverbuild --chown=appuser:appgroup /server/scripts ./scripts
COPY --from=serverbuild --chown=appuser:appgroup /server/prisma ./prisma
COPY --from=webbuild --chown=appuser:appgroup /web/dist ./web/dist

USER appuser

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "scripts/start.js"]
