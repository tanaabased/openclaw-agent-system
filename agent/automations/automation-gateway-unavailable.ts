import { isGatewayTransportError } from 'openclaw/plugin-sdk/gateway-runtime';

/** recognize pre-request unavailability, never policy closures or uncertain dispatched requests. */
export default function automationGatewayUnavailable(error: unknown): boolean {
  if (!isGatewayTransportError(error)) return false;
  if (error.kind === 'timeout') return error.requestDispatched === false;
  // the sdk's socket-unreachable wrapper has neither a close frame nor dispatch metadata.
  if (error.code === undefined && error.requestDispatched === undefined) return true;
  return error.requestDispatched === false && [1006, 1012].includes(error.code ?? 0);
}
