import assert from 'node:assert/strict';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import ModelRoutingService, {
  type ModelRoutingRuntime,
} from '../channels/github/conversation/model-routing-service.ts';
import { initializeModelRouting } from '../channels/github/conversation/model-routing.ts';
import type { GitHubNotificationConversationSnapshot } from '../channels/github/conversation/conversation-state.ts';
import type { GitHubNotificationItemContext } from '../channels/github/provider/work-event-types.ts';
import { nativeRoutingMetadata } from '../channels/github/provider/routing-metadata.ts';

const profiles = {
  default: { model: 'openai/gpt-6-astra', effort: 'high' },
  low: { model: 'openai/gpt-5.6-terra', effort: 'medium' },
  medium: { model: 'openai/gpt-5.6-sol', effort: 'high' },
  high: { model: 'openai/gpt-6-astra', effort: 'high' },
} as const;
const route = {
  agentId: 'emori',
  accountId: 'emori',
  channel: 'agent-system-github' as const,
  conversationId: 'github:issue:R_repo:12',
  sessionKey: 'agent:emori:agent-system-github:emori:direct:github:issue:R_repo:12',
  workspaceDir: '/workspace/emori',
  matchedBy: 'binding.account' as const,
};
const context: GitHubNotificationItemContext = {
  title: 'Update a link',
  body: 'A localized README repair.',
  comments: [],
  labels: [],
  truncated: false,
  routingMetadata: nativeRoutingMetadata([{ name: 'Complexity', value: 'Low' }]),
};

function harness() {
  const config: OpenClawConfig = {
    agents: {
      entries: {
        emori: {
          workspace: route.workspaceDir,
          model: profiles.default.model,
          thinkingDefault: 'high',
          models: Object.fromEntries(
            Object.values(profiles).map((profile) => [
              profile.model,
              { agentRuntime: { id: 'codex' } },
            ]),
          ),
        },
      },
    },
  };
  const snapshots = new Map<string, GitHubNotificationConversationSnapshot>();
  const snapshot: GitHubNotificationConversationSnapshot = {
    agentId: route.agentId,
    workspaceDir: route.workspaceDir,
    conversationId: route.conversationId,
    conversation: {
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      baselineEstablished: false,
      revisions: {},
      modelRouting: initializeModelRouting(profiles),
    },
  };
  snapshots.set(snapshot.conversationId, structuredClone(snapshot));
  let entry: ReturnType<ModelRoutingRuntime['session']['getSessionEntry']> = {
    sessionId: 'session-12',
    updatedAt: 1,
    authProfileOverride: 'openai:subscription',
    authProfileOverrideSource: 'user',
    agentRuntimeOverride: 'codex',
  };
  const requests: Parameters<ModelRoutingRuntime['complete']>[0][] = [];
  let complete: ModelRoutingRuntime['complete'] = async (request) => {
    requests.push(request);
    return {
      text: '{"complexity":"low","reason":"Localized README change."}',
      agentId: route.agentId,
      provider: 'openai',
      model: 'gpt-6-astra',
      execution: { mode: 'isolated-agent-runtime', owner: { kind: 'harness', id: 'codex' } },
      usage: {},
      audit: { caller: { kind: 'plugin', id: 'agent-system' } },
    };
  };
  const runtime: ModelRoutingRuntime = {
    complete: (request) => complete(request),
    resolveThinkingPolicy: () => ({
      levels: ['medium', 'high', 'xhigh', 'low'].map((id) => ({
        id: id as 'medium' | 'high' | 'xhigh' | 'low',
        label: id,
      })),
    }),
    resolveAllowedModelRef({ raw }) {
      const [provider, model] = raw.split('/');
      return { ref: { provider: provider!, model: model! }, key: raw };
    },
    session: {
      getSessionEntry() {
        return structuredClone(entry);
      },
      async patchSessionEntry(params) {
        assert.equal(params.agentId, route.agentId);
        assert.equal(params.sessionKey, route.sessionKey);
        if (!entry) return null;
        const changed = await params.update(structuredClone(entry), {
          existingEntry: structuredClone(entry),
        });
        if (changed) {
          assert.ok(changed.sessionId);
          entry = params.replaceEntry
            ? (changed as NonNullable<typeof entry>)
            : { ...entry, ...changed };
        }
        return structuredClone(entry)!;
      },
    },
  };
  const service = new ModelRoutingService({
    runtime,
    readConfig: () => config,
    conversations: {
      async read(_agentId, id) {
        return structuredClone(snapshots.get(id));
      },
      async write(value) {
        snapshots.set(value.conversationId, structuredClone(value));
      },
    },
  });
  return {
    service,
    config,
    runtime,
    requests,
    snapshot,
    snapshots,
    entry: () => entry!,
    setEntry: (value: typeof entry) => {
      entry = value;
    },
    setComplete: (value: typeof complete) => {
      complete = value;
    },
  };
}

describe('channels/github/conversation/model-routing-service', () => {
  it('should classify with the manifest default, persist before work, and reuse the decision', async () => {
    const h = harness();
    await h.service.assess(h.snapshot, context);
    assert.equal(h.requests[0]?.model, profiles.default.model);
    assert.equal(h.requests[0]?.reasoning, 'high');
    assert.equal(h.requests[0]?.execution?.mode, 'isolated-agent-runtime');
    const saved = h.snapshots.get(route.conversationId)!;
    assert.equal(saved.conversation?.modelRouting?.decision?.model, profiles.low.model);
    await h.service.assess(saved, context);
    assert.equal(h.requests.length, 1);
    const applied = await h.service.apply(route);
    assert.deepEqual(applied?.expected, profiles.low);
    assert.equal(h.entry().modelOverride, 'gpt-5.6-terra');
    assert.equal(h.entry().thinkingLevel, 'medium');
    assert.equal(h.entry().authProfileOverride, 'openai:subscription');
    assert.equal(h.entry().agentRuntimeOverride, 'codex');
    assert.equal(h.entry().sessionId, 'session-12');
    assert.equal(h.entry().updatedAt, 1);
    h.config.agents!.entries!.emori!.model = 'openai/gpt-5.6-sol';
    assert.deepEqual((await h.service.apply(route))?.expected, profiles.low);
  });

  it('should preserve explicit model and effort changes independently across follow-ups', async () => {
    const h = harness();
    await h.service.assess(h.snapshot, context);
    await h.service.apply(route);
    h.setEntry({
      ...h.entry(),
      modelOverride: 'gpt-5.6-sol',
      providerOverride: 'openai',
      modelOverrideSource: 'user',
    });
    assert.deepEqual((await h.service.apply(route))?.expected, {
      model: profiles.medium.model,
      effort: 'medium',
    });
    h.setEntry({ ...h.entry(), thinkingLevel: 'low' });
    assert.deepEqual((await h.service.apply(route))?.expected, {
      model: profiles.medium.model,
      effort: 'low',
    });
    assert.deepEqual((await h.service.apply(route))?.expected, {
      model: profiles.medium.model,
      effort: 'low',
    });
    assert.equal(
      h.snapshots.get(route.conversationId)?.conversation?.modelRouting?.overridden,
      true,
    );
  });

  it('should reject missing decisions, missing sessions, unsupported effort, and runtime drift', async () => {
    const h = harness();
    await assert.rejects(h.service.apply(route), /validated routing decision/);
    await h.service.assess(h.snapshot, context);
    h.config.agents!.entries!.emori!.models![profiles.low.model]!.agentRuntime = { id: 'other' };
    await assert.rejects(h.service.apply(route), /runtime or pinned authentication/);
    h.config.agents!.entries!.emori!.models![profiles.low.model]!.agentRuntime = { id: 'codex' };
    h.runtime.resolveThinkingPolicy = () => ({ levels: [] });
    await assert.rejects(h.service.apply(route), /not supported/);
    h.setEntry(undefined);
    await assert.rejects(h.service.apply(route), /could not be applied/);
  });

  it('should retain pending routing after failure, cancellation or wrong classifier attribution', async () => {
    const h = harness();
    h.setComplete(async () => {
      throw Object.assign(new Error('denied'), { code: 'LLM_COMPLETION_NOT_AUTHORIZED' });
    });
    await assert.rejects(h.service.assess(h.snapshot, context), /operator-owned/);
    assert.equal(
      h.snapshots.get(route.conversationId)?.conversation?.modelRouting?.decision,
      undefined,
    );
    const controller = new AbortController();
    h.setComplete(async () => {
      controller.abort();
      return {
        text: '{}',
        agentId: 'other',
        provider: 'openai',
        model: 'other',
        usage: {},
        execution: { mode: 'direct-provider', owner: { kind: 'provider', id: 'openai' } },
        audit: { caller: { kind: 'plugin' } },
      };
    });
    await assert.rejects(h.service.assess(h.snapshot, context, controller.signal), /cancelled/);
    await assert.rejects(h.service.assess(h.snapshot, context), /did not confirm/);
  });

  it('should let another issue finish while one classifier remains stalled', async () => {
    const h = harness();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = h.runtime.complete;
    let calls = 0;
    const good = await original({ messages: [{ role: 'user', content: 'fixture' }] });
    h.setComplete(async () => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return good;
    });
    const first = h.service.assess(h.snapshot, context);
    await entered.promise;
    try {
      const second = structuredClone(h.snapshot);
      second.conversationId = 'github:issue:R_repo:13';
      await h.service.assess(second, context);
      assert.ok(h.snapshots.get(second.conversationId)?.conversation?.modelRouting?.decision);
      assert.equal(
        h.snapshots.get(h.snapshot.conversationId)?.conversation?.modelRouting?.decision,
        undefined,
      );
    } finally {
      release.resolve();
      await first;
    }
  });
});
