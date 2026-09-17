/** Normalize configured model evidence across supported OpenClaw JSON representations. */
export default function parseModelCatalogRows(stdout: string) {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(Reflect.get(parsed, 'models'))) {
    throw new Error('OpenClaw models list returned an invalid JSON result.');
  }
  return Reflect.get(parsed, 'models').map((value: unknown) => {
    if (!value || typeof value !== 'object') {
      throw new Error('OpenClaw models list returned an invalid model row.');
    }
    const key = Reflect.get(value, 'key');
    const available = Reflect.get(value, 'available');
    const missing = Reflect.get(value, 'missing');
    if (
      typeof key !== 'string' ||
      (available !== null && typeof available !== 'boolean') ||
      (missing !== undefined && typeof missing !== 'boolean')
    ) {
      throw new Error('OpenClaw models list returned an invalid model row.');
    }
    return { available, key, missing: missing ?? false };
  });
}
