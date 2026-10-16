export const githubChannelSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    accounts: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          managedWorkspace: { type: 'string', minLength: 1 },
        },
        required: ['enabled'],
      },
    },
  },
  required: ['accounts'],
};

export const githubChannelMetadata = {
  id: 'agent-system-github',
  label: 'Agent System GitHub Notifications',
  selectionLabel: 'Agent System GitHub Notifications',
  detailLabel: 'GitHub Notifications',
  docsPath:
    'https://github.com/tanaabased/openclaw-agent-system/blob/main/channels/github/README.md',
  docsLabel: 'GitHub notifications',
  blurb: 'Shows readiness and health of Agent System native notification automations.',
  systemImage: 'bell.badge',
  markdownCapable: true,
  exposure: { configured: true, docs: true, setup: false },
};
