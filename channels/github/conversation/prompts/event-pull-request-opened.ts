/** Hidden instructions contributed by a delivery pull request opened event. */
const githubNotificationPullRequestOpenedEventInstructions = [
  'A delivery pull request has been linked to the current issue-owned work session. Treat the trusted private card as lifecycle state, not as a request to perform more repository work.',
  'The issue and pull request may both supply later approved comments. Each response will return to the item where its admitted comment originated.',
  'Do not inspect files, call tools, alter the pull request, claim review or merge status, or start another implementation during this event turn.',
].join(' ');

export default githubNotificationPullRequestOpenedEventInstructions;
