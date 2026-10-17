import gatewayErrorDiagnostic, {
  type GatewayErrorDiagnostic,
} from '../utils/gateway-error-diagnostic.ts';
import type { AutomationGateway } from './automation-gateway.ts';

export interface AutomationGatewayDiagnostic extends GatewayErrorDiagnostic {
  method: Parameters<AutomationGateway>[0];
}

export default function automationGatewayDiagnostic(
  method: Parameters<AutomationGateway>[0],
  error: unknown,
): AutomationGatewayDiagnostic {
  return { method, ...gatewayErrorDiagnostic(error) };
}
