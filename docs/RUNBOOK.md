# Runbook — PPOS Preflight Worker

## ⚡ Worker Overview
The `ppos-preflight-worker` handles asynchronous, high-load PDF analysis and fixes from the global job queue.

---

## 🛠 Operation & Setup

### 1. Initial Setup
```bash
npm install
cp .env.example .env
npm start
```

### 2. Environment Variables
| Variable | Description | Default |
| :--- | :--- | :--- |
| `REDIS_HOST` | Redis endpoint | `127.0.0.1` |
| `REDIS_PORT` | Redis port | `6379` |
| `PPOS_QUEUE_NAME`| Name of the preflight queue | `preflight_async_queue` |
| `HEALTH_PORT` | Port for health check server | `8002` |

---

## 🚑 Health & Troubleshooting

### Health Check Endpoint
- **URL**: `GET http://localhost:8002/health`
- **Output**: Returns status, queue name, and timestamp.

### Observability
- Worker uses **Pino** for structured JSON logging.
- Check logs for `jobId` to trace specific failures.

### Common Issues
1. **Redis Connection Refused**: Ensure Redis is running and network access is allowed.
2. **Engine Error**: Worker depends on `@ppos/preflight-engine`. Verify it's linked correctly.
3. **Ghostscript Missing**: Some technical analysis tasks require GS installed on the host.

---

## 🚀 Deployment (Staging)
1. Set `NODE_ENV=production` for JSON logging.
2. Configure `REDIS_PASSWORD` if applicable.
3. Scale horizontally by increasing worker replicas listening to the same queue.
