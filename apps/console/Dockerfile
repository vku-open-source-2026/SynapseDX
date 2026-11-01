# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM nginx:1.27-alpine
COPY SynapseDX/apps/console/public /usr/share/nginx/html
COPY SynapseDX/apps/console/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
