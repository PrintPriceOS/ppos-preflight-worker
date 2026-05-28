const http = require('http');
const https = require('https');

class ControlPlaneJobSync {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }

    async syncJobResult(payload) {
        const { url, token, workerId } = this.config;

        if (!url || !token) {
            this.logger.debug('[WORKER][CONTROL-PLANE-JOB-SYNC][SKIP] Missing configuration');
            return false;
        }

        try {
            const fullPayload = {
                ...payload,
                workerId
            };
            const data = JSON.stringify(fullPayload);
            const urlObj = new URL('/api/admin/preflight/jobs/sync', url);
            const client = urlObj.protocol === 'https:' ? https : http;

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'x-worker-id': workerId || 'unknown'
                }
            };

            this.logger.info({ jobId: payload.jobId, endpoint: urlObj.href, payloadKeys: Object.keys(payload) }, '[WORKER][CONTROL-PLANE-JOB-SYNC][REQUEST]');

            return new Promise((resolve) => {
                const req = client.request(options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            this.logger.info({ jobId: payload.jobId }, '[WORKER][CONTROL-PLANE-JOB-SYNC][OK]');
                            resolve(true);
                        } else {
                            this.logger.warn({ statusCode: res.statusCode, body, jobId: payload.jobId }, '[WORKER][CONTROL-PLANE-JOB-SYNC][WARN] Sync failed');
                            resolve(false);
                        }
                    });
                });

                req.on('error', (err) => {
                    this.logger.warn({ error: err.message, jobId: payload.jobId }, '[WORKER][CONTROL-PLANE-JOB-SYNC][WARN] Connection failed');
                    resolve(false);
                });

                req.write(data);
                req.end();
            });
        } catch (err) {
            this.logger.warn({ error: err.message }, '[WORKER][CONTROL-PLANE-JOB-SYNC][WARN] Error during sync');
            return false;
        }
    }
}

module.exports = ControlPlaneJobSync;
