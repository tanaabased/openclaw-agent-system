/** Hidden response instructions contributed by a delivery pull request opened event. */
const githubNotificationPullRequestOpenedResponseInstructions = [
  'Respond privately with one brief acknowledgment that the delivery pull request is linked and that later issue or pull request comments will continue in this session.',
  'Do not call `agent_system_github_reply`, repeat raw metadata, claim another lifecycle transition, or describe additional work as completed.',
].join(' ');

export default githubNotificationPullRequestOpenedResponseInstructions;
