// A claude that fails before it prints a result, like a bad --resume session id.
process.stderr.write('No conversation found with session ID: 00000000\n');
process.exit(1);
