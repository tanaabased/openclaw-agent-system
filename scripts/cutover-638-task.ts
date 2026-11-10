import cutover638 from './cutover-638.ts';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const result = await cutover638(JSON.parse(Buffer.concat(chunks).toString()));
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
