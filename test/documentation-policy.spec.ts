import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const documentationPaths = globSync('**/*.md', {
  cwd: projectDir,
  exclude: ['CHANGELOG.md', 'dist/**', 'node_modules/**'],
}).sort();

describe('documentation/policy-vocabulary', () => {
  it('should keep lifecycle approval separate from git and github policy', () => {
    for (const path of ['tools/git/README.md', 'tools/github/README.md']) {
      assert.doesNotMatch(
        readFileSync(join(projectDir, path), 'utf8'),
        /\bapprovals?\b/iu,
        `${path} must describe authorization through allow and deny`,
      );
    }
  });

  it('should keep ask out of documented policy decisions', () => {
    for (const path of documentationPaths) {
      assert.doesNotMatch(
        readFileSync(join(projectDir, path), 'utf8'),
        /`ask`|\bpolicy\b[^\n]{0,80}\basks?\b|\basks?\b[^\n]{0,80}\bpolicy\b/iu,
        `${path} must document only allow and deny policy decisions`,
      );
    }
  });
});
