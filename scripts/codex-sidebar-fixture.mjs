import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// headless ci boundary: real app-server chats, explicitly simulated desktop sidebar replies.
const [runtime, pluginData, inputPath] = process.argv.slice(2);
const input = existsSync(inputPath)
  ? JSON.parse(readFileSync(inputPath, 'utf8'))
  : {
      nativeInventory: {
        schemaVersion: 4,
        unavailableHosts: [],
        unavailableSources: [],
        sections: [{ sectionId: 'fixture-lowercase', name: 'agent system', itemKeys: [] }],
      },
    };
const call = (operation) => {
  const result = spawnSync(
    process.execPath,
    [runtime, 'automations', operation, '--plugin-data', pluginData],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 120000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
};
for (let attempt = 0; attempt < 10; attempt++) {
  input.digest = call('plan').digest;
  const result = call('threads-sync');
  if (result.status === 'verified') {
    delete input.placementReceipt;
    writeFileSync(inputPath, JSON.stringify(input));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  assert.equal(result.status, 'native-action', JSON.stringify(result));
  const sections = input.nativeInventory.sections;
  const args = result.request.arguments;
  let sectionId;
  if (result.request.tool === 'create_sidebar_section') {
    assert.equal(args.name, args.name.toUpperCase());
    sectionId = `fixture-section-${sections.length}`;
    sections.push({ sectionId, name: args.name, itemKeys: [] });
  } else {
    assert.equal(result.request.tool, 'move_thread_to_sidebar_section');
    sectionId = args.sectionId;
    const section = sections.find((entry) => entry.sectionId === sectionId);
    assert.ok(section);
    const key = `codex:thread:local:${args.threadId}`;
    for (const entry of sections) entry.itemKeys = entry.itemKeys.filter((item) => item !== key);
    section.itemKeys.push(key);
  }
  input.placementReceipt = { digest: result.digest, sectionId };
  writeFileSync(inputPath, JSON.stringify(input));
}
throw new Error('sidebar fixture reconciliation did not finish');
