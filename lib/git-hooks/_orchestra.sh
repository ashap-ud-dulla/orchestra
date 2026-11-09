# Shared by Orchestra's git hooks. Orchestra points a run's git here with the env vars
# GIT_CONFIG_KEY_n=core.hooksPath, so nothing is written to the repo itself.
# Each hook does Orchestra's check, then runs the repo's own hook of the same name.

orchestra_refuse() {
  echo "Orchestra: $1" >&2
  exit 1
}

orchestra_branch() {
  git symbolic-ref --short HEAD 2>/dev/null
}

# Runs the repo's own hook, if it has one. Stdin is passed on.
orchestra_chain() {
  name=$1
  shift
  dir=$(git config --local --get core.hooksPath 2>/dev/null)
  if [ -n "$dir" ]; then
    case "$dir" in
      /* | [A-Za-z]:*) ;;
      *) dir="$(git rev-parse --show-toplevel 2>/dev/null)/$dir" ;;
    esac
  else
    dir="$(git rev-parse --git-common-dir 2>/dev/null)/hooks"
  fi
  # Never call ourselves again.
  [ "$(cd "$dir" 2>/dev/null && pwd -P)" = "$(cd "$(dirname "$0")" && pwd -P)" ] && return 0
  hook="$dir/$name"
  [ -f "$hook" ] || return 0
  "$hook" "$@"
}

# The current repo is one where local work on main is allowed (a notes repo the team commits to on main by design,
# the pack's). ORCHESTRA_MAIN_OK lists those folders, one per line.
orchestra_main_ok() {
  orchestra_repo_in "$ORCHESTRA_MAIN_OK"
}

# The Wrap up step works in the run's open tab now (Orchestra keeps this flag in the run's folder).
orchestra_wrap_up() {
  [ -n "$ORCHESTRA_RUN_DIR" ] && [ -f "$ORCHESTRA_RUN_DIR/wrap-up.ok" ]
}

# The current repo is one the Wrap up step may commit and push on main (the pack's, ORCHESTRA_WRAPUP_DIRS).
orchestra_is_wrapup_dir() {
  orchestra_repo_in "$ORCHESTRA_WRAPUP_DIRS"
}

# The current repo's top folder is one of $1 (folders, one per line).
orchestra_repo_in() {
  [ -n "$1" ] || return 1
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  top_p=$(cd "$top" 2>/dev/null && pwd -P)
  old_ifs=$IFS
  IFS='
'
  for d in $1; do
    d_p=$(cd "$d" 2>/dev/null && pwd -P)
    for a in "$top" "$top_p"; do
      for b in "$d" "$d_p"; do
        [ -n "$a" ] && [ -n "$b" ] || continue
        if [ "$(orchestra_norm "$a")" = "$(orchestra_norm "$b")" ]; then IFS=$old_ifs; return 0; fi
      done
    done
  done
  IFS=$old_ifs
  return 1
}

# One spelling for a path: forward slashes, /c/ as c:/, lower case, no trailing slash.
orchestra_norm() {
  printf '%s' "$1" | tr '\\' '/' | sed -e 's#^/\([a-zA-Z]\)/#\1:/#' -e 's#/*$##' | tr 'A-Z' 'a-z'
}

# A branch no run works on: main, master, and (ORCHESTRA_PROTECT_DEFAULT=1, a solution with no pack) the remote's
# default branch.
orchestra_is_main() {
  case "$1" in main | master) return 0 ;; esac
  [ "$ORCHESTRA_PROTECT_DEFAULT" = "1" ] || return 1
  def=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  [ -n "$def" ] && [ "$1" = "${def#origin/}" ]
}

# Refuses work on main, except in the folders allowed on main, and in the Wrap up folders while that step works.
orchestra_no_main() {
  orchestra_is_main "$(orchestra_branch)" || return 0
  orchestra_main_ok && return 0
  orchestra_wrap_up && orchestra_is_wrapup_dir && return 0
  orchestra_refuse "work on the main branch is refused. Use the run's work branch."
}
