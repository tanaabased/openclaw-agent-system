import assert from 'node:assert/strict';

import { legacyGitHubNotifications } from '../channels/github/config-schema.ts';

import parseAgentManifest from '../manifest/parse.ts';

function diagnosticCodes(source: string): Set<string> {
  const result = parseAgentManifest(source);
  return new Set(result.diagnostics.map(({ code }) => code));
}

describe('manifest/parse', () => {
  it('should accept operator opt-in only on approved actor records', () => {
    const source = (flag: string, field = 'approved-actors') => `
schema-version: 1
agent:
  id: data
  email: data@example.com
git:
  worktrees: {}
github:
  username: data
  token: GH_TOKEN_DATA
  notifications:
    approved-actors:
      - login: actor
        node-id: U_actor
${field === 'approved-actors' ? `        operator-owner: ${flag}` : `    allowed-repository-owners:\n      - login: owner\n        node-id: O_owner\n        operator-owner: ${flag}`}
`;
    for (const flag of ['true', 'false']) {
      const result = parseAgentManifest(source(flag));
      assert.equal(result.status, 'valid');
      if (result.status === 'valid')
        assert.equal(
          legacyGitHubNotifications(result.manifest.github?.notifications)?.approvedActors?.[0]
            ?.operatorOwner,
          flag === 'true',
        );
    }
    for (const flag of ['"true"', '1', 'null', '[]'])
      assert.equal(parseAgentManifest(source(flag)).status, 'invalid');
    assert.equal(parseAgentManifest(source('true', 'allowed-repository-owners')).status, 'invalid');
  });

  it('should parse github identity and an environment-only credential binding', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  host: github.com
  username:
    from-environment: GITHUB_USERNAME
  token: GITHUB_TOKEN
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github, {
      host: 'github.com',
      username: { fromEnvironment: 'GITHUB_USERNAME' },
      token: 'GITHUB_TOKEN',
    });
  });

  it('should parse optional github credentials and all supported cli config settings', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  config:
    git-protocol: ssh
    color-labels: disabled
    accessible-colors: enabled
    spinner: disabled
    telemetry: enabled
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github, {
      config: {
        gitProtocol: 'ssh',
        colorLabels: 'disabled',
        accessibleColors: 'enabled',
        spinner: 'disabled',
        telemetry: 'enabled',
      },
    });
  });

  it('should parse the github releases policy decision', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  policy:
    releases: allow
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github?.policy, {
      releases: 'allow',
    });
  });

  it('should parse github notification trust pins and defaults', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  notifications:
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
    allowed-repository-owners:
      - login: tanaabased
        node-id: O_kgDOB7x6Qw
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github?.notifications, {
      assignmentTypes: ['issue', 'pull-request'],
      approvedActors: [{ login: 'pirog', nodeId: 'U_kgDOB9x7Qw' }],
      allowedRepositoryOwners: [{ login: 'tanaabased', nodeId: 'O_kgDOB7x6Qw' }],
      initialMode: 'work',
      intervalMinutes: 5,
      maxConcurrentIssues: 2,
      pullRequest: { assignees: 'assignment-actor', reviewers: [] },
    });
  });

  it('should preserve independent explicit lists, omission, and empty denial through decoding', () => {
    const prefix = 'schema-version: 1\nagent:\n  id: data\ngithub:\n  notifications:';
    const cases = [
      { source: ' {}', expected: {} },
      {
        source: '\n    approved-issue-assigners: []\n    approved-feedback-authors: []',
        expected: { approvedIssueAssigners: [], approvedFeedbackAuthors: [] },
      },
      {
        source:
          '\n    approved-issue-assigners:\n      - login: assigner\n        node-id: U_assigner',
        expected: { approvedIssueAssigners: [{ login: 'assigner', nodeId: 'U_assigner' }] },
      },
      {
        source:
          '\n    approved-feedback-authors:\n      - login: reviewer\n        node-id: U_reviewer',
        expected: { approvedFeedbackAuthors: [{ login: 'reviewer', nodeId: 'U_reviewer' }] },
      },
      {
        source:
          '\n    approved-actors:\n      - login: operator\n        node-id: U_operator\n        operator-owner: true\n    approved-issue-assigners: []\n    approved-feedback-authors:\n      - login: reviewer\n        node-id: U_reviewer',
        expected: {
          approvedActors: [{ login: 'operator', nodeId: 'U_operator', operatorOwner: true }],
          approvedIssueAssigners: [],
          approvedFeedbackAuthors: [{ login: 'reviewer', nodeId: 'U_reviewer' }],
        },
      },
    ];
    for (const entry of cases) {
      const result = parseAgentManifest(prefix + entry.source);
      assert.equal(result.status, 'valid');
      if (result.status !== 'valid') continue;
      assert.deepEqual(result.manifest.github?.notifications, {
        assignmentTypes: ['issue', 'pull-request'],
        initialMode: 'work',
        intervalMinutes: 5,
        maxConcurrentIssues: 2,
        pullRequest: { assignees: 'assignment-actor', reviewers: [] },
        ...entry.expected,
      });
    }
  });

  it('should require safe immutable pins and reject operator flags on either new grant', () => {
    for (const field of ['approved-issue-assigners', 'approved-feedback-authors']) {
      for (const pin of [
        'login: actor',
        'node-id: U_actor',
        'login: actor\n        node-id: ""',
        'login: actor\n        node-id: "U actor"',
        'login: "@actor"\n        node-id: U_actor',
        'login: actor\n        node-id: U_actor\n        operator-owner: true',
      ]) {
        assert.equal(
          parseAgentManifest(
            `schema-version: 1\nagent:\n  id: data\ngithub:\n  notifications:\n    ${field}:\n      - ${pin}`,
          ).status,
          'invalid',
        );
      }
    }
    assert.equal(
      parseAgentManifest(
        'schema-version: 1\nagent:\n  id: data\ngithub:\n  notifications:\n    approved-review-requesters: []',
      ).status,
      'invalid',
    );
  });

  it('should parse pull request recipient overrides and reject more than ten assignees', () => {
    const prefix = `\nschema-version: 1\nagent:\n  id: data\ngithub:\n  notifications:\n    approved-actors:\n      - login: pirog\n        node-id: U_actor\n    pull-request:\n`;
    const result = parseAgentManifest(
      `${prefix}      assignees: []\n      reviewers:\n        - login: reviewer\n          node-id: U_reviewer\n`,
    );
    assert.equal(result.status, 'valid');
    if (result.status === 'valid')
      assert.deepEqual(
        legacyGitHubNotifications(result.manifest.github?.notifications)?.pullRequest,
        {
          assignees: [],
          reviewers: [{ login: 'reviewer', nodeId: 'U_reviewer' }],
        },
      );
    const assignees = Array.from(
      { length: 11 },
      (_, index) => `        - login: user${index}\n          node-id: U_${index}`,
    ).join('\n');
    assert.equal(parseAgentManifest(`${prefix}      assignees:\n${assignees}\n`).status, 'invalid');
  });

  it('should parse a guided github notification initial mode', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  notifications:
    initial-mode: guided
    approved-actors:
      - login: pirog
        node-id: U_1
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.equal(
      legacyGitHubNotifications(result.manifest.github?.notifications)?.initialMode,
      'guided',
    );
  });

  it('should parse and validate github notification issue concurrency', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  notifications:
    max-concurrent-issues: 4
    approved-actors:
      - login: pirog
        node-id: U_1
`);

    assert.equal(result.status, 'valid');
    if (result.status === 'valid') {
      assert.equal(
        legacyGitHubNotifications(result.manifest.github?.notifications)?.maxConcurrentIssues,
        4,
      );
    }
    for (const value of ['0', '-1', '1.5', 'many']) {
      assert.equal(
        parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  notifications:
    max-concurrent-issues: ${value}
    approved-actors:
      - login: pirog
        node-id: U_1
`).status,
        'invalid',
      );
    }
  });

  it('should reject unsafe github notification configuration', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  notifications:
    approved-actors: []
`).has('manifest-schema'),
      true,
    );
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  notifications:
    interval-minutes: 1
    approved-actors:
      - login: pirog
        node-id: U_1
    repository-policy:
      minimum-permission: write
`).has('manifest-unknown-key'),
      true,
    );
  });

  it('should parse an explicit github notification assignment-type filter', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  notifications:
    assignment-types:
      - issue
    approved-actors:
      - login: pirog
        node-id: U_1
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(
      legacyGitHubNotifications(result.manifest.github?.notifications)?.assignmentTypes,
      ['issue'],
    );
  });

  it('should reject legacy github ask decisions with exact migration guidance', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  policy:
    releases: ask
`);

    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.diagnostics, [
      {
        code: 'manifest-policy-ask-unsupported',
        fieldPath: '/github/policy/releases',
        message:
          'Policy decision ask at /github/policy/releases is no longer supported. An operator must choose deny or allow.',
        severity: 'error',
      },
    ]);
  });

  it('should reject unsupported github policy decisions and policy keys', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  policy:
    releases: prompt
`).has('manifest-schema'),
      true,
    );
    for (const field of ['admin', 'destructive', 'unknown']) {
      assert.equal(
        diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  policy:
    ${field}: deny
`).has('manifest-unknown-key'),
        true,
      );
    }
  });

  it('should normalize github ssh authentication and signing key short and object forms', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  ssh-keys:
    - ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev
    - path: keys/generated-auth.pub
      title: Generated authentication key
  ssh-signing-keys:
    key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev
    title: Tanaabot signing key
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.github, {
      username: 'tanaabot',
      token: 'GH_TOKEN_TANAABOT',
      sshKeys: [
        {
          source:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev',
          type: 'auto',
        },
        {
          source: 'keys/generated-auth.pub',
          title: 'Generated authentication key',
          type: 'path',
        },
      ],
      sshSigningKeys: [
        {
          source:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev',
          title: 'Tanaabot signing key',
          type: 'key',
        },
      ],
    });
  });

  it('should reject empty key arrays and ambiguous github key objects', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  ssh-keys: []
`).has('manifest-schema'),
      true,
    );
    const ambiguous = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
github:
  ssh-signing-keys:
    key: ssh-ed25519 invalid
    path: keys/signing.pub
`);
    assert.equal(ambiguous.status, 'invalid');
  });

  it('should reject literal-like github tokens and unknown github keys', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  token: github_pat_private
`).has('manifest-schema'),
      true,
    );
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
github:
  token: GITHUB_TOKEN
  api-url: https://api.github.com
`).has('manifest-unknown-key'),
      true,
    );
  });
});
