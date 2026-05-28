const https = require('https');

class ControlPlaneArtifacts {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }

    async register(payload) {
        const { url, token, workerId } = this.config;

        if (!url || !token) {
            this.logger.debug('[WORKER][CONTROL-PLANE-ARTIFACT][SKIP] Missing configuration');
            return;
        }

        try {
            const fullPayload = {
                ...payload,
                createdByWorker: workerId,
                metadata: {
                    ...payload.metadata,
                    source: "ppos-preflight-worker"
                }
            };

            const data = JSON.stringify(fullPayload);
            const urlObj = new URL('/api/admin/artifacts/register', url);

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

            return new Promise((resolve) => {
                const req = https.request(options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            this.logger.info({ artifactType: payload.artifactType, filename: payload.filename }, '[WORKER][CONTROL-PLANE-ARTIFACT][OK]');
                            resolve(true);
                        } else {
                            this.logger.warn({ statusCode: res.statusCode, body }, '[WORKER][CONTROL-PLANE-ARTIFACT][WARN] Registration failed');
                            resolve(false);
                        }
                    });
                });

                req.on('error', (err) => {
                    this.logger.warn({ error: err.message }, '[WORKER][CONTROL-PLANE-ARTIFACT][WARN] Connection failed');
                    resolve(false);
                });

                req.write(data);
                req.end();
            });
        } catch (err) {
            this.logger.warn({ error: err.message }, '[WORKER][CONTROL-PLANE-ARTIFACT][WARN] Error during registration');
            return false;
        }
    }
}

module.exports = ControlPlaneArtifacts;
