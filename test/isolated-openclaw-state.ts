import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Load before the SDK: host channel helpers can access persistence even with fake dispatchers.
const stateDir = mkdtempSync(join(tmpdir(), 'agent-system-unit-'));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = join(stateDir, 'openclaw.json');
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }));
