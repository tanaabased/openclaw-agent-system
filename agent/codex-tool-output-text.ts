import { nativeObject } from './automations/automation-gateway.ts';

/** preserve native text exactly; mixed media is not a workflow envelope. */
export default function codexToolOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(
      (part) => nativeObject(part) && part.type === 'input_text' && typeof part.text === 'string',
    )
  )
    return undefined;
  return value.map((part) => part.text).join('');
}
