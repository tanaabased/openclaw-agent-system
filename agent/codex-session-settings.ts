import type { DispatchRecord } from './codex-dispatch-state.ts';
import sessionSettings, { type SessionSettings } from './session-settings.ts';

/** codex may omit settings readback; absence is not proof of the requested configuration. */
export default function codexSessionSettings(record: DispatchRecord, observed: SessionSettings) {
  if (!record.request) throw new Error('dispatch-creation-not-prepared');
  const settings = sessionSettings({
    requested: { model: record.request.model, effort: record.request.thinking },
    observed,
    creationVerified: Boolean(record.effective),
  });
  if (settings.mismatch) throw new Error('dispatch-native-model-diverged');
  return settings.effective;
}
