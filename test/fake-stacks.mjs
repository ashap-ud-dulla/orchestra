// A stand-in for the itp-stacks script in tests (ORCHESTRA_STACKS): numbers stacks in FAKE_STACKS_STATE (a JSON
// file), writes every call there, and prints what the real one prints on success ("Stack N is up").
// FAKE_STACKS_FAIL=<words> makes a call that contains them fail.
import fs from 'node:fs';

const file = process.env.FAKE_STACKS_STATE;
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { next: 1, stacks: {}, calls: [] };
const words = process.argv.slice(2);
s.calls.push(words.join(' '));
const done = (code) => {
  fs.writeFileSync(file, JSON.stringify(s, null, 1));
  process.exit(code);
};
if (process.env.FAKE_STACKS_FAIL && words.join(' ').includes(process.env.FAKE_STACKS_FAIL)) {
  console.log('Only 1.0 GB RAM available, 95% committed - another stack would make the PC page.');
  done(1);
}
const [verb, n] = words;
if (verb === 'new') {
  const num = s.next++;
  s.stacks[num] = 'up';
  console.log(`Stack ${num} is up (${words[words.indexOf('-Only') + 1]})`);
  done(0);
}
if (verb === 'start') {
  s.stacks[n] = 'up';
  console.log(`Stack ${n} is up`);
  done(0);
}
if (verb === 'stop') s.stacks[n] = 'stopped';
if (verb === 'destroy') delete s.stacks[n];
done(0);
