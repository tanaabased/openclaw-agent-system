import { createClackPrompter } from 'openclaw/plugin-sdk/setup-runtime';

import { sessionDispatchDisclosure } from '../agent/session-dispatch-requirements.ts';
import type { SetupConsentOptions } from './setup-consent.ts';

/** unattended execution is not consent; only an explicit yes accepts enrollment. */
export default async function confirmSessionDispatch(
  options: SetupConsentOptions,
  consumers: readonly { name: string }[],
): Promise<boolean> {
  options.output.writeStderr(`${sessionDispatchDisclosure(consumers)}\n`);
  if (options.yes) return true;
  const environment = options.environment ?? process.env;
  const enabled = (value: string | undefined) =>
    ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
  if (
    options.nonInteractive ||
    enabled(environment.CI) ||
    enabled(environment.NONINTERACTIVE) ||
    ((options.input ?? process.stdin) as { isTTY?: boolean }).isTTY !== true
  )
    return false;
  try {
    const prompt = options.prompt ?? createClackPrompter(process.stderr).confirm;
    return (await prompt({ message: 'enable session dispatch?', initialValue: false })) === true;
  } catch {
    return false;
  }
}
