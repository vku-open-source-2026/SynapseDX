# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseDX/package*.json ./SynapseDX/
COPY SynapseDX/apps/gateway/package*.json SynapseDX/apps/gateway/tsconfig.json ./SynapseDX/apps/gateway/
COPY SynapseDX/apps/gateway/src ./SynapseDX/apps/gateway/src
RUN cd SynapseDX && npm ci && npm run build --workspace=@synapsedx/gateway
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/SynapseDX/package*.json ./
COPY --from=build /workspace/SynapseDX/node_modules ./node_modules
COPY --from=build /workspace/SynapseDX/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /workspace/SynapseDX/apps/gateway/package.json ./apps/gateway/
EXPOSE 8080
CMD ["node", "apps/gateway/dist/src/index.js"]
