const infra = require('@ppos/shared-infra');
console.log('Keys in @ppos/shared-infra:', Object.keys(infra));
console.log('Value of infra.db:', infra.db);
console.log('Is infra itself a function or object with execute?', typeof infra.execute);
