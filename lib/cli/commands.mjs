// Every orch command, by name (lib/cli/spec.mjs lists them with their options and help).
import { runCommands } from './runs.mjs';
import { templateCommands } from './templates.mjs';
import { lessonCommands } from './lessons.mjs';
import { moreCommands } from './more.mjs';

export const commands = { ...runCommands, ...templateCommands, ...lessonCommands, ...moreCommands };
commands.boxes = commands.steps; // the old name

// Commands that answer at once: they show things, or (start) hand the slow work to other processes.
export const QUICK = new Set(['status', 'runs', 'run', 'timeline', 'disk', 'stats', 'templates', 'skills', 'repos', 'suggestions', 'rules', 'help', 'start']);
