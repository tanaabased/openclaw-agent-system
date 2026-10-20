/** Only a definitive provider rejection permits another creation attempt. */
export default function providerWriteRejected(error: unknown) {
  const diagnostic =
    error && typeof error === 'object' && 'providerDiagnostic' in error
      ? error.providerDiagnostic
      : undefined;
  if (!diagnostic || typeof diagnostic !== 'object' || !('httpStatus' in diagnostic)) return false;
  const status = diagnostic.httpStatus;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}
