FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Node 24 直接运行仓库中的 TypeScript；依赖中含 argon2，bookworm 镜像提供
# 其预编译二进制所需的 glibc 环境。
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack pnpm install --frozen-lockfile --prod

COPY server ./server
COPY database ./database

USER node
EXPOSE 3000
CMD ["node", "server/src/main.ts"]
