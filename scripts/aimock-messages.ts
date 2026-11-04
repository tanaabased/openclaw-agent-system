import { getTextContent, type ChatCompletionRequest } from '@copilotkit/aimock';

export function isOpenClawAIMockRuntimeContext(content: string): boolean {
  return ['<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>', 'OpenClaw runtime context:'].some((prefix) =>
    content.trimStart().startsWith(prefix),
  );
}

export default function currentOpenClawAIMockMessages(request: ChatCompletionRequest) {
  const messages = request.messages ?? [];
  const boundary = messages.findLastIndex(
    ({ role, content }) =>
      role === 'user' && !isOpenClawAIMockRuntimeContext(getTextContent(content) ?? ''),
  );
  return messages.slice(Math.max(0, boundary));
}
