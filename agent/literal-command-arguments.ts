/** recognize literal shell arguments only; unfamiliar syntax stays with native approval. */
export default function literalArguments(command: string): string[] | undefined {
  if (command.includes('\0')) return;
  // a quoted, final heredoc is data for the runtime, never another shell command.
  const heredoc = /^(.*?)<<(['"])([a-zA-Z_][a-zA-Z0-9_]*)\2[ \t]*\n([\s\S]*)$/u.exec(command);
  if (heredoc) {
    const lines = heredoc[4]!.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.pop() !== heredoc[3] || lines.includes(heredoc[3]!)) return;
    command = heredoc[1]!;
  }
  if (/[\r\n]/u.test(command)) return;
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = '';
      else {
        if (quote === '"' && /[$`\\]/u.test(character)) return;
        word += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === ' ' || character === '\t') {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      if (!/[a-zA-Z0-9_./:@%+=,-]/u.test(character)) return;
      word += character;
      started = true;
    }
  }
  if (quote) return;
  if (started) words.push(word);
  return words;
}
