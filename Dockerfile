# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:26-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseDX/package*.json ./SynapseDX/
COPY SynapseDX/apps/capabilities-service/package*.json SynapseDX/apps/capabilities-service/tsconfig.json ./SynapseDX/apps/capabilities-service/
COPY SynapseDX/apps/capabilities-service/src ./SynapseDX/apps/capabilities-service/src
RUN cd SynapseDX && npm ci && npm run build:service

FROM node:26-bookworm-slim
ENV NODE_ENV=production
# Tesseract OCR (Apache-2.0) + Vietnamese data; see apps/capabilities-service/Dockerfile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-vie \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /workspace/SynapseDX/package*.json ./
COPY --from=build /workspace/SynapseDX/node_modules ./node_modules
COPY --from=build /workspace/SynapseDX/apps/capabilities-service/dist ./apps/capabilities-service/dist
COPY --from=build /workspace/SynapseDX/apps/capabilities-service/package.json ./apps/capabilities-service/
EXPOSE 8082
CMD ["node", "apps/capabilities-service/dist/src/server.js"]
