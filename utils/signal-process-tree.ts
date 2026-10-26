/** Signal a detached child process group, falling back when the group is unavailable. */
export default function signalProcessTree(
  child: { kill(signal?: NodeJS.Signals): boolean; pid?: number },
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Fall back to the direct child if process-group signaling is unavailable.
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited between the lifecycle event and the signal.
  }
}
