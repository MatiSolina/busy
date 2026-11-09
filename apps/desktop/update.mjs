// Pure pieces of the self-update in main.mjs, so they are unit-tested.

// BigInt: components past 2^53 would round to equal Numbers.
const parse = (v) =>
  typeof v === "string" && VERSION_RE.test(v) ? v.split(".").map(BigInt) : null;
const VERSION_RE = /^\d+\.\d+\.\d+$/u;

/** Whether version `a` is newer than `b`. Only plain x.y.z counts; anything else is never newer. */
export function isNewer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!(x && y)) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) {
      return x[i] > y[i];
    }
  }
  return false;
}

/** The file main.mjs copies UPDATER_SCRIPT to, inside the state dir, so recovery never depends on the bundle. */
export const UPDATER_FILE = "busy-updater.sh";

// The updater, as sh. main.mjs writes it to <userData>/updater/busy-updater.sh (outside the bundle) and runs it:
//
//   swap PID NEW APP TMP VERSION STATE  detached, after the app quits: waits for PID, stages NEW (an extracted
//                                       Busy.app) as APP.new, swaps it in, verifies it and relaunches APP.
//   recover STATE [RUNNING VERSION]     reconciles an interrupted swap from STATE/journal. With the running bundle
//                                       and its version (the app's startup), it also confirms the update and only
//                                       then deletes the backup; without them (by hand) it never deletes a backup.
//   verify BUNDLE VERSION               exit 0 if BUNDLE is a complete Busy.app of that version.
//
// The journal (STATE/journal) is replaced with temp + rename. It holds op id, phase (staged, old-moved,
// new-installed, verified, cleanup, failed, rolled-back), the new version, an error line and the bundle path last
// (a path may contain newlines). Recovery decides from what is on disk, not from the phase alone, and only touches
// APP, APP.new and APP.old, for a journal APP that is an absolute *.app path with one of those three being a
// complete Busy.app (identifier com.matisolina.busy): a corrupt or edited journal can't aim it anywhere else.
//
// The swap prefers renameatx_np(RENAME_SWAP) (syscall 488, through the system perl), which exchanges APP and
// APP.new atomically on APFS: there is never a moment without a bundle at APP. Without it (another file system, no
// perl) it falls back to two renames; a kill between them leaves APP missing until `recover` runs.
//
// The perl is pinned to the one macOS ships: a perl found on PATH (Homebrew's 5.44, for instance, which GitHub's
// macOS runners put first) may not implement syscall() and would silently drop the swap back to two renames.

/** The perl the exchange runs with. */
export const SYSTEM_PERL = "/usr/bin/perl";
/** renameatx_np(AT_FDCWD, $ARGV[0], AT_FDCWD, $ARGV[1], RENAME_SWAP); exit 0 only if it swapped. */
export const EXCHANGE_PROGRAM =
  "exit(syscall(488, -2, $ARGV[0], -2, $ARGV[1], 2) == 0 ? 0 : 1)";

export const UPDATER_SCRIPT = `set -u
BUSY_ID=com.matisolina.busy

info() { plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null; }

# A complete Busy.app: Info.plist with Busy's identifier, its executable, and VERSION when one is given.
complete() {
  [ -d "$1/Contents/MacOS" ] || return 1
  id=$(info "$1" CFBundleIdentifier) || return 1
  [ "$id" = "$BUSY_ID" ] || return 1
  exe=$(info "$1" CFBundleExecutable) || return 1
  case $exe in ""|*/*|.|..) return 1 ;; esac
  [ -f "$1/Contents/MacOS/$exe" ] && [ -x "$1/Contents/MacOS/$exe" ] || return 1
  [ -z "\${2:-}" ] && return 0
  version=$(info "$1" CFBundleShortVersionString) || return 1
  [ "$version" = "$2" ]
}

present() { [ -e "$1" ] || [ -L "$1" ]; }

# Atomically exchanges two paths on the same volume: renameatx_np(AT_FDCWD, a, AT_FDCWD, b, RENAME_SWAP).
exchange() {
  ${SYSTEM_PERL} -e '${EXCHANGE_PROGRAM}' -- "$1" "$2" 2>/dev/null
}

record() {
  PHASE=$1
  printf '%s\\n%s\\n%s\\n%s\\n%s' "$OP" "$1" "$VERSION" "\${2:-}" "$APP" > "$STATE/journal.tmp" &&
    mv -f "$STATE/journal.tmp" "$STATE/journal"
}

load() {
  [ -f "$STATE/journal" ] && [ ! -L "$STATE/journal" ] || return 1
  { IFS= read -r OP && IFS= read -r PHASE && IFS= read -r VERSION && IFS= read -r ERROR && APP=$(cat); } < "$STATE/journal" 2>/dev/null || return 1
  case $OP in ""|*[!A-Za-z0-9-]*) return 1 ;; esac
  case $PHASE in staged|old-moved|new-installed|verified|cleanup|failed|rolled-back) ;; *) return 1 ;; esac
  case $VERSION in *[!0-9.]*|.*|*.|*..*) return 1 ;; *.*.*) ;; *) return 1 ;; esac
  case $APP in /*.app) ;; *) return 1 ;; esac
  case $APP in */../*|*/./*) return 1 ;; esac
  complete "$APP" || complete "$APP.old" || complete "$APP.new"
}

lock() {
  mkdir -p "$STATE" || return 1
  mkdir "$STATE/lock" 2>/dev/null && { echo $$ > "$STATE/lock/pid"; return 0; }
  holder=$(cat "$STATE/lock/pid" 2>/dev/null) || holder=
  case $holder in ""|*[!0-9]*) ;; *) kill -0 "$holder" 2>/dev/null && return 1 ;; esac
  rm -rf "$STATE/lock"
  mkdir "$STATE/lock" 2>/dev/null && echo $$ > "$STATE/lock/pid"
}

# Puts a complete bundle at APP and normalizes the backup. Never deletes a complete backup of another version.
reconcile() {
  if ! complete "$APP"; then
    present "$APP" && return 1
    if complete "$APP.new" "$VERSION"; then
      mv "$APP.new" "$APP" || return 1
    elif complete "$APP.old"; then
      mv "$APP.old" "$APP" || return 1
    else
      return 1
    fi
  fi
  installed=$(info "$APP" CFBundleShortVersionString)
  if [ "$installed" = "$VERSION" ]; then
    # After an exchange the previous build sits at .new until it is renamed to .old: it is the backup.
    if ! present "$APP.old" && complete "$APP.new" && ! complete "$APP.new" "$VERSION"; then
      mv "$APP.new" "$APP.old"
    fi
    return 0
  fi
  # The previous build is still installed: whatever is staged at .new never went live.
  rm -rf "$APP.new"
}

swap() {
  if load; then
    reconcile
  fi
  rm -f "$STATE/journal"
  APP=$1 VERSION=$2 OP=$$
  if ! complete "$APP"; then
    record failed "The installed Busy.app is incomplete, so the update didn't touch it."
    return
  fi
  if ! complete "$NEW" "$VERSION"; then
    record failed "The download doesn't contain a complete Busy.app $VERSION. Nothing was installed."
    return
  fi
  # APP is complete and is the build that started this update, so these are leftovers.
  rm -rf "$APP.new" "$APP.old"
  if ! { ditto "$NEW" "$APP.new" && complete "$APP.new" "$VERSION"; }; then
    rm -rf "$APP.new"
    record failed "Couldn't copy the update next to the installed app. Nothing was installed."
    return
  fi
  record staged
  if exchange "$APP.new" "$APP"; then
    record new-installed
    mv "$APP.new" "$APP.old"
  else
    if ! mv "$APP" "$APP.old"; then
      rm -rf "$APP.new"
      record failed "Couldn't move the installed app aside. Nothing was installed."
      return
    fi
    record old-moved
    if ! mv "$APP.new" "$APP"; then
      mv "$APP.old" "$APP"
      rm -rf "$APP.new"
      record failed "Couldn't move the update into place. Busy kept the previous version."
      return
    fi
    record new-installed
  fi
  if complete "$APP" "$VERSION"; then
    record verified
    return
  fi
  rm -rf "$APP.new"
  if exchange "$APP.old" "$APP"; then
    rm -rf "$APP.old"
  elif mv "$APP" "$APP.new"; then
    mv "$APP.old" "$APP" && rm -rf "$APP.new"
  fi
  record rolled-back "The installed update didn't check out. Busy kept the previous version."
}

recover() {
  if ! present "$STATE/journal"; then
    echo none
    return
  fi
  if ! load; then
    mv -f "$STATE/journal" "$STATE/journal.invalid"
    echo invalid
    return
  fi
  if [ -n "$RUNNING" ] && [ "$RUNNING" != "$APP" ]; then
    echo elsewhere
    return
  fi
  if ! reconcile; then
    echo stuck
    return
  fi
  if [ -z "$RUNNING" ]; then
    echo "$PHASE"
    return
  fi
  current=$(info "$APP" CFBundleShortVersionString)
  if [ "$current" != "$RUNNING_VERSION" ]; then
    echo pending
  elif [ "$current" = "$VERSION" ] && [ "$PHASE" != failed ] && [ "$PHASE" != rolled-back ]; then
    # The new build launched from APP: only now is the backup no longer needed.
    record cleanup
    rm -rf "$APP.old" "$APP.new"
    rm -f "$STATE/journal"
    echo installed
  else
    rm -rf "$APP.new"
    rm -f "$STATE/journal"
    printf 'failed\\n%s\\n' "$ERROR"
  fi
}

case "\${1:-}" in
swap)
  [ $# -eq 7 ] || exit 64
  PID=$2 NEW=$3 TMP=$5 STATE=$7
  while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
  if lock; then
    swap "$4" "$6"
    rm -rf "$STATE/lock"
  fi
  rm -rf "$TMP"
  open "$4"
  ;;
recover)
  [ $# -eq 2 ] || [ $# -eq 4 ] || exit 64
  STATE=$2 RUNNING="\${3:-}" RUNNING_VERSION="\${4:-}"
  if lock; then
    recover
    rm -rf "$STATE/lock"
  else
    echo busy
  fi
  ;;
verify)
  [ $# -eq 3 ] || exit 64
  complete "$2" "$3"
  ;;
*)
  exit 64
  ;;
esac
`;
