import {
  ErrorCodes,
  isGatewayClientRequestError,
  isGatewayTransportError,
} from 'openclaw/plugin-sdk/gateway-runtime';

export interface GatewayErrorDiagnostic {
  category: 'timeout' | 'closed' | 'rejected' | 'unknown';
  gatewayCode: (typeof ErrorCodes)[keyof typeof ErrorCodes] | null;
  closeCode: number | null;
  requestDispatched: boolean | null;
}

/** retain protocol evidence only; upstream prose and connection details can contain secrets. */
export default function gatewayErrorDiagnostic(error: unknown): GatewayErrorDiagnostic {
  const diagnostic: GatewayErrorDiagnostic = {
    category: 'unknown',
    gatewayCode: null,
    closeCode: null,
    requestDispatched: null,
  };
  if (isGatewayClientRequestError(error))
    return {
      ...diagnostic,
      category: 'rejected',
      gatewayCode: Object.values(ErrorCodes).find((code) => code === error.gatewayCode) ?? null,
    };
  if (isGatewayTransportError(error))
    return {
      ...diagnostic,
      category: error.kind,
      closeCode:
        error.kind === 'closed' &&
        [
          1000, 1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015,
        ].includes(error.code ?? 0)
          ? error.code!
          : null,
      requestDispatched:
        typeof error.requestDispatched === 'boolean' ? error.requestDispatched : null,
    };
  return diagnostic;
}
