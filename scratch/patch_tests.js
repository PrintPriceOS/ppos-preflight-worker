const fs = require('fs');
const path = require('path');

const p1 = path.resolve(__dirname, '../validation_test.js');
let c1 = fs.readFileSync(p1, 'utf8');
const t1 = `    stat: async () => ({ size: 500 }),
    statSync: () => ({ size: 1000 })`;
const r1 = `    stat: async () => ({ size: 500 }),
    statSync: () => ({ size: 1000 }),
    writeJson: async () => {},
    writeJsonSync: () => {}`;

if (c1.includes(t1)) {
    c1 = c1.replace(t1, r1);
    fs.writeFileSync(p1, c1, 'utf8');
    console.log('[PATCH] validation_test.js - Success');
} else {
    // try normalized
    const normT1 = t1.replace(/\r\n/g, '\n');
    const normC1 = c1.replace(/\r\n/g, '\n');
    if (normC1.includes(normT1)) {
        c1 = normC1.replace(normT1, r1.replace(/\r\n/g, '\n'));
        fs.writeFileSync(p1, c1, 'utf8');
        console.log('[PATCH] validation_test.js (normalized) - Success');
    } else {
        console.error('[PATCH] validation_test.js - Target not found!');
    }
}

const p2 = path.resolve(__dirname, '../test_autofix_preservation.js');
let c2 = fs.readFileSync(p2, 'utf8');
const t2 = `    stat: async () => ({ size: 1024 }),
    statSync: () => ({ size: 1024 })`;
const r2 = `    stat: async () => ({ size: 1024 }),
    statSync: () => ({ size: 1024 }),
    writeJson: async () => {},
    writeJsonSync: () => {}`;

if (c2.includes(t2)) {
    c2 = c2.replace(t2, r2);
    fs.writeFileSync(p2, c2, 'utf8');
    console.log('[PATCH] test_autofix_preservation.js - Success');
} else {
    // try normalized
    const normT2 = t2.replace(/\r\n/g, '\n');
    const normC2 = c2.replace(/\r\n/g, '\n');
    if (normC2.includes(normT2)) {
        c2 = normC2.replace(normT2, r2.replace(/\r\n/g, '\n'));
        fs.writeFileSync(p2, c2, 'utf8');
        console.log('[PATCH] test_autofix_preservation.js (normalized) - Success');
    } else {
        console.error('[PATCH] test_autofix_preservation.js - Target not found!');
    }
}
