import { realpath } from 'node:fs/promises';

import { githubOrigin, type DispatchGit } from './codex-dispatch-project.ts';

/** inspect an existing checkout only; setup and fetch belong to the full workflow. */
export default async function assessmentCheckout(
  path: string,
  repository: string,
  git: DispatchGit,
) {
  const selected = await realpath(path);
  const root = await realpath((await git(selected, ['rev-parse', '--show-toplevel'])).trim());
  if (root !== selected) throw new Error('assessment-checkout-root-required');
  const origin = githubOrigin((await git(root, ['remote', 'get-url', 'origin'])).trim());
  if (origin !== repository.toLowerCase())
    throw new Error('assessment-checkout-repository-mismatch');
  const revision = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(revision)) throw new Error('assessment-checkout-revision-invalid');
  const dirty = Boolean((await git(root, ['status', '--porcelain'])).trim());
  return { path: root, revision, dirty };
}
