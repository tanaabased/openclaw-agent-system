import { providerDiagnostic } from '../../utils/provider-diagnostic.ts';

/** classify recognizable git failures; preserve only bounded and redacted upstream evidence. */
export default function gitDiagnostic(stderr: string, timedOut = false) {
  const classification =
    /authentication failed|could not read (?:Username|Password)|terminal prompts disabled|permission denied \(publickey\)/iu.test(
      stderr,
    )
      ? 'authentication'
      : /protected branch|repository rule violations|permission to .* denied|write access .* not granted|not allowed to push/iu.test(
            stderr,
          )
        ? 'permission'
        : timedOut ||
            /could not resolve host|could not resolve hostname|connection (?:timed out|refused|reset)|network is unreachable/iu.test(
              stderr,
            )
          ? 'transport'
          : 'unknown';
  return providerDiagnostic('git', 'git-command', classification, { providerMessage: stderr });
}
