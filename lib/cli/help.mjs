// The help text of orch.

export const HELP = `Orchestra commands (node bin/orch.mjs <command>):
  setup --itp <folder> [--email …]        first time on a PC (and after a pull): the ITP folder, starter
                                          templates, Orchestra's skills into ~/.claude/skills, missing tools
  status                                  what is working and what needs you
  runs [--all]                            the board: every run, needs-you first
  run <run>                               one run: its steps, notes, activity, PR links
  start <template> <ticket>... [--text "job"] [--repos api,webclient|none] [--base api=origin/x] [--draft]
                                          one run per ticket or quoted job text (or one run for --text)
  reopen <run>|all                        reopen a stopped run's tab (same conversation); starts a draft
  stop <run>                              close a run's tab, or take it out of the queue
  clean <run> [--force]                   free its space: stop what runs from its folder, remove the folder and its
                                          Claude conversation files (branches, notes and stats stay)
  clean --done | --stale [--force]        every finished run whose tab is closed | every run left alone 7+ days
  disk                                    the space each run folder takes
  delete <run> [--force]                  remove the run completely (it also leaves Stats)
  steps <run> --set '<json list>'         change the steps of a run that has not finished
  timeline <run> [--limit N]              the run's log and activity
  app [release <run>]                     who has the app, who waits for it, whose code it serves
  app start [--services a,b] [--with a,b] [--without a,b] [--force]   the app for you, from your own ITP
                                          checkout (refused while a run has it); you hold it until: app stop.
                                          --without mission: no Mission consumer, XatBot stays on Primary
  app stop | restart | wait | logs [service] | release   your app (logs: <checkout>/.run-logs/<service>.log)
  back <run> <step> [why]               go back to a finished step (number or name): copies of it and the steps after
                                          it are added, the old ones stay as history; type next in its tab. In the tab:
                                          /orchestra back build fix the review findings (starts at once)
  model <run> [model] [effort]          the model and effort of the step the run is on (only this run). A step
                                          working now switches when you type "/orchestra model" in its tab. In the tab:
                                          /orchestra model opus effort high · /orchestra effort max · /orchestra model
  about <run> ["text"]                  what the ticket is about (the run says it by itself; set it by hand here)
  watch <run> [--once]                  the run's steps and pins, redrawn live (the pane on the right of its tab)
  pin <run> ["text"] [--title "…"]       pin text to the run's pane (no text: show its pins in full)
  unpin <run> [N|all]                    remove pin N as the pane numbers it (1 = newest; none: the one it shows)
  lessons <run>                           look for lessons in a run now
  templates                               list templates
  template show <id>
  template new <id> <first-skill> --name "Name" [--tracking on|off] [--repos api,webclient]
  template copy <id> <new-id> [--name "Name"]
  template set <id> name="…" tracking=on|off repos=api,webclient model=… effort=…
  template add <id> <skill> [--at N] [--label "…"] [--args "…"] [--wait] [--app] [--explain] [--fresh] [--model m] [--effort e]
  template step <id> <step> label="…" args="…" wait=on|off app=on|off explain=on|off fresh=on|off model=… effort=…
                                          fresh: the step starts a new conversation (cheaper; it gets the story so far)
                                          model: opus|sonnet|haiku|fable|<id>|none · effort: low|medium|high|xhigh|max|
                                          ultracode (many helpers, costly)|none. A step with none keeps the one before.
  template move <id> <step> <position>
  template remove <id> <step>
  template save <id> --json '<template>'
  template delete <id>
  skills [search]                         find skills (name, description, tracking mark)
  skill-mark <skill> auto|writes|clean    correct a skill's tracking mark
  repos                                   the ITP repos a run can use
  suggestions [--all]                     lessons waiting for your yes or no
  suggestion <id> accept|reject|apply [--text "…"] [--apply] [--change '<json>'] [--template <id>]
                                          accept a workflow change with --apply to change its template now
  rules [--set "…" | --add "…"]           your rules (every run follows them)
  stats                                   spend, templates, skills, recent runs
  settings [max=N] [learn=on|off] [pane=on|off] [panesize=15..70] [launcher=apphost|runstack]
                                          panesize: the pane's width, % of the tab · launcher: how the app starts
A <run> is a Jira key (ITP2-14852), words from its name ("sweden row"), or the end of its id.`;
