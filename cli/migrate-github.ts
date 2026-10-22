import githubV3Migration from '../manifest/github-v3-migration.ts';
import loadCommandManifest from './load-command-manifest.ts';
import presentCliCommand from './presentation.ts';
import { writeCliDiagnosticNotices, writeCliJson, writeCliLines } from './output.ts';
import type { ValidateAgentSystemOptions } from './validate.ts';

/** Print a reviewed migration draft; source application remains an explicit operator edit. */
export default presentCliCommand(async function migrateGitHub(options: ValidateAgentSystemOptions) {
  const loaded = await loadCommandManifest(options);
  if (!loaded) return;
  const result = githubV3Migration(loaded);
  if (options.json) writeCliJson(options.output, result);
  else
    writeCliLines(options.output, [
      `github v3 migration: ${result.status}`,
      ...result.sources.map((path) => `source: ${path}`),
      ...(result.yaml ? ['', result.yaml] : []),
    ]);
  writeCliDiagnosticNotices(
    options,
    result.resolutions.map(({ code, message }) => ({
      severity: 'warning' as const,
      message: `${code}: ${message}`,
    })),
  );
  if (result.resolutions.length) options.setExitCode(1);
});
