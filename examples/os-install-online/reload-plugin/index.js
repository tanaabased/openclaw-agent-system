import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
  id: 'enrollment-reload-fixture',
  name: 'Enrollment Reload Fixture',
  register(api) {
    const directory = process.env.AGENT_SYSTEM_TEST_RELOAD_DIR;
    if (!directory || !api.pluginConfig?.slow || existsSync(join(directory, 'started.json')))
      return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'started.json'), JSON.stringify({ startedAt: Date.now() }));
    // deliberately block only the disposable gateway, never the install cli or operator host.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 18_000);
    writeFileSync(join(directory, 'completed.json'), JSON.stringify({ completedAt: Date.now() }));
  },
};
