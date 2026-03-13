// ppos-preflight-worker/src/worker.ts
import 'dotenv/config';
import { Worker } from '@temporalio/worker';
import * as activities from './activities/preflight';

async function run() {
    const worker = await Worker.create({
        // In a polyrepo, workflows might be in their own bundle or imported
        workflowsPath: require.resolve('./workflows'), 
        activities,
        taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'PREFLIGHT_QUEUE',
        connectionOptions: {
            address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
        },
    });

    console.log(`Worker listening on task queue: ${process.env.TEMPORAL_TASK_QUEUE || 'PREFLIGHT_QUEUE'}`);
    await worker.run();
}

run().catch((err) => {
    console.error('Worker failed to start', err);
    process.exit(1);
});
