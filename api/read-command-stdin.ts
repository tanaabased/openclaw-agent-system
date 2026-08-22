import type { Readable } from 'node:stream';

export const maximumToolCommandStdinBytes = 65_536;

/** Read redirected command input without waiting on an interactive terminal. */
export default async function readToolCommandStdin(
  input: Readable | undefined,
): Promise<string | undefined> {
  if (!input || (input as Readable & { isTTY?: boolean }).isTTY === true) return undefined;

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    totalBytes += buffer.byteLength;
    if (totalBytes > maximumToolCommandStdinBytes) {
      throw new RangeError('Tool command standard input exceeds the supported size limit.');
    }
    chunks.push(buffer);
  }

  return totalBytes === 0 ? undefined : Buffer.concat(chunks, totalBytes).toString('utf8');
}
