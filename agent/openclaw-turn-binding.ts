import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

type Binding = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  inputId?: string;
};
const namespace = 'task-input';

/** the host expires this native input binding on run end; no workflow journal is added. */
export function retainOpenClawTurnInput(
  runtime: OpenClawPluginApi['runContext'] | undefined,
  binding: Binding,
) {
  const { agentId, sessionKey, sessionId, runId, inputId } = binding;
  if (!runtime || !agentId || !sessionKey || !sessionId || !runId || !inputId) return;
  runtime.setRunContext({ runId, namespace, value: { agentId, sessionKey, sessionId, inputId } });
}

export function readOpenClawTurnInput(
  runtime: OpenClawPluginApi['runContext'] | undefined,
  binding: Binding,
) {
  if (!runtime || !binding.runId) return;
  const value = runtime.getRunContext({ runId: binding.runId, namespace });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (
    value.agentId !== binding.agentId ||
    value.sessionKey !== binding.sessionKey ||
    value.sessionId !== binding.sessionId ||
    typeof value.inputId !== 'string' ||
    !value.inputId
  )
    throw new Error('turn-context-native-caller-changed');
  return value.inputId;
}
