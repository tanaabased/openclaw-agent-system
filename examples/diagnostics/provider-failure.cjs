// CI-only provider seam: no credential or live provider request is permitted.
const { registerHooks } = require('node:module');
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('/@1password/sdk/dist/sdk.js')) return nextLoad(url, context);
    return {
      format: 'commonjs',
      shortCircuit: true,
      source: `
        const errors = require('./errors.js');
        exports.AuthExpiredError = errors.AuthExpiredError;
        exports.DesktopSessionExpiredError = errors.DesktopSessionExpiredError;
        exports.RateLimitExceededError = errors.RateLimitExceededError;
        exports.createClient = async (config) => {
          if (config.auth !== 'agent-system-synthetic-quota') throw new Error('Unexpected credential in synthetic fixture.');
          throw new errors.RateLimitExceededError('SYNTHETIC_PRIVATE_TOKEN op://synthetic/item/credential Authorization: SYNTHETIC_PRIVATE_RESPONSE');
        };
      `,
    };
  },
});
