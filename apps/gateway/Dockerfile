# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY package*.json ./
COPY apps/gateway/package.json apps/gateway/tsconfig.json ./apps/gateway/
COPY apps/gateway/src ./apps/gateway/src
RUN npm ci && npm run build --workspace=@synapsedx/gateway
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/package*.json ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /workspace/apps/gateway/package.json ./apps/gateway/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/gateway/dist/src/index.js"]
