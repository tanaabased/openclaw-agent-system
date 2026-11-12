type MaterialTransport = { argv: string[] } | { tool: string };

/** attach the native reader once; page envelopes remain unchanged and stateless. */
export default function contextMaterialTransport(value: unknown, transport: MaterialTransport) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!('contextMaterials' in value) && !('materialPage' in value)) return value;
  return {
    ...value,
    materialTransport: transport,
  };
}
