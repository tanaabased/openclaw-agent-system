import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('automation catalog fixtures', () => {
  for (const [scenario, model] of [
    ['openclaw-automation-command-chat', 'gpt-5.5'],
    ['openclaw-lifecycle-approvals', 'gpt-5.4-nano'],
  ]) {
    it(`should mock only authenticated catalog reads and reject live inference for ${scenario}`, async () => {
      await execFileAsync(process.execPath, [
        '--import',
        `./examples/${scenario}/catalog-fixture.mjs`,
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        const url = 'https://api.openai.com/v1/models';
        const headers = {authorization: 'Bearer agent-system-aimock-test'};
        for (const request of [url, new URL(url), new Request(url, {headers})]) {
          const response = await fetch(request, {headers});
          assert.equal(response.status, 200);
          assert.deepEqual((await response.json()).data.map(model => model.id), [${JSON.stringify(model)}]);
        }
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, {headers: {authorization: 'Bearer unexpected'}})).status, 401);
        await assert.rejects(fetch(url, {method: 'POST', headers}), /Unexpected OpenAI request/);
        await assert.rejects(fetch('https://api.openai.com/v1/responses', {method: 'POST', headers}), /Unexpected OpenAI request/);
        assert.equal(await (await fetch(new Request('data:text/plain,passthrough'))).text(), 'passthrough');
      `,
      ]);
    });
  }
});
