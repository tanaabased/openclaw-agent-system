import { Value } from 'typebox/value';

import { AutomationError } from './automation-gateway.ts';
import {
  projectRoutingProfile,
  selectRoutingOverrides,
  validateRoutingProfiles,
} from './model-routing.ts';
import type { AutomationRuntime, ResolvedAutomation } from '../manifest/automation-schema.ts';
import {
  explicitModelEfforts,
  modelReferenceSchema,
  type AgentModelsConfiguration,
} from '../manifest/models-schema.ts';

/** resolve once before planning or mutation; native adapters validate actual model availability. */
export default function automationModels(
  jobs: ResolvedAutomation[],
  models: AgentModelsConfiguration | undefined,
  runtime: AutomationRuntime,
): ResolvedAutomation[] {
  if (!jobs.some((job) => job.payload.kind === 'prompt' && job.runtimes.includes(runtime)))
    return jobs;
  if (models) validateRoutingProfiles(models);
  return jobs.map((job) => {
    if (job.payload.kind !== 'prompt' || !job.runtimes.includes(runtime)) return job;
    const selector = job.model;
    const profileName = ['default', 'low', 'medium', 'high'].includes(selector ?? '')
      ? (selector as 'default' | 'low' | 'medium' | 'high')
      : undefined;
    const profile = profileName ? models?.[profileName] : models?.default;
    if (profileName && !profile) throw new AutomationError('automation-model-profile-missing');
    const override = job.overrides[runtime];
    const baseModel = profileName ? profile!.model : (selector ?? profile?.model);
    const baseEffort = job.effort ?? profile?.effort;
    if (baseModel !== undefined && !Value.Check(modelReferenceSchema, baseModel))
      throw new AutomationError('automation-model-invalid');
    if (baseModel && baseEffort) selectRoutingOverrides({ model: baseModel, effort: baseEffort });
    const model = override?.model ?? baseModel;
    const effort = override?.effort ?? baseEffort;
    if (effort !== undefined && !(explicitModelEfforts as readonly string[]).includes(effort))
      throw new AutomationError('automation-effort-unsupported');
    if (override?.target && override.target !== 'independent' && (model || effort))
      throw new AutomationError('automation-thread-settings-unowned');
    let nativeModel = model;
    if (runtime === 'codex') {
      if (model?.includes('/')) {
        const projected = projectRoutingProfile({ model, effort: effort ?? 'medium' }, runtime);
        if (projected.status !== 'mapped') throw new AutomationError(projected.code);
        nativeModel = projected.model;
      }
      if (effort === 'off' || effort === 'adaptive')
        throw new AutomationError('codex-model-effort-unsupported');
    }
    if (model === undefined && effort === undefined) return job;
    return {
      ...job,
      overrides: {
        ...job.overrides,
        [runtime]: {
          ...override,
          ...(nativeModel === undefined ? {} : { model: nativeModel }),
          ...(effort === undefined ? {} : { effort }),
        },
      },
    };
  });
}
