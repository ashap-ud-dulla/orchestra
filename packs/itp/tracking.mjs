// ITP's tracking: Teamspace (the team's tracker server) and the vault (ITPKV, notes kept in git).
// With tracking OFF a run may not call Teamspace or write the vault; the core guard and the skill scan use these
// patterns (lib/guard.mjs, lib/tracking.mjs). Nothing here calls Teamspace.

// The teamspace program, its helpers, its server, and the ITP scripts that sync to it.
const commands = [
  /teamspace\.exe/i,
  /(?:^|[;&|\n(]|\/)\s*teamspace["']?(?=\s|$)/,
  /\bteamspace_bin\b|\$\{?TEAMSPACE_BIN\b/,
  /\bregistry_call\b|\bboard_sync_status\b|\bREGISTRY_URL=|registry-url|\bITP_REGISTRY_OFF=(?!1)/,
  /https?:\/\/[^\s"']*teamspace/i,
  /\b(?:close-epic|sync-[\w-]+|doc-sync|teamspace-env|install-teamspace|register-autopilot-usecases)\.(?:sh|ps1)\b/,
];

// Signs in a skill's SKILL.md that it writes to Teamspace or the vault. A plain mention is not enough.
const signs = [
  [/registry_call\s+(?:POST|PUT|PATCH|DELETE)\b/, 'sends changes to Teamspace (registry_call)'],
  [/teamspace\.exe|\bteamspace_bin\b|\$\{?TEAMSPACE_BIN\b/, 'runs the teamspace program'],
  [/\bboard_sync_status\b|\bsync-plan-status\.sh\b/, 'moves tickets on the Teamspace board'],
  [/\bclose-epic\.sh\b/, 'runs close-epic.sh'],
  [/\b(?:sync-vault|sync-adrs|sync-solutions|sync-artifact|doc-sync)\.sh\b/, 'runs a sync script'],
  [/(?:write|writes|create|creates|save|saves|update|updates|append|commit)[^.\n]{0,60}\bITPKV\b|\bITPKV\b[^.\n]{0,40}(?:is written|written to|gets written)/i, 'writes into the vault (ITPKV)'],
];

export default {
  // MCP tools by name (the guard's matcher sees them too).
  tools: 'mcp__.*[Tt]eamspace.*',
  commands,
  // The vault, as a command names it (a regex source): writes there are blocked, reads are fine; the Wrap up step
  // may push it, and switching it to main is fine (the team works on main there).
  place: 'ITPKV|\\$\\{?VAULT_DIR\\b',
  // The vault as a file path (lower case, forward slashes) for Edit and Write.
  placePath: /(?:^|\/)itpkv(?:\/|$)/,
  signs,
  what: 'Teamspace or the vault',
  label: 'Writes to Teamspace/vault',
  message: 'Orchestra: tracking is OFF for this run, so Teamspace and writes to the vault (ITPKV) are blocked. Do not try another way. Go on without it, or say in your final reply what you needed and stop.',
  rule: 'Tracking is OFF for this run. Do not call Teamspace in any way (no teamspace program, no registry_call, no sync or close-epic scripts) and do not write anything under ITPKV (the vault). Reading the vault is fine. If the job cannot be done without one of these, say so in your final reply and stop.',
};
