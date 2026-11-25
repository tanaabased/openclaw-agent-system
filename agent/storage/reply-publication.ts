import type { DatabaseSync } from 'node:sqlite';
import { commentPublicationTarget } from '../../channels/github/publication/comment-publisher.ts';

export function replyPublicationKey(publisher: string, publication: string | undefined) {
  if (!publication || !publisher) throw new Error('reply-publication-invalid');
  return { publisher, target: commentPublicationTarget(JSON.parse(publication)) };
}

export const replyPublicationReserved = 'reply-publication-reserved';

/** Stage pre-upgrade attempts, including uncertain comments transferred during retirement. */
export function stageReplyPublications(shared: DatabaseSync, agent: DatabaseSync) {
  const add = shared.prepare('INSERT OR IGNORE INTO temp.prior_reply_publications VALUES (?, ?)');
  const table = agent.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
  function collect(query: string) {
    for (const row of agent.prepare(query).iterate()) {
      if (typeof row.publisher !== 'string' || typeof row.publication !== 'string')
        throw new Error('reply-publication-invalid');
      const key = replyPublicationKey(row.publisher, row.publication);
      add.run(key.publisher, key.target);
    }
  }
  if (table.get('reply_drafts'))
    collect(`SELECT value ->> '$.authorNodeId' AS publisher, value ->> '$.publication' AS publication
      FROM reply_drafts WHERE value ->> '$.attempted' = 1 OR value ->> '$.receipt' IS NOT NULL`);
  if (table.get('dispatch_state'))
    collect(`SELECT effect.value ->> '$.accountId' AS publisher, effect.value ->> '$.publication' AS publication
      FROM dispatch_state, json_each(dispatch_state.value, '$.retirementEffects') effect
      WHERE effect.value ->> '$.kind' = 'comment'`);
}
