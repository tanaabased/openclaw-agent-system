export const defaultMaximumCommentCharacters = 8_000;
export const maximumMaximumCommentCharacters = 64_000;

export function validateMaximumCommentCharacters(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > maximumMaximumCommentCharacters
  ) {
    throw new Error(
      `GitHub notification maxCommentCharacters must be an integer from 1 to ${maximumMaximumCommentCharacters}.`,
    );
  }
  return Number(value);
}
