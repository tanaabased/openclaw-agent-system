import normalizeAutomations, {
  automationDiagnostic,
  type ResolvedAutomation,
} from './automation-schema.ts';
import { parseManifestYaml } from './parse.ts';
import readManifestFile, { type ManifestFileDependency } from './read-file.ts';
import type { ManifestDiagnostic, ParsedAgentManifest } from './types.ts';

/** resolve the single yaml include and its prompt references before exposing desired jobs. */
export default async function loadAutomations(
  parsed: Extract<ParsedAgentManifest, { status: 'valid' }>,
  manifestPath: string,
  workspaceDir: string,
): Promise<
  | { status: 'valid'; automations: ResolvedAutomation[]; files: ManifestFileDependency[] }
  | { status: 'invalid'; diagnostics: ManifestDiagnostic[]; paths: string[] }
> {
  const files: ManifestFileDependency[] = [];
  let declarations = parsed.automations ?? [];
  let containingPath = manifestPath;
  if (parsed.automationsFile !== undefined) {
    const loaded = await readManifestFile(
      parsed.automationsFile,
      manifestPath,
      workspaceDir,
      '/automations',
      'manifest-automation-file',
    );
    if (loaded.status === 'invalid') return { ...loaded, paths: loaded.path ? [loaded.path] : [] };
    files.push({ path: loaded.path, fingerprint: loaded.fingerprint });
    containingPath = loaded.path;
    const yaml = parseManifestYaml(loaded.source);
    const normalized = yaml.status === 'valid' ? normalizeAutomations(yaml.value) : yaml;
    if (normalized.status === 'invalid')
      return {
        status: 'invalid',
        paths: files.map((file) => file.path),
        diagnostics: normalized.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          fieldPath: diagnostic.fieldPath ?? '/automations',
          message: `Automation file ${JSON.stringify(parsed.automationsFile)}: ${diagnostic.message}`,
        })),
      };
    declarations = normalized.automations;
  }
  const automations: ResolvedAutomation[] = [];
  for (const [index, job] of declarations.entries()) {
    if (job.payload.kind === 'command' || typeof job.payload.prompt === 'string') {
      automations.push(job as ResolvedAutomation);
      continue;
    }
    const fieldPath = `/automations/${index}/prompt`;
    const loaded = await readManifestFile(
      job.payload.prompt.file,
      containingPath,
      workspaceDir,
      fieldPath,
      'manifest-automation-prompt-file',
    );
    if (loaded.status === 'invalid')
      return {
        ...loaded,
        paths: [...files.map((file) => file.path), ...(loaded.path ? [loaded.path] : [])],
      };
    files.push({ path: loaded.path, fingerprint: loaded.fingerprint });
    if (!loaded.source.trim() || loaded.source.includes('\0'))
      return {
        status: 'invalid',
        paths: files.map((file) => file.path),
        diagnostics: [automationDiagnostic('manifest-automation-prompt-content', fieldPath)],
      };
    automations.push({ ...job, payload: { kind: 'prompt', prompt: loaded.source } });
  }
  return { status: 'valid', automations, files };
}
