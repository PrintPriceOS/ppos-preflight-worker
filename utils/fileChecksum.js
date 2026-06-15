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

/**
 * Computes a SHA-256 hash for a JSON-serializable value.
 * Returns a lowercase hex digest of the JSON.stringify() representation.
 *
 * @param {*} value - Any JSON-serializable value.
 * @returns {string} - Lowercase hex SHA-256 digest.
 */
function sha256JSON(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').toLowerCase();
}

module.exports = {
    sha256File,
    sha256JSON
};
