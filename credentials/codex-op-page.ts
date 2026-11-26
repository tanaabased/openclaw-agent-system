import type { OpEnvironmentRequirements } from '../environment/op-requirements.ts';

export type EnrollmentScreen =
  'connected' | 'cancelled' | 'rejected' | 'access' | 'store' | 'uncertain' | 'unavailable';

interface EnrollmentPage {
  label: string;
  requirements: OpEnvironmentRequirements;
  canImport: boolean;
}

const retry = 'Run Install again for a fresh link.';
const results = {
  connected: {
    icon: 'check',
    title: '1Password connected',
    description: 'Access was verified using the credential in this device’s credential store.',
    next: 'You can close this tab. Install continues automatically, then runs Doctor.',
  },
  cancelled: {
    icon: 'minus',
    title: 'Connection cancelled',
    description: 'Your completed setup steps are saved.',
    next: 'You can close this tab. Run Install again when you’re ready to connect.',
  },
  rejected: {
    icon: 'alert',
    title: 'Token rejected',
    description:
      '1Password rejected this service account token. The submitted token was not saved.',
    next: 'Check the token, then run Install again for a fresh link.',
  },
  access: {
    icon: 'alert',
    title: 'More access needed',
    description:
      'The token could not access all the requested resources. The submitted token was not saved.',
    next: 'Check the service account’s grants and the requested resources, then run Install again.',
  },
  store: {
    icon: 'alert',
    title: 'Token could not be saved',
    description: 'The device’s credential store could not save the token.',
    next: 'Check that macOS Keychain or Linux Secret Service is available, then run Install again.',
  },
  uncertain: {
    icon: 'alert',
    title: 'Save could not be confirmed',
    description: 'Agent System could not confirm whether the stored credential works.',
    next: 'Run Doctor to check the stored credential before trying again.',
  },
  unavailable: {
    icon: 'alert',
    title: 'Access could not be verified',
    description:
      'Agent System could not complete the access check. The submitted token was not saved.',
    next: 'Check connectivity and the workspace setup. ' + retry,
  },
} as const;

// bundled line icons keep the page independent of fonts, image requests, and the network.
const iconPaths = {
  layers: '<path d="m12 3 9 4.5L12 12 3 7.5 12 3ZM3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  minus: '<path d="M5 12h14"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>',
  messages:
    '<path d="M14 9a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9l3-3h7a2 2 0 0 0 2-2z"/><path d="M6 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11l-3-3h-5"/>',
};

function icon(name: keyof typeof iconPaths) {
  return `<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name]}</svg>`;
}

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const style = `
  :root {
    color-scheme: light dark;
    --canvas: light-dark(#f0f3f1, #101513);
    --surface: light-dark(#fff, #19201d);
    --ink: light-dark(#17211c, #edf3ef);
    --muted: light-dark(#526058, #b1bfb7);
    --line: light-dark(#dfe5e1, #35423b);
    --tint: light-dark(#f5f8f6, #212c26);
    --accent: light-dark(#9c1c55, #33d3a1);
    --on-accent: light-dark(#fff, #07271b);
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 28px 16px;
    background: var(--canvas);
    color: var(--ink);
  }
  .card {
    width: min(100%, 410px);
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 18px;
    box-shadow: 0 8px 26px -14px #08190c40;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px 25px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    letter-spacing: .01em;
  }
  .mark, .symbol {
    display: inline-grid;
    place-items: center;
    width: 27px;
    height: 27px;
    border-radius: 8px;
    background: var(--tint);
    color: var(--accent);
  }
  .content { padding: 23px 25px 25px; overflow-wrap: anywhere; }
  h1 { margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -.045em; line-height: 1.18; }
  p { margin: 9px 0 0; color: var(--muted); font-size: 14px; line-height: 1.48; }
  a { color: var(--accent); }
  details { margin: 17px 0; background: var(--tint); border-radius: 9px; font-size: 13px; }
  summary { padding: 10px 13px; cursor: pointer; }
  .workspace { display: block; margin-top: 4px; color: var(--muted); }
  dl { margin: 0; padding: 0 13px 12px; }
  dt { font-weight: 600; margin-top: 6px; }
  dd { margin: 2px 0; font-family: ui-monospace, monospace; }
  label { display: block; margin-top: 14px; font-size: 13px; font-weight: 600; }
  input {
    display: block;
    width: 100%;
    margin-top: 6px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 10px 12px;
    font: inherit;
    font-size: 15px;
  }
  .actions { display: flex; flex-wrap: wrap; align-items: center; margin-top: 19px; gap: 8px; }
  button {
    padding: 8px 15px;
    min-height: 38px;
    border: 1px solid transparent;
    border-radius: 9px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.25;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .primary { background: var(--accent); color: var(--on-accent); }
  .primary:disabled { background: var(--tint); color: var(--muted); border-color: var(--line); }
  button:disabled { cursor: default; }
  button:not(.primary):disabled { opacity: .55; }
  .import { padding-inline: 0; text-align: left; color: var(--accent); }
  .symbol { width: 34px; height: 34px; margin-bottom: 12px; }
  .check { color: light-dark(#08754e, #33d3a1); }
  .minus { color: var(--muted); }
  .alert { color: light-dark(#98591d, #ffc678); }
  .return {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    border-top: 1px solid var(--line);
    margin-top: 22px;
    padding-top: 18px;
    font-size: 14px;
  }
  .return svg { flex-shrink: 0; }
  .return p { margin-top: 4px; }
  .status { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
  @media (max-width: 430px) {
    body { padding: 18px 10px; }
    .content { padding: 19px; }
    .brand { padding: 12px 19px; }
  }
`;

const pendingScript = `
  (() => {
    const primary = document.querySelector('.primary');
    const buttons = document.querySelectorAll('button[name="action"]');
    const status = document.querySelector('[role="status"]');
    let pending = false;
    for (const form of document.forms) {
      form.addEventListener('submit', (event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        const action = event.submitter?.value;
        if (action !== 'save' && action !== 'import') return;
        pending = true;

        // disabled buttons do not contribute to a native POST; keep the selected intent.
        const intent = document.createElement('input');
        intent.type = 'hidden';
        intent.name = 'action';
        intent.value = action;
        form.append(intent);
        for (const button of buttons) button.disabled = true;
        primary.textContent = 'Verifying and saving…';
        status.textContent = primary.textContent;
      });
    }
  })();
`;

export function enrollmentPage(
  options: EnrollmentPage,
  view: EnrollmentScreen | 'entry' | 'invalid' | 'used',
  nonce?: string,
) {
  const label = escapeHtml(options.label);
  let title: string;
  let content: string;
  if (view === 'entry' || view === 'invalid') {
    title = 'Connect 1Password';
    const { environmentIds, secrets } = options.requirements;
    const disclosure = [
      ...environmentIds.map((id) => `<dt>Environment</dt><dd>${escapeHtml(id)}</dd>`),
      ...secrets.map(
        ({ reference }) => `<dt>Vault reference</dt><dd>${escapeHtml(reference)}</dd>`,
      ),
    ].join('');
    content = `<h1>${title}</h1>
<p>Give Agent System unattended access to the resources declared by your workspace.</p>
<details><summary>Requested access <span class="workspace">${label}</span></summary><dl>${disclosure}</dl></details>
<p>Agent System checks access before saving the token in this device’s credential store.
<a href="https://developer.1password.com/docs/service-accounts/get-started/" target="_blank" rel="noreferrer">Create a service account</a></p>
${view === 'invalid' ? '<p role="alert">Enter a valid service account token to try again.</p>' : ''}
<form id="save-token" method="post" autocomplete="off">
<label>Service account token<input name="token" type="password" autocomplete="off" required></label>
</form>
<form id="other-action" method="post"></form>
<div class="actions">
<button class="primary" form="save-token" name="action" value="save">Verify and save</button>
<button form="other-action" name="action" value="cancel">Cancel</button>
${options.canImport ? '<button class="import" form="other-action" name="action" value="import">Use OP_SERVICE_ACCOUNT_TOKEN from the Install environment</button>' : ''}
</div>
<div class="status" role="status"></div>
<script nonce="${nonce}">${pendingScript}</script>`;
  } else {
    const result =
      view === 'used'
        ? {
            icon: 'alert' as const,
            title: 'Link unavailable',
            description: 'This enrollment link is already in use or has expired.',
            next: 'Check your Install chat before starting another attempt.',
          }
        : results[view];
    title = result.title;
    content = `<div class="symbol ${result.icon}">${icon(result.icon)}</div>
<h1>${title}</h1>
<p><strong>${label}</strong></p>
<p>${result.description}</p>
<div class="return">${icon('messages')}<div><strong>Return to your Install chat</strong><p>${result.next}</p></div></div>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Agent System</title>
<style>${style}</style>
</head>
<body>
<main class="card">
<header class="brand"><span class="mark">${icon('layers')}</span><strong>Agent System</strong></header>
<div class="content">${content}</div>
</main>
</body>
</html>`;
}
