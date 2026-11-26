import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import type { AgentSystemLifecycleFinding } from '../core/lifecycle-registry.ts';
import { enrollmentPage, type EnrollmentScreen } from './codex-op-page.ts';
import type { OpEnvironmentRequirements } from '../environment/op-requirements.ts';
import { isCredentialValueValid, maximumCredentialBytes } from './types.ts';

export interface EnrollmentOutcome {
  finding: AgentSystemLifecycleFinding;
  screen: EnrollmentScreen;
}

interface Enrollment {
  label: string;
  requirements: OpEnvironmentRequirements;
  environmentToken?: string;
  save(token: string): Promise<EnrollmentOutcome>;
  onReady(url: string): void;
  timeoutMs?: number;
}

function respond(res: ServerResponse, code: number, text: string, html = false, nonce?: string) {
  res.writeHead(code, {
    'Content-Type': (html ? 'text/html' : 'text/plain') + '; charset=utf-8',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" +
      (nonce ? `; script-src 'nonce-${nonce}'` : ''),
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  res.end(text);
}

async function readForm(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 3 * maximumCredentialBytes + 128) return;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function stopped(code: string, message: string): AgentSystemLifecycleFinding {
  return { component: 'credentials', status: 'blocked', code, message };
}

/** Keep the original Install process alive until the operator submits, cancels or times out. */
export async function browserEnrollment(options: Enrollment): Promise<AgentSystemLifecycleFinding> {
  const path = '/' + randomBytes(32).toString('hex');
  const page = {
    label: options.label,
    requirements: options.requirements,
    canImport: Boolean(options.environmentToken),
  };
  const showForm = (res: ServerResponse, invalid = false) => {
    const nonce = randomBytes(18).toString('base64');
    respond(
      res,
      invalid ? 400 : 200,
      enrollmentPage(page, invalid ? 'invalid' : 'entry', nonce),
      true,
      nonce,
    );
  };
  const completed = Promise.withResolvers<AgentSystemLifecycleFinding>();
  let origin: string;
  let accepting = true;
  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    async (req, res) => {
      let submitted = false;
      try {
        if (req.url !== path || 'http://' + req.headers.host !== origin)
          return respond(res, 404, 'Link unavailable.');
        if (req.method === 'GET') {
          return accepting ? showForm(res) : respond(res, 409, enrollmentPage(page, 'used'), true);
        }
        if (
          req.method !== 'POST' ||
          req.headers.origin !== origin ||
          req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded'
        )
          return respond(res, 403, 'Request refused.');
        if (!accepting) return respond(res, 409, enrollmentPage(page, 'used'), true);
        const form = await readForm(req);
        if (!accepting) return respond(res, 409, enrollmentPage(page, 'used'), true);
        if (!form) return showForm(res, true);
        const action = form.get('action');
        const token = action === 'import' ? options.environmentToken : form.get('token');
        if (
          action !== 'cancel' &&
          (!(action === 'save' || action === 'import') || !token || !isCredentialValueValid(token))
        )
          return showForm(res, true);
        accepting = false;
        submitted = true;
        const result: EnrollmentOutcome =
          action === 'cancel'
            ? {
                screen: 'cancelled',
                finding: stopped('op-credential-input-cancelled', 'Enrollment cancelled.'),
              }
            : await options.save(token!);
        completed.resolve(result.finding);
        respond(res, 200, enrollmentPage(page, result.screen), true);
      } catch {
        if (req.aborted && accepting) return;
        const result = stopped(
          'op-credential-enrollment-incomplete',
          'Enrollment could not be confirmed. Run Doctor to check the stored credential.',
        );
        if (submitted) completed.resolve(result);
        if (!res.headersSent && !res.destroyed) {
          respond(res, 500, enrollmentPage(page, submitted ? 'uncertain' : 'unavailable'), true);
        }
      }
    },
  );
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch {
    return stopped(
      'op-credential-loopback-unavailable',
      'Agent System could not open a temporary port on 127.0.0.1 for enrollment.',
    );
  }
  const timer = setTimeout(
    () => {
      if (!accepting) return;
      accepting = false;
      server.closeAllConnections();
      completed.resolve(
        stopped('op-credential-input-expired', 'The 1Password enrollment link expired.'),
      );
    },
    options.timeoutMs ?? 5 * 60_000,
  );
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Local enrollment is unavailable.');
    origin = 'http://127.0.0.1:' + address.port;
    options.onReady(origin + path);
    return await completed.promise;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
