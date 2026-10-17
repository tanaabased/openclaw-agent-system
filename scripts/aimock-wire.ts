import type { Mountable } from '@copilotkit/aimock';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 128) : undefined;
}

/** Observe protocol shape without retaining prompts, values, results, or authentication. */
export default function observeAIMockWire() {
  const requests: unknown[] = [];
  const observer: Mountable = {
    async handleRequest(req, res, pathname) {
      if (pathname !== '/responses' || req.method !== 'POST') return false;
      let chunks: Buffer[] = [];
      let bytes = 0;
      // let the owning handler attach its reader before flowing this stream.
      req.pause();
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 2_000_000) chunks.push(chunk);
      });
      req.on('end', () => {
        let shape: Record<string, unknown> = { bytes, truncated: bytes > 2_000_000 };
        if (bytes <= 2_000_000) {
          try {
            const input = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            shape = {
              ...shape,
              model: label(input.model),
              stream: input.stream === true,
              inputTypes: Array.isArray(input.input)
                ? [
                    ...new Set(
                      input.input.map(
                        (item) => label(record(item).type) ?? label(record(item).role),
                      ),
                    ),
                  ]
                : [typeof input.input],
              tools: Array.isArray(input.tools)
                ? input.tools.slice(0, 80).map((tool) => {
                    const entry = record(tool);
                    return {
                      type: label(entry.type),
                      name: label(entry.name),
                      parameterKeys: Object.keys(record(record(entry.parameters).properties)).slice(
                        0,
                        30,
                      ),
                      nestedTools: Array.isArray(entry.tools)
                        ? entry.tools.slice(0, 80).map((nested) => ({
                            type: label(record(nested).type),
                            name: label(record(nested).name),
                          }))
                        : undefined,
                    };
                  })
                : [],
            };
          } catch {
            shape.invalidJson = true;
          }
        }
        chunks = [];
        requests.push(shape);
        if (requests.length > 30) requests.shift();
        res.once('finish', () => {
          shape.status = res.statusCode;
        });
      });
      setImmediate(() => req.resume());
      return false;
    },
  };
  return { observer, requests };
}
