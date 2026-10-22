import type GitHubWorkEventApiClient from './work-event-api-client.ts';
import { githubResponseIdentity, githubResponseRecord } from './work-event-normalization.ts';

/** Resolve a literal name or opaque node id using fixed provider endpoints. */
export default async function resolveGitHubIdentity(
  api: GitHubWorkEventApiClient,
  reference: string,
) {
  if (reference.startsWith('@')) {
    const name = reference.slice(1);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name))
      throw new Error('github-identity-reference-invalid');
    const response = await api.request(
      ['--method', 'GET', `/users/${name}`, '--jq', '{login,nodeId:.node_id,type}'],
      'configured identity',
    );
    return githubResponseIdentity(response.value, 'configured identity');
  }
  if (
    !reference ||
    reference.length > 255 ||
    /\s/u.test(reference) ||
    reference.includes(String.fromCharCode(0))
  )
    throw new Error('github-identity-reference-invalid');
  const response = await api.request(
    ['graphql', '--input', '-'],
    'configured identity',
    JSON.stringify({
      query:
        'query($id:ID!){node(id:$id){__typename ... on User{id login} ... on Organization{id login}}}',
      variables: { id: reference },
    }),
  );
  const body = githubResponseRecord(response.value, 'configured identity');
  if (body.errors) throw new Error('github-identity-unresolved');
  const value = githubResponseRecord(body.data, 'identity data').node;
  if (!value) throw new Error('github-identity-unresolved');
  const node = githubResponseRecord(value, 'identity node');
  return githubResponseIdentity(
    { login: node.login, nodeId: node.id, type: node.__typename },
    'configured identity',
  );
}
