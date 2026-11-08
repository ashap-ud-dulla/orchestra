// Limits and timings of runs, in one place.

// Run states that need you. Entering one sends a Windows notification (stopped and draft are your own doing), when
// you are really needed (Runner.emitRun).
export const NOTIFY = { 'needs-you': 'asks you something in its terminal', waiting: 'is waiting for you: type next in its terminal', failed: 'failed a step' };

// The prompt goes on the command line, and Windows caps that at 32767 chars.
export const MAX_INPUT_CHARS = 8000;

// The story of earlier steps a fresh step gets on its command line.
export const HANDOFF_STEPS_CHARS = 10000;

export const MAX_BATCH = 20;

// How long a clean-up by itself waits after it failed before it tries again.
export const AUTO_CLEAN_RETRY_MS = 30 * 60 * 1000;

// The pane keeps this many pins, and this many of Claude's last replies (for `pin 2`).

export const MAX_PINS = 20;
export const MAX_REPLIES = 5;

// Lessons: a lessons call ends after 5 minutes (learn.mjs); one marked working for longer than this is stuck.
export const LEARN_STUCK_MS = 15 * 60 * 1000;

// A run tab writes its alive file every 10 s. Fresher than this: the tab is open for sure.
export const TAB_FRESH_MS = 60 * 1000;
// Older than this: the tab is gone, even if its pid is alive (Windows may have given it to another program).
export const TAB_GONE_MS = 10 * 60 * 1000;
// A tab with no alive file and no pid yet: given up after this long.
export const TAB_NO_PID_MS = 3 * 60 * 1000;

// A run start (workspace, tab) that takes longer than this is stuck, even if its process is alive.
export const START_STUCK_MS = 20 * 60 * 1000;
// Work marked by a live process (a clean-up) counts as going on for at most this long.
export const BUSY_MS = 60 * 60 * 1000;
