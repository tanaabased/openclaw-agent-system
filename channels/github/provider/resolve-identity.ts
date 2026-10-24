import type GitHubWorkEventApiClient from './work-event-api-client.ts';
import { githubResponseIdentity, githubResponseRecord } from './work-event-normalization.ts';

/** Refresh a bounded group of immutable identities in one provider observation. */
export async function resolveGitHubIdentities(
  api: GitHubWorkEventApiClient,
  ids: readonly string[],
) {
  if (
    !ids.length ||
    ids.length > 100 ||
    ids.some((id) => !id || id.length > 255 || /\s|\0/u.test(id) || id.startsWith('@'))
  )
    throw new Error('github-identity-reference-invalid');
  const response = await api.request(
    ['graphql', '--input', '-'],
    'configured identity',
    JSON.stringify({
      query:
        'query($ids:[ID!]!){nodes(ids:$ids){__typename ... on User{id login} ... on Organization{id login}}}',
      variables: { ids },
    }),
  );
  const body = githubResponseRecord(response.value, 'configured identities');
  if (body.errors) throw new Error('github-identity-unresolved');
  const nodes = githubResponseRecord(body.data, 'identity data').nodes;
  if (!Array.isArray(nodes) || nodes.length !== ids.length)
    throw new Error('github-identity-unresolved');
  return nodes.map((value) => {
    if (!value) throw new Error('github-identity-unresolved');
    const node = githubResponseRecord(value, 'identity node');
    return githubResponseIdentity(
      { login: node.login, nodeId: node.id, type: node.__typename },
      'configured identity',
    );
  });
}

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
