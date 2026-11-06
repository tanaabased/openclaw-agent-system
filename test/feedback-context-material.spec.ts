import assert from 'node:assert/strict';

import feedbackContextMaterial from '../agent/feedback-context-material.ts';
import type { ImplementationMaterialRead } from '../agent/implementation-material.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

describe('agent/feedback-context-material', () => {
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should deliver complete quoted feedback and instructions in ${runtime}`, async () => {
      const body = 'Keep the full source, including quotes: " \\ 🧭\n'.repeat(600);
      const source = {
        status: 'verified',
        runtime,
        id: 'a'.repeat(64),
        eventId: 'b'.repeat(64),
        mode: 'work',
        workAuthorized: true,
        source: { author: 'reviewer', body },
        presentation:
          '> reviewer\n' +
          body
            .split('\n')
            .map((line) => '> ' + line)
            .join('\n'),
        instructions: 'Read every finding before replying.\n'.repeat(200),
      };
      const snapshot = JSON.stringify(source);
      const request = { action: 'feedback-context', id: source.id, eventId: source.eventId };
      const response = feedbackContextMaterial(source, request);
      const restored = await hydrateImplementation(response, async (next) =>
        feedbackContextMaterial(source, request, next.material as ImplementationMaterialRead),
      );
      assert.deepEqual(restored, JSON.parse(snapshot));
      assert.equal(JSON.stringify(source), snapshot);
    });
});
