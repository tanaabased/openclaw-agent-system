import runHostCommand from '../api/host-command.ts';

await runHostCommand(process.argv[2]!, process.argv.slice(3), process.env, []);
