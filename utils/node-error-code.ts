/** Read the optional Node.js error code from an unknown failure value. */
export default function nodeErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
