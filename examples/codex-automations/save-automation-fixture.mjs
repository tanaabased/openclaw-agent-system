import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse, stringify } from 'smol-toml';

// simulate the desktop save boundary only inside this scenario's isolated home.
const [preparedPath, workspace, codexHome, nativeId] = process.argv.slice(2);
const { request } = JSON.parse(await readFile(preparedPath, 'utf8'));
const fixture = request.kind === 'heartbeat' ? 'heartbeat' : 'project';
const saved = parse(
  await readFile(
    new URL(`../../fixtures/codex-automation-${fixture}.approved.txt`, import.meta.url),
    'utf8',
  ),
);
Object.assign(saved, {
  id: request.id ?? nativeId,
  name: request.name,
  prompt: request.prompt,
  status: request.status,
  rrule: request.rrule,
});
if (request.kind === 'heartbeat') saved.target_thread_id = request.targetThreadId;
else
  Object.assign(saved, {
    model: request.model,
    reasoning_effort: request.reasoningEffort,
    target: { type: 'project', project_id: request.projectId },
    cwds: [workspace],
  });
if (request.notificationPolicy) saved.notification_policy = request.notificationPolicy;
else delete saved.notification_policy;
const directory = join(codexHome, 'automations', saved.id);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'automation.toml'), stringify(saved));
