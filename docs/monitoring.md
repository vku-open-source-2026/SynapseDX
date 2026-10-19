# Monitoring (Prometheus)

SynapseDX ships with metrics out of the box: the gateway exposes Prometheus
metrics at `GET /metrics` (`gateway_requests_total` + Node runtime metrics),
`lds-service` exposes `synapsedx_lds_http_requests_total` +
`synapsedx_lds_datasources_total` / `synapsedx_lds_records_total`,
`workflow-service` exposes `synapsedx_workflow_runs_total`, and compose adds
Prometheus (scrape + graph/alerts UI) + PG/Redis exporters.

## Run

```bash
docker compose up -d --build prometheus
open http://localhost:9091  # Prometheus graph + /alerts + /targets
```

## What is scraped

| Job | Target | Source |
|---|---|---|
| `gateway` | `gateway:8080/metrics` | `prom-client` in `apps/gateway` |
| `workflow` | `workflow:4002/metrics` | in-process counters in `apps/workflow-service` |
| `lds` | `lds:4004/metrics` | in-process counters in `apps/lds-service` |
| `postgres` | `postgres-exporter:9187` | `prometheuscommunity/postgres-exporter` |
| `redis` | `redis-exporter:9121` | `oliver006/redis_exporter` |
| `prometheus` | self | built-in |

Config: `infra/monitoring/prometheus/prometheus.yml` (mounted read-only —
`docker compose restart prometheus` to pick up config changes). Alert rules in
`infra/monitoring/prometheus/alerts.yml` (`GatewayDown`, `PostgresDown`,
`RedisDown` — visible on Prometheus `/alerts`; wire Alertmanager when needed).

## Useful queries (paste into the Prometheus graph tab)

```promql
sum(rate(gateway_requests_total[5m]))            # request rate, all routes
sum by (route) (rate(gateway_requests_total[5m])) # rate per route
# AI assistant traffic/errors ride the gateway counter (route="/v1/ai"):
sum by (status) (rate(gateway_requests_total{route="/v1/ai"}[5m]))
up{job="gateway"}                                # gateway scrape health (1 = up)
rate(process_cpu_user_seconds_total{job="gateway"}[5m])
process_resident_memory_bytes{job="gateway"}
```

## Production

- The prod overlay unpublishes the Prometheus port (`docker-compose.prod.yml`):
  reach it via port-forward/SSH tunnel, never expose it publicly without auth.
- Pin image digests on release (see `docs/production.md`).

## Disable

```bash
docker compose stop prometheus postgres-exporter redis-exporter
```

## Troubleshooting

- Prometheus `targets down`: `docker compose ps`, `docker compose logs prometheus`;
  gateway must be healthy (`curl localhost:8080/health`).
- Port clash (`9091` busy): set `PROMETHEUS_HOST_PORT` in `.env`
  (see `docs/troubleshooting.md`).
