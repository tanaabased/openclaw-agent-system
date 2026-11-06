import {
  nativeRoutingMetadata,
  routingMetadata,
} from '../channels/github/provider/routing-metadata.ts';
import type { GitHubNotificationItemContext } from '../channels/github/provider/work-event-types.ts';

/** Both runtimes classify the same bounded, provenance-labelled provider evidence. */
export default function dispatchContext(
  context: GitHubNotificationItemContext,
  source: string,
  observedAt: number,
  complete = false,
) {
  const fallbackMetadata = routingMetadata(nativeRoutingMetadata([]), context.body);
  const conflicts = (['complexity', 'workSize'] as const).filter(
    (field) =>
      context.nativeRoutingMetadata?.[field].status === 'verified' &&
      fallbackMetadata[field].status === 'verified' &&
      context.nativeRoutingMetadata[field].value !== fallbackMetadata[field].value,
  );
  return {
    source,
    observedAt,
    title: complete ? context.title : context.title.slice(0, 512),
    body: complete ? context.body : context.body.slice(0, 18000),
    comments: complete
      ? context.comments
      : context.comments
          .slice(-10)
          .map((comment) => ({ ...comment, body: comment.body.slice(0, 1200) })),
    ...(complete && context.files ? { files: context.files } : {}),
    metadata: context.routingMetadata ?? null,
    nativeMetadata: context.nativeRoutingMetadata ?? null,
    fallbackMetadata,
    conflicts,
    labels: context.labels,
    truncated:
      context.truncated ||
      (!complete &&
        (context.body.length > 18000 ||
          context.comments.length > 10 ||
          context.comments.some((comment) => comment.body.length > 1200))),
  };
}
