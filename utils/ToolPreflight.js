const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);

class ToolPreflight {
    /**
     * Deterministic startup preflight check verifying required industrial binaries
     * with `which` and version probes.
     */
    static async checkAll() {
        const requiredTools = ['pdfinfo', 'pdfimages', 'mutool', 'gs', 'qpdf'];
        const optionalTools = ['exiftool'];
        const allTools = [...requiredTools, ...optionalTools];

        const result = {
            ready: true,
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
                // pdfinfo, pdfimages, mutool typically use -v
                cmd = `"${path}" -v`;
            }

            try {
                const { stdout, stderr } = await execAsync(cmd, { timeout: 5000 });
                const combined = `${stdout || ''}\n${stderr || ''}`.trim();
                const firstLine = combined.split('\n').find(l => l.trim().length > 0) || 'unknown version';
                return firstLine.trim();
            } catch (err) {
                // Some tools (like mutool -v or pdfinfo -v) return non-zero exit codes when displaying version/usage
                const combined = `${err.stdout || ''}\n${err.stderr || ''}`.trim();
                const firstLine = combined.split('\n').find(l => l.trim().length > 0);
                if (firstLine) {
                    return firstLine.trim();
                }
                return 'unknown version probe error';
            }
        };

        for (const tool of allTools) {
            try {
                const { stdout } = await execAsync(`which ${tool}`, { timeout: 3000 });
                const binPath = stdout.trim();
                if (binPath) {
                    const version = await probeVersion(tool, binPath);
                    result.tools[tool] = {
                        available: true,
                        path: binPath,
                        version
                    };
                } else {
                    throw new Error('Empty path returned by which');
                }
            } catch (err) {
                result.tools[tool] = {
                    available: false,
                    path: null,
                    version: null,
                    error: err.message
                };
                if (requiredTools.includes(tool)) {
                    result.ready = false;
                    result.missingTools.push(tool);
                }
            }
        }

        return result;
    }
}

module.exports = ToolPreflight;
