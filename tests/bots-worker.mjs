// bots-worker.mjs - a worker thread for tests/bots.mjs: plays one block of strength games and posts the sums.
// Not a suite (run-all.mjs does not list it).

import { parentPort, workerData } from 'node:worker_threads';
import { strengthBlock } from './bots-lib.mjs';

parentPort.postMessage(strengthBlock(workerData));
