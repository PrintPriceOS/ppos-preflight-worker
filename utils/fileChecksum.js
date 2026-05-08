const crypto = require('crypto');
const fs = require('fs');

/**
 * Computes SHA-256 hash for a given file.
 * Returns a lowercase hex digest.
 * 
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<string>} - Lowercase hex SHA-256 digest.
 */
async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('error', (err) => reject(err));
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    });
}

module.exports = {
    sha256File
};
