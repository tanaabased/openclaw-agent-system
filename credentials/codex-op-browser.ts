import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import type { AgentSystemLifecycleFinding } from '../core/lifecycle-registry.ts';
import type { OpEnvironmentRequirements } from '../environment/op-requirements.ts';
import { isCredentialValueValid, maximumCredentialBytes } from './types.ts';

interface Enrollment {
  label: string;
  requirements: OpEnvironmentRequirements;
  environmentToken?: string;
  save(token: string): Promise<AgentSystemLifecycleFinding>;
  onReady(url: string): void;
  timeoutMs?: number;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function page(options: Enrollment) {
  const resources = [
    ...options.requirements.environmentIds,
    ...options.requirements.secrets.map((s) => s.reference),
  ];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect 1Password · Agent System</title>
<style>:root{color-scheme:light dark;font:1rem/1.5 system-ui}main{margin:8vh auto;padding:1rem;max-width:37rem}input,button{font:inherit;padding:.5rem}input{width:95%}button{margin:.6rem .3rem 0 0}code{overflow-wrap:anywhere}</style>
<main><h1>Connect 1Password</h1><p>Allow Agent System to use these resources for unattended work in ${escapeHtml(options.label)}.</p>
<ul>${resources.map((r) => '<li><code>' + escapeHtml(r) + '</code></li>').join('')}</ul>
<p>Agent System checks access before saving the token in your OS credential store.
<a href="https://developer.1password.com/docs/service-accounts/get-started/" target="_blank" rel="noreferrer">Create a service account</a></p>
<form method="post" autocomplete="off"><label>1Password service-account token<input name="token" type="password" autocomplete="off" required></label>
<button name="action" value="save">Verify and save</button></form>
<form method="post">${options.environmentToken ? '<button name="action" value="import">Use OP_SERVICE_ACCOUNT_TOKEN from the Install environment</button>' : ''}
<button name="action" value="cancel">Cancel</button></form></main></html>`;
}

function respond(res: ServerResponse, code: number, text: string, html = false) {
  res.writeHead(code, {
    'Content-Type': (html ? 'text/html' : 'text/plain') + '; charset=utf-8',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
  const completed = Promise.withResolvers<AgentSystemLifecycleFinding>();
  let origin: string;
  let accepting = true;
  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    async (req, res) => {
      let submitted = false;
      try {
        if (!accepting || req.url !== path || 'http://' + req.headers.host !== origin)
          return respond(res, 404, 'Link unavailable.');
        if (req.method === 'GET') return respond(res, 200, page(options), true);
        if (
          req.method !== 'POST' ||
          req.headers.origin !== origin ||
          req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded'
        )
          return respond(res, 403, 'Request refused.');
        const form = await readForm(req);
        if (!form || !accepting) return respond(res, 400, 'Request unavailable.');
        const action = form.get('action');
        const token = action === 'import' ? options.environmentToken : form.get('token');
        if (
          action !== 'cancel' &&
          (!(action === 'save' || action === 'import') || !token || !isCredentialValueValid(token))
        )
          return respond(
            res,
            400,
            'Enter a valid token. Return to the enrollment page to try again.',
          );
        accepting = false;
        submitted = true;
        const result =
          action === 'cancel'
            ? stopped('op-credential-input-cancelled', 'Enrollment cancelled.')
            : await options.save(token!);
        respond(
          res,
          200,
          result.status === 'healthy'
            ? '1Password access verified. Return to the Install chat for the Doctor report.'
            : result.message,
        );
        completed.resolve(result);
      } catch {
        if (req.aborted && accepting) return;
        const result = stopped(
          'op-credential-enrollment-incomplete',
          'Enrollment could not be confirmed. Run Doctor to check the stored credential.',
        );
        respond(res, 500, result.message);
        if (submitted) completed.resolve(result);
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
