// The forge's entrypoint and its contract with the trial environment: build
// the app, bind an ephemeral port, report that port to the environment, then
// wait until the environment says the trial is over and exit 0. The suite
// scores the server app.ts builds; this file is only the lifecycle around it.

import { createApp } from './app.ts';

/** Tell the environment which port the forge bound, retrying while it wakes. */
async function reportPort(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const answer = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (answer.ok) return;
    } catch {
      // The environment is not answering yet; try again shortly.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('registration with the environment failed');
}

/** Poll the environment's done endpoint until it answers 200. */
async function awaitDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const answer = await fetch(`${envUrl}/done`);
      if (answer.ok) return;
    } catch {
      // A failed poll says nothing about the trial; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const bound = server.address();
  const port = bound !== null && typeof bound === 'object' ? bound.port : 0;

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    // No environment (a local run): serve until the process is stopped.
    console.log(`forge listening on port ${port}`);
    return;
  }

  await reportPort(envUrl, port);
  await awaitDone(envUrl);
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
