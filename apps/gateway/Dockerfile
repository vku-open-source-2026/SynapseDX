# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1-bookworm AS builder
ARG CARGO_BUILD_JOBS=1
WORKDIR /workspace
COPY apps/gateway/Cargo.toml apps/gateway/Cargo.lock ./
COPY apps/gateway/src ./src
RUN cargo build --release --locked --jobs=${CARGO_BUILD_JOBS}

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app

COPY --from=builder /workspace/target/release/synapsedx-gateway /usr/local/bin/synapsedx-gateway

# Compatibility wrapper for node-based healthchecks in docker-compose.yml
RUN printf '#!/bin/sh\nif [ "$1" = "-e" ]; then\n  exec /usr/local/bin/synapsedx-gateway --healthcheck\nfi\nexec /usr/local/bin/synapsedx-gateway "$@"\n' > /usr/local/bin/node \
    && chmod +x /usr/local/bin/node

ENV PORT=8080 \
    NODE_ENV=production

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/synapsedx-gateway", "--healthcheck"]

USER app
ENTRYPOINT ["/usr/local/bin/synapsedx-gateway"]
