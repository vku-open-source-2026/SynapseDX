# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY apps/console/package*.json ./
RUN npm ci --ignore-scripts
COPY apps/console ./
RUN npm run build

FROM nginx:1.27-alpine
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1/ >/dev/null || exit 1
