import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  applyModelOverrideToSessionEntry,
  resolveSessionModelRef,
} from 'openclaw/plugin-sdk/model-session-runtime';

import { configuredAgentValue } from '../../../core/configured-agents.ts';
import type { GitHubNotificationItemContext } from '../provider/work-event-types.ts';
import type { ResolvedNotificationRoute } from '../routing/routing.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type { GitHubNotificationConversationSnapshot } from './conversation-state.ts';
import {
  ModelRoutingError,
  modelRoutingDecision,
  modelRoutingGuidance,
  modelRoutingInstructions,
  type RoutedProfile,
} from './model-routing.ts';

type Runtime = OpenClawPluginApi['runtime'];
export interface ModelRoutingRuntime {
  complete: Runtime['llm']['complete'];
  session: Pick<Runtime['agent']['session'], 'getSessionEntry' | 'patchSessionEntry'>;
  resolveThinkingPolicy: Runtime['agent']['resolveThinkingPolicy'];
  resolveAllowedModelRef: Runtime['modelConfig']['resolveAllowedModelRef'];
}
export interface ModelRoutingServiceDependencies {
  runtime: ModelRoutingRuntime;
  conversations: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

function ref(model: string) {
  const index = model.indexOf('/');
  return { provider: model.slice(0, index), model: model.slice(index + 1) };
}

/** Support one model-authored decision with durable ownership and native execution controls. */
export default class ModelRoutingService {
  constructor(readonly dependencies: ModelRoutingServiceDependencies) {}

  #validate(config: OpenClawConfig, agentId: string, profile: RoutedProfile): string {
    const model = ref(profile.model);
    const runtime = configuredAgentValue(config, agentId)?.models?.[profile.model]?.agentRuntime
      ?.id;
    if (!runtime || runtime === 'auto' || runtime === 'default') {
      throw new ModelRoutingError(
        'github-notification-routing-model-not-ready',
        'The selected model has no verified agent runtime binding. Run Agent System doctor and install before retrying.',
      );
    }
    const allowed = this.dependencies.runtime.resolveAllowedModelRef({
      cfg: config,
      agentId,
      catalog: [],
      raw: profile.model,
      defaultProvider: model.provider,
      defaultModel: model.model,
    });
    if (
      'error' in allowed ||
      `${allowed.ref.provider}/${allowed.ref.model}` !== profile.model ||
      !this.dependencies.runtime
        .resolveThinkingPolicy({ ...model, agentRuntime: runtime })
        .levels.some(({ id }) => id === profile.effort)
    ) {
      throw new ModelRoutingError(
        'github-notification-routing-profile-unsupported',
        'The selected model and effort are not supported by the configured native route. No substitute model was selected.',
      );
    }
    return runtime;
  }

  async assess(
    snapshot: GitHubNotificationConversationSnapshot,
    context: GitHubNotificationItemContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const routing = snapshot.conversation?.modelRouting;
    if (!routing || routing.decision) return;
    const config = await this.dependencies.readConfig();
    this.#validate(config, snapshot.agentId, routing.profiles.default);
    let result: Awaited<ReturnType<ModelRoutingRuntime['complete']>>;
    try {
      result = await this.dependencies.runtime.complete({
        agentId: snapshot.agentId,
        model: routing.profiles.default.model,
        reasoning: routing.profiles.default.effort,
        execution: { mode: 'isolated-agent-runtime', timeoutMs: 60_000 },
        systemPrompt: modelRoutingInstructions,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              profiles: routing.profiles,
              issue: {
                title: context.title,
                body: context.body.slice(0, 12_000),
                comments: context.comments
                  .slice(-5)
                  .map((comment) => ({ ...comment, body: comment.body.slice(0, 1_000) })),
                routingMetadata: context.routingMetadata,
                truncated:
                  context.truncated ||
                  context.body.length > 12_000 ||
                  context.comments.length > 5 ||
                  context.comments.some((comment) => comment.body.length > 1_000),
              },
            }),
          },
        ],
        maxTokens: 600,
        purpose: 'agent-system.github.issue-model-routing',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      throw new ModelRoutingError(
        'github-notification-routing-classification-failed',
        code === 'LLM_COMPLETION_NOT_AUTHORIZED'
          ? 'Routing requires the operator-owned Agent System LLM grant for agent and model selection. Run openclaw agent-system install from the agent workspace, reload the Gateway if needed, then retry the same prepared assignment.'
          : 'The tool-free routing assessment failed. Check the native runtime and retry this issue; substantive work has not started.',
        { cause: error },
      );
    }
    if (signal?.aborted)
      throw new ModelRoutingError(
        'github-notification-routing-aborted',
        'Routing was cancelled before work.',
      );
    if (
      result.agentId !== snapshot.agentId ||
      `${result.provider}/${result.model}` !== routing.profiles.default.model ||
      result.execution.mode !== 'isolated-agent-runtime'
    ) {
      throw new ModelRoutingError(
        'github-notification-routing-classifier-mismatch',
        'The native classifier did not confirm the requested agent, model, and isolated runtime.',
      );
    }
    const decision = modelRoutingDecision(result.text, routing, context);
    const classifierRuntime = this.#validate(config, snapshot.agentId, routing.profiles.default);
    if (this.#validate(config, snapshot.agentId, decision) !== classifierRuntime) {
      throw new ModelRoutingError(
        'github-notification-routing-runtime-mismatch',
        'The selected work profile would change the established agent runtime. Repair its model bindings first.',
      );
    }
    const next = structuredClone(snapshot);
    next.conversation!.modelRouting!.decision = decision;
    await this.dependencies.conversations.write(next);
  }

  /** Called only after the channel kernel has created or recorded this exact session. */
  async apply(
    route: ResolvedNotificationRoute,
  ): Promise<{ expected: RoutedProfile; guidance: string } | undefined> {
    const snapshot = await this.dependencies.conversations.read(
      route.agentId,
      route.conversationId,
    );
    const routing = snapshot?.conversation?.modelRouting;
    if (!routing) return undefined;
    if (!routing.decision || snapshot?.workspaceDir !== route.workspaceDir) {
      throw new ModelRoutingError(
        'github-notification-routing-decision-missing',
        'A validated routing decision is required before this conversation can run.',
      );
    }
    const config = await this.dependencies.readConfig();
    let selected: RoutedProfile | undefined;
    let overridden = false;
    const entry = await this.dependencies.runtime.session.patchSessionEntry({
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      readConsistency: 'latest',
      preserveActivity: true,
      update: (current, { existingEntry }) => {
        if (!existingEntry)
          throw new ModelRoutingError(
            'github-notification-routing-session-missing',
            'The channel session has not been created.',
          );
        const currentModel = resolveSessionModelRef(config, current, route.agentId);
        const currentRef = `${currentModel.provider}/${currentModel.model}`;
        const humanModel =
          current.modelOverrideSource === 'user' ||
          current.modelSelectionLocked === true ||
          Boolean(current.modelOverride && current.modelOverrideSource === undefined);
        const humanEffort = Boolean(
          current.thinkingLevel && current.thinkingLevel !== routing.applied?.effort,
        );
        selected = {
          model: humanModel ? currentRef : routing.decision!.model,
          effort: humanEffort
            ? current.thinkingLevel!
            : (routing.applied?.effort ?? routing.decision!.effort),
        };
        const runtime = this.#validate(config, route.agentId, selected);
        if (
          !humanModel &&
          (runtime !== this.#validate(config, route.agentId, routing.profiles.default) ||
            (current.agentRuntimeOverride && current.agentRuntimeOverride !== runtime) ||
            (current.authProfileOverride && currentModel.provider !== ref(selected.model).provider))
        ) {
          throw new ModelRoutingError(
            'github-notification-routing-runtime-mismatch',
            'Routing cannot change the session runtime or pinned authentication route.',
          );
        }
        overridden =
          selected.model !== routing.decision!.model ||
          selected.effort !== routing.decision!.effort;
        if (current.modelSelectionLocked) {
          if (current.thinkingLevel !== selected.effort)
            throw new ModelRoutingError(
              'github-notification-routing-session-locked',
              'The locked native session must supply its own supported model and effort.',
            );
          return null;
        }
        const updated = structuredClone(current);
        if (!humanModel)
          applyModelOverrideToSessionEntry({
            entry: updated,
            selection: ref(selected.model),
            selectionSource: 'auto',
            preserveAuthProfileOverride: true,
            markLiveSwitchPending: true,
          });
        updated.thinkingLevel = selected.effort;
        updated.updatedAt = current.updatedAt;
        // Return the complete entry so native-cleared stale runtime fields stay cleared.
        return updated;
      },
      replaceEntry: true,
    });
    if (!entry || !selected)
      throw new ModelRoutingError(
        'github-notification-routing-session-missing',
        'Native routing settings could not be applied.',
      );
    const next = structuredClone(snapshot);
    next.conversation!.modelRouting!.applied = selected;
    next.conversation!.modelRouting!.overridden = overridden;
    await this.dependencies.conversations.write(next);
    return { expected: selected, guidance: modelRoutingGuidance(next.conversation!.modelRouting) };
  }
}
