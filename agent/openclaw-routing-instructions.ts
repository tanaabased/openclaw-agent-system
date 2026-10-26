import type OpenClawDispatchContext from './openclaw-dispatch-context.ts';
import type { OpenClawDispatchTransaction } from './openclaw-dispatch-context.ts';
import openClawSkill from './openclaw-skill.ts';
import routingInstructions from './routing-instructions.ts';

export default function openClawRoutingInstructions(
  context: OpenClawDispatchContext,
  tx: OpenClawDispatchTransaction,
) {
  return routingInstructions({
    configuration: tx.manifest.models?.routing,
    workspace: tx.current.workspace,
    observedAt: tx.now,
    resolveSkill: (id) =>
      context.dependencies.credential.use(tx.authority, (request) =>
        openClawSkill(request, { agentId: tx.manifest.agent.id, key: tx.caller.sessionKey }, id),
      ),
  });
}
