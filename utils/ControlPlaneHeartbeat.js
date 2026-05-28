const https = require('https');
const os = require('os');

class ControlPlaneHeartbeat {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.interval = null;
        this.firstSuccessLogged = false;
    }

    start() {
        const { url, token, workerId, queueName, concurrency, intervalMs } = this.config;

        if (!url || !token) {
            this.logger.info('[WORKER][CONTROL-PLANE-HEARTBEAT][SKIP] Missing configuration');
            return;
        }

        const beat = async () => {
            try {
                const payload = {
                    workerId,
                    metadata: {
                        hostname: os.hostname(),
                        status: "HEALTHY",
                        queue_bindings: [queueName],
                        capabilities: ["ANALYZE", "AUTOFIX"],
                        concurrency,
                        uptime_seconds: Math.floor(process.uptime()),
                        memory_profile_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
                    }
                };

                const data = JSON.stringify(payload);
                const urlObj = new URL('/api/admin/workers/heartbeat', url);

                const options = {
                    hostname: urlObj.hostname,
                    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    path: urlObj.pathname,
                    method: 'POST',
                    headers: {
                        'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    }
                };

                const req = https.request(options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            if (!this.firstSuccessLogged) {
                                this.logger.info('[WORKER][CONTROL-PLANE-HEARTBEAT][OK]');
                                this.firstSuccessLogged = true;
                            }
                        } else {
                            this.logger.warn({ statusCode: res.statusCode, body }, '[WORKER][CONTROL-PLANE-HEARTBEAT][WARN] Non-200 response');
                        }
                    });
                });

                req.on('error', (err) => {
                    this.logger.warn({ error: err.message }, '[WORKER][CONTROL-PLANE-HEARTBEAT][WARN] Connection failed');
                });

                req.write(data);
                req.end();
            } catch (err) {
                this.logger.warn({ error: err.message }, '[WORKER][CONTROL-PLANE-HEARTBEAT][WARN] Heartbeat error');
            }
        };

        beat();
        this.interval = setInterval(beat, intervalMs || 30000);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}

module.exports = ControlPlaneHeartbeat;
