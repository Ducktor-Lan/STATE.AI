import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { url: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true });
if (values.help) {
  console.log('Usage: npm run smoke -- [--url http://127.0.0.1:4180]\nRuns the bundled baseline CLI, verifies its durable replay, and checks the real HTTP API.\nUses an existing local server if available; otherwise starts a temporary port-zero service. Run npm run build first.');
} else {
  let app;
  try {
    await Promise.all(['cli.mjs', 'server.mjs'].map(name => access(join(root, 'dist', name))));
    const cli = (...args) => new Promise((accept, reject) => {
      const child = spawn(process.execPath, [join(root, 'dist', 'cli.mjs'), ...args, '--root', root], { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', reject); child.on('close', code => code === 0 ? accept(stdout) : reject(new Error(`CLI exited ${code}: ${stderr || stdout}`)));
    });
    const baseline = JSON.parse(await cli('baseline', 'smoke'));
    assert.equal(baseline.run.status, 'completed', baseline.run.error); assert.equal(baseline.run.costUsd, 0); assert.equal(baseline.replay.verified, true); assert.ok(baseline.run.calls > 0);
    const verification = JSON.parse(await cli('replay', 'verify', baseline.recordDirectory));
    assert.equal(verification.verified, true); assert.equal(verification.fingerprint, baseline.replay.fingerprint);
    let baseUrl = values.url;
    if (!baseUrl) {
      try {
        const response = await fetch('http://127.0.0.1:4180/api/health', { signal: AbortSignal.timeout(1500) });
        if (response.ok && (await response.json()).service === 'STATE.AI') baseUrl = 'http://127.0.0.1:4180';
      } catch { /* Start a local service below when none is running. */ }
    }
    if (!baseUrl) {
      const { startServer } = await import(pathToFileURL(join(root, 'dist', 'server.mjs')).href);
      app = await startServer({ rootDir: root, port: 0 }); baseUrl = app.url;
    }
    const url = new URL(baseUrl);
    assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'Smoke only targets a local HTTP service.');
    const request = async (path, body) => {
      const response = await fetch(new URL(path, url), { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
      return { status: response.status, body: await response.json() };
    };
    const health = await request('/api/health'); assert.equal(health.status, 200); assert.equal(health.body.ok, true);
    const models = await request('/api/models'); assert.equal(models.status, 200);
    const presets = models.body.models.filter(model => model.kind === 'baseline' && model.available); assert.ok(presets.length, 'The service has no available baseline.');
    const invalid = await request('/api/runs', {}); assert.equal(invalid.status, 400); assert.equal(typeof invalid.body.error, 'string');
    const created = await request('/api/runs', { track: 'strategy', seed: 1733, durationSeconds: 180, factionCount: 2,
      models: [presets[0].id, presets[1]?.id ?? presets[0].id], disaster: false, budget: { maxCalls: 1000, maxCostUsd: 0 } });
    assert.equal(created.status, 201); const id = created.body.run.id, deadline = Date.now() + 120_000;
    let final;
    do {
      const current = await request(`/api/runs/${encodeURIComponent(id)}`); assert.equal(current.status, 200); final = current.body.run;
      if (['completed', 'failed', 'paused'].includes(final.status)) break;
      await delay(150);
    } while (Date.now() < deadline);
    assert.equal(final?.status, 'completed', final?.error ?? 'HTTP baseline did not complete before the deadline.'); assert.equal(final.costUsd, 0);
    const frame = await request(`/api/runs/${encodeURIComponent(id)}/state?tick=20`); assert.equal(frame.status, 200); assert.equal(frame.body.snapshot.tick, 20);
    console.log(JSON.stringify({ smoke: 'verified', cliRunId: baseline.run.id, replayFingerprint: verification.fingerprint,
      http: { url: url.origin, runId: id, tick: final.tick, calls: final.calls, costUsd: final.costUsd, replayTick: frame.body.snapshot.tick } }, null, 2));
  } catch (error) {
    console.error(`Smoke failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
  } finally { await app?.close(); }
}
