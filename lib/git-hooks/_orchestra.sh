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
