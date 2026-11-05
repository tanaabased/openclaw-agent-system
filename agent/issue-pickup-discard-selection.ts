import type { PickupOperation } from './issue-pickup-state.ts';

export default function discardPickupSelection(op: PickupOperation) {
  op.candidates = [];
  if (op.selected) op.selected = { nodeId: op.selected.nodeId, number: op.selected.number };
  delete op.discovery;
  delete op.scan;
  delete op.guidance;
  delete op.guidanceSource;
  delete op.guidancePath;
  delete op.selectionDigest;
  delete op.rationale;
  delete op.shortlist;
  delete op.deferred;
}
