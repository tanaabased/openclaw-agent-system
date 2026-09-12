import assert from 'node:assert/strict';

import parseModelRuntimeStatus from '../agent/model-runtime-status.ts';

describe('agent/model-runtime-status', () => {
  it('should parse usable and unavailable native runtime routes', () => {
    assert.deepEqual(
      parseModelRuntimeStatus(
        JSON.stringify({
          auth: {
            modelRouteIssues: [
              {
                kind: 'missing-auth',
                provider: 'openai',
                model: 'gpt-5.6-sol',
                authRequirement: 'subscription',
                message: 'No usable subscription authentication is available.',
              },
            ],
            runtimeAuthRoutes: [
              {
                provider: 'openai',
                runtime: 'codex',
                authProvider: 'openai',
                status: 'unavailable',
                authStatus: 'usable',
                runtimeStatus: 'unavailable',
                runtimeDetail: 'Codex plugin payload was not verified.',
                runtimePluginIds: ['codex'],
              },
            ],
          },
        }),
      ),
      {
        issues: [
          {
            authRequirement: 'subscription',
            kind: 'missing-auth',
            message: 'No usable subscription authentication is available.',
            model: 'gpt-5.6-sol',
            provider: 'openai',
          },
        ],
        routes: [
          {
            authStatus: 'usable',
            provider: 'openai',
            runtime: 'codex',
            runtimeDetail: 'Codex plugin payload was not verified.',
            status: 'unavailable',
          },
        ],
      },
    );
  });

  it('should reject missing or unknown readiness evidence', () => {
    assert.throws(
      () => parseModelRuntimeStatus(JSON.stringify({ auth: { runtimeAuthRoutes: [] } })),
      /invalid JSON result/u,
    );
    assert.throws(
      () =>
        parseModelRuntimeStatus(
          JSON.stringify({
            auth: {
              modelRouteIssues: [],
              runtimeAuthRoutes: [{ provider: 'openai', runtime: 'codex', status: 'maybe' }],
            },
          }),
        ),
      /invalid runtime route/u,
    );
  });
});
