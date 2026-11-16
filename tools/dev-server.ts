// Standalone runner for local development: binds the forge to 127.0.0.1:8911 so
// the kit's conformance runner (sdk/run.ts) can drive it exactly as the trial
// env does. The bearer token comes from MAKEFUN_SHOP_TOKEN, as in a trial.

import { createApp } from '../app.ts';

const server = createApp();
server.listen(8911, '127.0.0.1', () => {
  process.stdout.write('forge dev server on http://127.0.0.1:8911\n');
});
