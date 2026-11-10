# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY package*.json ./
# Tier-1 SDK is installed from the public npm registry.
COPY apps/capabilities-service/package.json apps/capabilities-service/tsconfig.json ./apps/capabilities-service/
COPY apps/capabilities-service/src ./apps/capabilities-service/src
RUN npm ci && npm run build --workspace=@synapsedx/capabilities-service
FROM node:20-bookworm-slim
ENV NODE_ENV=production
# OCR engine for file-backed OCR jobs: Tesseract 5 (Apache-2.0) from Debian,
# with English (pulled in by default) and Vietnamese language data. It runs
# only while a job is processing, so idle memory stays unchanged.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-vie \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /workspace/package*.json ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/capabilities-service/dist ./apps/capabilities-service/dist
COPY --from=build /workspace/apps/capabilities-service/package.json ./apps/capabilities-service/
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8082/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/capabilities-service/dist/src/server.js"]
