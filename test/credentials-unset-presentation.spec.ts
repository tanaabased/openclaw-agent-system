import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

import stringWidth from 'fast-string-width';

import { createCliStyles } from '../cli/output.ts';
import {
  captureUnsetPreview,
  unsetAgentId,
  unsetFixtures,
  type UnsetPreview,
} from './credentials-unset-presentation-fixtures.ts';

const diagnostics = [
  { severity: 'warning' as const, code: 'fixture-warning', message: 'External MixedCaseWarning' },
  { severity: 'error' as const, code: 'fixture-error', message: 'External MixedCaseError' },
];

describe('cli/credentials-unset presentation', () => {
  it('should show selected agent and requested scope with separate evidenced store outcomes', async () => {
    for (const name of Object.keys(unsetFixtures) as UnsetPreview[]) {
      const fixture = unsetFixtures[name];
      const preview = await captureUnsetPreview(name);
      const oneStore = [
        'one-store',
        'one-missing',
        'unavailable-store',
        'uncertain-mutation',
      ].includes(name);
      assert.deepEqual(preview.selections, [unsetAgentId]);
      assert.deepEqual(preview.mutations, [
        { agentId: unsetAgentId, storeId: oneStore ? 'FileStore' : undefined },
      ]);
      assert.equal(preview.exitCode, fixture.status === 'invalid' ? 1 : 0);
      if (fixture.status === 'invalid') {
        assert.equal(preview.stdout, '');
        assert.ok(preview.stderr.includes(fixture.code));
        assert.ok(preview.stderr.includes(fixture.message));
        continue;
      }
      assert.match(preview.stdout, /agent +MixedCaseAgent/u);
      assert.match(
        preview.stdout,
        oneStore ? /scope +one store \(FileStore\)/u : /scope +all stores/u,
      );
      for (const store of fixture.storeIds) {
        assert.match(
          preview.stdout,
          new RegExp(
            `${fixture.status === 'removed' ? 'removed' : 'unchanged'} +${store} +op credential`,
            'u',
          ),
        );
      }
      if ('unavailableStoreIds' in fixture) {
        for (const store of fixture.unavailableStoreIds) {
          assert.match(preview.stdout, new RegExp(`unavailable +${store} +removal skipped`, 'u'));
          assert.ok(preview.stderr.includes(store));
        }
      }
      if ('gatewayInvalidation' in fixture) {
        assert.match(
          preview.stdout,
          new RegExp(`gateway cache +invalidation ${fixture.gatewayInvalidation}`, 'u'),
        );
      } else assert.doesNotMatch(preview.stdout, /gateway cache/u);
      assert.ok(preview.stdout.startsWith('\n') && preview.stdout.endsWith('\n\n'));
      assert.ok(!preview.stdout.trim().includes('\n\n'));
    }
    const partial = await captureUnsetPreview('partial-removal');
    assert.doesNotMatch(partial.stdout, /unchanged/u);
    assert.doesNotMatch(partial.stdout, /removed +Keychain/u);
  });

  it('should keep missing and confirmed cache states quiet and successful removal distinct from pending invalidation', async () => {
    const environment = { FORCE_COLOR: '3' };
    const styles = createCliStyles(environment);
    const missing = await captureUnsetPreview('one-missing', { environment });
    assert.ok(missing.stdout.includes(styles.field('unchanged')));
    assert.ok(missing.stdout.includes(styles.field('op credential is not stored')));
    assert.equal(missing.stderr, '');
    const confirmed = await captureUnsetPreview('one-store', { environment });
    assert.ok(confirmed.stdout.includes(styles.status('removed')));
    assert.ok(confirmed.stdout.includes(styles.field('invalidation confirmed')));
    const pending = await captureUnsetPreview('pending-invalidation', { environment });
    assert.equal(pending.exitCode, 0);
    assert.equal(pending.mutations.length, 1);
    assert.ok(pending.stdout.includes(styles.status('removed')));
    assert.ok(pending.stdout.includes(styles.warning('unavailable')));
    assert.ok(pending.stdout.includes(styles.warning('gateway cache')));
    assert.match(pending.stderr, /openclaw agent-system credentials cache flush/u);
    assert.match(pending.stderr.replace(/\s+/gu, ' '), /store mutation will not be replayed/u);
  });

  it('should collect manifest and incomplete-work diagnostics after output in one severity-sorted section', async () => {
    for (const name of ['pending-invalidation', 'uncertain-mutation'] as const) {
      const preview = await captureUnsetPreview(name, { diagnostics });
      assert.equal(preview.events.at(-1)?.stream, 'stderr');
      assert.ok(preview.events.slice(0, -1).every(({ stream }) => stream === 'stdout'));
      assert.equal(preview.stderr.match(/^messages$/gmu)?.length, 1);
      assert.match(
        preview.stderr,
        /error[\s\S]*fixture-error[\s\S]*warning[\s\S]*fixture-warning[\s\S]*gateway invalidation is pending/u,
      );
      if (name === 'uncertain-mutation')
        assert.ok(
          preview.stderr.indexOf('op-credential-mutation-uncertain') <
            preview.stderr.indexOf('⚠ warning'),
        );
    }
  });

  it('should preserve exact literal data and content with color and narrow wrapping', async () => {
    for (const terminalColumns of [32, 120]) {
      for (const name of Object.keys(unsetFixtures) as UnsetPreview[]) {
        const plain = await captureUnsetPreview(name, {
          terminalColumns,
          environment: { NO_COLOR: '1', FORCE_COLOR: '3' },
        });
        const colored = await captureUnsetPreview(name, {
          terminalColumns,
          environment: { FORCE_COLOR: '3' },
        });
        assert.equal(stripVTControlCharacters(colored.stdout), plain.stdout);
        assert.equal(stripVTControlCharacters(colored.stderr), plain.stderr);
        for (const text of [plain.stdout, plain.stderr])
          assert.ok(text.split('\n').every((line) => stringWidth(line) <= terminalColumns));
        const fixture = unsetFixtures[name];
        if (fixture.status !== 'invalid') {
          const content = plain.stdout.replace(/\s/gu, '');
          for (const literal of [unsetAgentId, ...fixture.storeIds])
            assert.ok(content.includes(literal), literal);
          if ('unavailableStoreIds' in fixture)
            for (const literal of fixture.unavailableStoreIds)
              assert.ok(content.includes(literal), literal);
        } else
          assert.ok(plain.stderr.replace(/\s/gu, '').includes(fixture.message.replace(/\s/gu, '')));
      }
    }
  });

  it('should fail before mutation for unsupported credentials and invalid manifests', async () => {
    const unsupported = await captureUnsetPreview('one-store', {
      credential: 'MixedCaseCredential',
    });
    assert.equal(unsupported.exitCode, 1);
    assert.deepEqual(unsupported.mutations, []);
    assert.deepEqual(unsupported.selections, []);
    assert.match(unsupported.stderr, /unsupported credential MixedCaseCredential/u);
    const invalid = await captureUnsetPreview('one-store', { manifestFailure: true, diagnostics });
    assert.equal(invalid.exitCode, 1);
    assert.deepEqual(invalid.mutations, []);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /fixture-error/u);
  });
});
