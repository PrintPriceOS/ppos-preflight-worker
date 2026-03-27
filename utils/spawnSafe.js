/**
 * spawnSafe
 * 
 * Provides a secure wrapper for child process execution,
 * preventing shell injection and enforcing timeouts.
 */
const { spawn } = require('child_process');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Executes a command with arguments in a secure way.
 * 
 * @param {string} command The executable to run
 * @param {string[]} args Array of arguments
 * @param {object} options Additional options (cwd, timeout, etc)
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
async function spawnSafe(command, args = [], options = {}) {
    const timeout = options.timeout || 30000; // 30s default

    logger.debug({ command, args, timeout }, 'Spawning safe process');

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            ...options,
            shell: false, // MANDATORY: Prevent shell injection
            windowsHide: true
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });

        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
        }, timeout);

        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr, code });
            } else {
                const error = new Error(`Command failed with code ${code}: ${command}\n${stderr}`);
                error.code = 'EXECUTION_FAILED';
                error.stderr = stderr;
                error.exitCode = code;
                reject(error);
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

module.exports = spawnSafe;
