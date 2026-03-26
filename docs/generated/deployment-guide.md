# BMAD Copilot Factory — Deployment Guide

> Generated: 2026-03-26 | Scan Level: Exhaustive | Source: Direct code analysis

## Deployment Modes

| Mode | Entry Point | Description |
|------|------------|-------------|
| **Process Adapter** | `src/heartbeat-entrypoint.ts` | Spawned by Paperclip per heartbeat (production) |
| **Webhook Server** | `src/webhook-server.ts` | HTTP listener on :3200 for Paperclip push callbacks |
| **Inbox Polling** | `src/adapter/paperclip-loop.ts` | Long-running loop polling inbox (development) |
| **Standalone CLI** | `src/index.ts` | Direct sprint processing (no Paperclip needed) |
| **MCP Server** | `src/mcp/bmad-sprint-server/index.ts` | VS Code integration via stdio |

## Docker Deployment

### Dockerfile (Multi-Stage Build)

```dockerfile
# Stage 1: base — Node.js 20 Alpine
# Stage 2: deps — Install production dependencies
# Stage 3: build — Compile TypeScript
# Stage 4: runtime — Minimal production image
#   CMD: node dist/index.js --paperclip
```

### Build & Run

```bash
docker build -t bmad-factory .
docker run -e PAPERCLIP_URL=http://paperclip:3100 \
           -e PAPERCLIP_COMPANY_ID=bmad-factory \
           -e PAPERCLIP_AGENT_API_KEY=<key> \
           bmad-factory
```

## Docker Compose Stacks

### Main Stack (`docker-compose.yml`)

Services:
- **paperclip** — Paperclip server (:3100)
- **postgres** — PostgreSQL for Paperclip data
- **bmad-factory** — BMAD Factory (profile: `factory`)

```bash
docker compose up -d                   # Paperclip + PostgreSQL
docker compose --profile factory up -d # + BMAD Factory
```

### Observability Stack (`docker-compose.observability.yml`)

Services:
- **otel-collector** — OpenTelemetry Collector (OTLP :4317, :4318)
- **jaeger** — Distributed tracing UI (:16686)
- **prometheus** — Metrics scraping (:9090)
- **grafana** — Dashboard UI (:3000, credentials: admin/bmad)

```bash
docker compose -f docker-compose.observability.yml up -d
```

### Ports Summary

| Port | Service | Protocol |
|------|---------|----------|
| 3100 | Paperclip API | HTTP |
| 3200 | BMAD Webhook Server | HTTP |
| 4317 | OTel Collector (gRPC) | gRPC |
| 4318 | OTel Collector (HTTP) | HTTP |
| 9090 | Prometheus | HTTP |
| 16686 | Jaeger UI | HTTP |
| 3000 | Grafana | HTTP |

## Paperclip Setup

### Initial Company Setup

```bash
# 1. Start Paperclip
docker compose up -d

# 2. Create company, agents, and org chart
npx tsx scripts/setup-paperclip-company.ts
```

The setup script:
- Creates company with ID `bmad-factory`
- Creates 10 agents (CEO + 9 BMAD specialists)
- Configures org chart (CEO → PM → Architect → Dev → QA)
- Sets agent metadata (bmadRole, capabilities, heartbeat config)
- Maps BMAD roles to Paperclip roles (analyst→researcher, dev→engineer, etc.)

### Agent Roles Mapping

| BMAD Agent | Paperclip Role |
|-----------|---------------|
| bmad-pm | product_manager |
| bmad-architect | engineer |
| bmad-dev | engineer |
| bmad-qa | engineer |
| bmad-sm | project_manager |
| bmad-analyst | researcher |
| bmad-ux | designer |
| bmad-tech-writer | researcher |
| bmad-quick-flow | engineer |
| ceo | executive |

## Production Configuration

### Required Environment Variables

```bash
# Paperclip connection
PAPERCLIP_ENABLED=true
PAPERCLIP_URL=http://paperclip:3100
PAPERCLIP_COMPANY_ID=bmad-factory
PAPERCLIP_AGENT_API_KEY=<agent-api-key>

# Mode selection
PAPERCLIP_MODE=webhook          # or inbox-polling
WEBHOOK_PORT=3200               # for webhook mode

# Logging
LOG_LEVEL=info
LOG_FORMAT=json                 # JSON for production, human for dev

# Model selection
COPILOT_MODEL=claude-sonnet-4.6
MODEL_PREFER_BYOK=false         # true if using own API keys
```

### Optional Production Variables

```bash
# Observability
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
OTEL_SERVICE_NAME=bmad-factory

# Stall detection
STALL_AUTO_ESCALATE=false       # true to auto-escalate stuck stories

# Review limits
REVIEW_PASS_LIMIT=3             # Max review passes before escalation
```

## Health Checks

### 5-Probe System Readiness

The health check system (`src/adapter/health-check.ts`) validates:

| Probe | Critical | Checks |
|-------|----------|--------|
| config | Yes | Required fields (projectRoot, model, outputDir, reviewPassLimit > 0) |
| agents | Yes | At least 1 BMAD agent registered |
| tools | Yes | Required tools present (create_story, code_review, code_review_result, issue_status) |
| sprint-file | No | sprint-status.yaml exists and readable |
| paperclip | Conditional | Ping /api/health (critical only if PAPERCLIP_ENABLED=true) |

### Status Determination

- **healthy**: All probes pass
- **degraded**: All critical pass, some non-critical fail
- **unhealthy**: Any critical probe fails

## OTel Collector Configuration

```yaml
# observability/otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "0.0.0.0:4317"
      http:
        endpoint: "0.0.0.0:4318"

exporters:
  otlp/jaeger:
    endpoint: "jaeger:4317"
    tls:
      insecure: true
  prometheus:
    endpoint: "0.0.0.0:8889"

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp]
      exporters: [prometheus]
```

## Grafana Dashboard

Pre-built dashboard (`observability/grafana/dashboards/`) includes:

| Panel | Type | Description |
|-------|------|-------------|
| Stories Processed | Counter | Total stories processed per cycle |
| Stories Done | Counter | Stories reaching "done" status |
| Dispatch Latency | Histogram | Agent dispatch p50/p95/p99 (ms) |
| Quality Gate Verdicts | Pie chart | PASS/FAIL/ESCALATE distribution |
| Active Sessions | Gauge | Currently active Copilot SDK sessions |
| Stall Detections | Counter | Stalled story detections |
| Review Passes | Timeline | Review pass attempts over time |

## Shutdown Behavior

### Clean Shutdown Sequence

1. Stop accepting new work
2. Close all active Copilot SDK sessions
3. Flush OpenTelemetry telemetry (traces + metrics)
4. Report final cost tracking data to Paperclip
5. Pause all BMAD agents in Paperclip (inbox-polling mode)
6. Exit with code 0

### Graceful Degradation

- Non-fatal telemetry failures don't block work
- Non-fatal comment failures are logged but don't fail heartbeats
- Agent pause failures on shutdown are non-fatal
- Session close failures are logged as warnings
