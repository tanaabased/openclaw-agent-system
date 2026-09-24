import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import {
  externalAgentModelsSchema,
  type AgentModelsConfiguration,
} from '../manifest/models-schema.ts';

export const profileSchema = externalAgentModelsSchema.properties.default;
export const selectedProfileSchema = Type.Object(
  {
    model: profileSchema.properties.model,
    effort: Type.String({ minLength: 1, maxLength: 20, pattern: '^[a-z]+$' }),
  },
  { additionalProperties: false },
);
export const assessmentSchema = Type.Object(
  {
    complexity: Type.Union([
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('unset'),
    ]),
    reason: Type.String({ minLength: 1, maxLength: 400, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
    xhighReason: Type.Optional(
      Type.String({ minLength: 1, maxLength: 400, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
    ),
  },
  { additionalProperties: false },
);
export type RoutingAssessment = Static<typeof assessmentSchema>;
export type RoutingSelection = Static<typeof selectedProfileSchema>;
export type RoutingEvidence = {
  complexity: 'low' | 'medium' | 'high';
  source: 'user' | 'native' | 'body fallback';
};
export type RoutingOverrides = Partial<RoutingSelection>;
export interface RoutingDecision extends RoutingAssessment {
  status: 'resolved' | 'unresolved';
  profile: 'default' | 'low' | 'medium' | 'high' | null;
  source: RoutingEvidence['source'] | 'assessed' | 'unset';
  recommendation?: RoutingSelection;
  selection?: RoutingSelection;
  overrides: RoutingOverrides;
}

export class RoutingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

export const modelRoutingRubric = [
  'Use the shared model-neutral rubric: low means established, localized work with little uncertainty; medium means interacting concerns or meaningful investigation; high means novel, architectural or cross-system reasoning with substantial uncertainty. Consider correctness risk, not just size.',
  'Explicit user Complexity or verified metadata determines the tier. Otherwise make a labeled content assessment. Use unset if no tier is defensible. Work size informs scope and decomposition only: 13 merits review and 21 normally splitting; neither upgrades the model.',
  'Use model and effort from the configured profile, never a built-in tier mapping. Automatic efforts are the manifest schema values. Supply a concrete xhighReason when the selected profile, classifier profile, or explicit selection uses xhigh. No fallback model chains or infrastructure-driven escalation.',
].join('\n\n');

export const modelRoutingReportGuidance =
  'After the initial assessment prose, include one short Markdown blockquote labeled **Model routing**, naming the saved model, effort, complexity, evidence source and brief reason. Explain explicit overrides and any unresolved assessment using the configured default. Report recommendation, requested application, and verified execution separately; selection is not proof of effective runtime settings. Preserve the selection on ordinary follow-ups, resume, and compaction.';

export function validateRoutingProfiles(models: AgentModelsConfiguration): void {
  const tiers = [models.low, models.medium, models.high];
  if (
    !Value.Check(externalAgentModelsSchema, models) ||
    (tiers.some(Boolean) && !tiers.every(Boolean))
  ) {
    throw new RoutingError(
      'model-routing-profiles-invalid',
      'Model profiles must contain default and either all work tiers or none.',
    );
  }
}

export function selectRoutingOverrides(
  profile: RoutingSelection,
  overrides: RoutingOverrides = {},
): RoutingSelection {
  const selection = { ...profile, ...overrides };
  if (
    !Value.Check(selectedProfileSchema, selection) ||
    ![
      'none',
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'adaptive',
      'max',
      'ultra',
    ].includes(selection.effort)
  ) {
    throw new RoutingError(
      'model-routing-selection-unsupported',
      'The explicit model or effort is unsupported. No substitute was selected.',
    );
  }
  return selection;
}

/** resolve judgment supplied by a caller; never classify, choose an implicit fallback, or apply a session change. */
export function resolveModelRouting(
  models: AgentModelsConfiguration,
  assessment: unknown,
  options: {
    evidence?: RoutingEvidence;
    overrides?: RoutingOverrides;
    fallback?: 'default';
    classifierEffort?: string;
  } = {},
): RoutingDecision {
  validateRoutingProfiles(models);
  if (!Value.Check(assessmentSchema, assessment) || !assessment.reason.trim()) {
    throw new RoutingError(
      'model-routing-assessment-invalid',
      'Supply a valid bounded assessment and reason.',
    );
  }
  if (
    options.evidence &&
    assessment.complexity !== 'unset' &&
    assessment.complexity !== options.evidence.complexity
  ) {
    throw new RoutingError(
      'model-routing-metadata-conflict',
      'The assessment contradicts explicit or verified Complexity.',
    );
  }
  const unresolved = assessment.complexity === 'unset';
  const requestedProfile = assessment.complexity === 'unset' ? null : assessment.complexity;
  const profile =
    requestedProfile && models[requestedProfile]
      ? requestedProfile
      : (options.fallback ?? requestedProfile);
  const recommendation = profile ? models[profile] : undefined;
  if (profile && !recommendation) {
    throw new RoutingError(
      'model-routing-profile-missing',
      'The requested work tier is not configured. Select default explicitly or supply an explicit selection.',
    );
  }
  const overrides = options.overrides ?? {};
  // validate partial overrides even when unresolved work has no selected profile.
  selectRoutingOverrides(models.default, overrides);
  const selection = recommendation
    ? selectRoutingOverrides(recommendation, overrides)
    : overrides.model && overrides.effort
      ? selectRoutingOverrides({ model: overrides.model, effort: overrides.effort })
      : undefined;
  if (
    (overrides.effort === 'xhigh' ||
      recommendation?.effort === 'xhigh' ||
      selection?.effort === 'xhigh' ||
      options.classifierEffort === 'xhigh') &&
    !assessment.xhighReason?.trim()
  ) {
    throw new RoutingError(
      'model-routing-xhigh-unjustified',
      'Routing selected xhigh without a concrete reasoning justification.',
    );
  }
  return {
    ...assessment,
    status: unresolved ? 'unresolved' : 'resolved',
    profile,
    source: unresolved ? 'unset' : (options.evidence?.source ?? 'assessed'),
    ...(recommendation ? { recommendation: { ...recommendation } } : {}),
    ...(selection ? { selection } : {}),
    overrides: { ...overrides },
  };
}

/** project desired state only; native controls remain authoritative for availability. */
export function projectRoutingProfile(profile: RoutingSelection, runtime: 'codex' | 'openclaw') {
  if (runtime === 'openclaw')
    return {
      status: 'mapped' as const,
      sourceModel: profile.model,
      model: profile.model,
      thinking: profile.effort,
    };
  if (!profile.model.startsWith('openai/'))
    return {
      status: 'unsupported' as const,
      code: 'codex-model-provider-unsupported',
      sourceModel: profile.model,
      thinking: profile.effort,
      message: 'Standalone Codex model routing supports only openai provider references.',
    };
  if (profile.effort === 'off' || profile.effort === 'adaptive')
    return {
      status: 'unsupported' as const,
      code: 'codex-model-effort-unsupported',
      sourceModel: profile.model,
      thinking: profile.effort,
      message: 'The selected effort has no supported Codex task mapping.',
    };
  return {
    status: 'mapped' as const,
    sourceModel: profile.model,
    model: profile.model.slice('openai/'.length),
    thinking: profile.effort,
  };
}

export function inspectModelRouting(
  models: AgentModelsConfiguration | undefined,
  runtime: 'codex' | 'openclaw',
) {
  if (!models) return { status: 'unavailable' as const, code: 'model-routing-not-configured' };
  validateRoutingProfiles(models);
  return {
    status: 'available' as const,
    profiles: Object.fromEntries(
      Object.entries(models).map(([name, profile]) => [
        name,
        projectRoutingProfile(profile, runtime),
      ]),
    ),
    rubric: modelRoutingRubric,
    reportGuidance: modelRoutingReportGuidance,
  };
}
