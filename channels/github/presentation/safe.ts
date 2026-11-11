/** formatting is advisory; callers supply verified content and keep effects outside this boundary. */
export default function safePresentation(render: () => string, fallback: () => string): string {
  try {
    return render();
  } catch {
    return fallback();
  }
}
