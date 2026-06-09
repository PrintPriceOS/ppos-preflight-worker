const util = require('util');
const { exec } = require('child_process');
const os = require('os');
const execAsync = util.promisify(exec);

const whichCmd = os.platform() === 'win32' ? 'where' : 'which';

class ToolPreflight {
    /**
     * Startup preflight check verifying required industrial binaries
     * with capability-based readiness.
     */
    static async checkAll() {
        // ARCHITECTURAL DECISION: 'qpdf' remains in hardRequired because it is critical
        // for safe integrity checks, decrypting stream encryptions, repairing low-level page count structures,
        // and standardizing document streams before processing. Without it, safe preflight is not possible.
        const hardRequired = ['gs', 'qpdf'];
        const degradedAllowed = ['pdfinfo', 'pdfimages', 'mutool', 'pdffonts'];
        const optional = ['exiftool'];
        const allTools = [...hardRequired, ...degradedAllowed, ...optional];

        const result = {
            ready: true,
            degraded: false,
            status: 'HEALTHY',
            missingTools: [],
            tools: {}
        };

        const probeVersion = async (tool, path) => {
            let cmd = '';
            if (tool === 'gs' || tool === 'qpdf') {
                cmd = `"${path}" --version`;
            } else if (tool === 'exiftool') {
                cmd = `"${path}" -ver`;
            } else {
                // pdfinfo, pdfimages, mutool, pdffonts typically use -v or similar
                cmd = `"${path}" -v`;
            }

            try {
                const { stdout, stderr } = await execAsync(cmd, { timeout: 5000 });
                const combined = `${stdout || ''}\n${stderr || ''}`.trim();
                const firstLine = combined.split('\n').find(l => l.trim().length > 0) || 'unknown version';
                return firstLine.trim();
            } catch (err) {
                const combined = `${err.stdout || ''}\n${err.stderr || ''}`.trim();
                const firstLine = combined.split('\n').find(l => l.trim().length > 0);
                if (firstLine) {
                    return firstLine.trim();
                }
                return 'unknown version probe error';
            }
        };

        // On Windows, 'which' is not available. 
        // We will try using 'where' on Windows to locate binaries if which fails.
        const isWindows = process.platform === 'win32';

        for (const tool of allTools) {
            let available = false;
            let binPath = null;
            let version = null;
            let errorMsg = null;

            try {
                const searchCmd = isWindows ? `where ${tool}` : `which ${tool}`;
                const { stdout } = await execAsync(searchCmd, { timeout: 3000 });
                binPath = stdout.trim().split('\n')[0].trim(); // Get first match

                if (binPath) {
                    version = await probeVersion(tool, binPath);
                    available = true;
                } else {
                    throw new Error('Empty path returned');
                }
            } catch (err) {
                errorMsg = err.message;
            }

            if (available) {
                result.tools[tool] = {
                    available: true,
                    path: binPath,
                    version
                };
            } else {
                result.tools[tool] = {
                    available: false,
                    path: null,
                    version: null,
                    error: errorMsg
                };

                if (hardRequired.includes(tool)) {
                    result.ready = false;
                    result.missingTools.push(tool);
                } else if (degradedAllowed.includes(tool)) {
                    result.degraded = true;
                    result.missingTools.push(tool);
                }
            }
        }

        if (!result.ready) {
            result.status = 'UNHEALTHY';
        } else if (result.degraded) {
            result.status = 'DEGRADED';
        } else {
            result.status = 'HEALTHY';
        }

        return result;
    }
}

module.exports = ToolPreflight;
