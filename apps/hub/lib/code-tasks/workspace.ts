import type { GitHubChange } from "./github";

const ROOT = "/workspace/repo";
const ARCHIVE = "/workspace/.busy-repository.tar.gz";
const CAPTURE = "/workspace/.busy-capture.json";
const DIFF = "/workspace/.busy-diff";
const WRITE_CHUNK = 24_576;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024;
const MAX_PUBLIC_DIFF_CHARS = 100_000;
const SHA40 = /^[0-9a-f]{40}$/iu;
const SHA64 = /^[0-9a-f]{64}$/iu;

/** The runner is supplied by the fenced fx HostTool; this module never opens a Sandbox directly. */
export interface WorkspaceRun {
  run: (command: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

export interface PreparedWorkspace {
  fileCount: number;
  localBaseSha: string;
  remoteBaseSha?: string;
  root: string;
}

export interface WorkspaceCapture {
  baseSha: string;
  changes: GitHubChange[];
  diff: string;
  diffTruncated: boolean;
  manifestDigest: string;
}

export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

function output(value: string): string {
  if (typeof value !== "string") {
    throw new WorkspaceError("Workspace command returned a non-text result");
  }
  return value;
}

async function command(run: WorkspaceRun, script: string): Promise<string> {
  try {
    return output(await run.run(script, run.signal));
  } catch (error) {
    throw new WorkspaceError(
      error instanceof Error ? error.message : "Workspace command failed",
      { cause: error }
    );
  }
}

async function writeRemoteBytes(
  run: WorkspaceRun,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new WorkspaceError("Repository archive exceeds the 25 MiB limit");
  }
  await command(run, `: > ${path}`);
  const encoded = Buffer.from(bytes).toString("base64");
  for (let offset = 0; offset < encoded.length; offset += WRITE_CHUNK) {
    const chunk = encoded.slice(offset, offset + WRITE_CHUNK);
    // Base64 contains no shell metacharacters. A short fixed chunk also keeps
    // the command below the 64 KiB shell-tool input limit.
    // biome-ignore lint/performance/noAwaitInLoops: archive chunks must be appended in order.
    await command(run, `printf %s '${chunk}' >> ${path}`);
  }
  await command(
    run,
    `python3 - <<'PY'\nfrom pathlib import Path\nimport base64\np=Path('${path}')\np.write_bytes(base64.b64decode(p.read_text()))\nPY`
  );
}

async function readRemoteText(
  run: WorkspaceRun,
  path: string,
  size: number
): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CAPTURE_BYTES) {
    throw new WorkspaceError("Workspace artifact exceeds the capture limit");
  }
  const chunkBytes = 24_576; // divisible by 3, so each base64 piece is independently decodable
  const offsets = Array.from(
    { length: Math.ceil(size / chunkBytes) },
    (_, index) => index * chunkBytes
  );
  const encoded = await Promise.all(
    offsets.map(async (offset) => {
      const length = Math.min(chunkBytes, size - offset);
      return (
        await command(
          run,
          `dd if=${path} bs=1 skip=${offset} count=${length} status=none | python3 -c 'import base64,sys; sys.stdout.write(base64.b64encode(sys.stdin.buffer.read()).decode())'`
        )
      ).trim();
    })
  );
  return encoded
    .map((piece) => Buffer.from(piece, "base64").toString("utf8"))
    .join("");
}

const SAFE_EXTRACT = `import os, pathlib, tarfile
root = pathlib.Path('/workspace/repo').resolve()
archive = pathlib.Path('/workspace/.busy-repository.tar.gz')
root.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    if len(members) > 20000:
        raise RuntimeError('repository contains too many files')
    total = 0
    for member in members:
        parts = pathlib.PurePosixPath(member.name).parts
        if (not parts or pathlib.PurePosixPath(member.name).is_absolute() or
                parts[0] in ('', '.', '..') or any(part in ('', '..', '.git') for part in parts)):
            raise RuntimeError('archive contains an unsafe path')
        relative = pathlib.PurePosixPath(*parts[1:]) if len(parts) > 1 else pathlib.PurePosixPath()
        if not str(relative) or str(relative) == '.':
            continue
        target = (root / relative).resolve()
        if os.path.commonpath((str(root), str(target))) != str(root):
            raise RuntimeError('archive escapes workspace')
        if member.issym() or member.islnk():
            raise RuntimeError('archive symlinks are not accepted')
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if not member.isfile():
            raise RuntimeError('archive contains an unsupported entry')
        if member.size < 0:
            raise RuntimeError('archive contains an invalid file size')
        total += member.size
        if total > 200 * 1024 * 1024:
            raise RuntimeError('repository exceeds the extracted size limit')
        target.parent.mkdir(parents=True, exist_ok=True)
        source = tar.extractfile(member)
        if source is None:
            raise RuntimeError('archive file could not be read')
        written = 0
        with target.open('wb') as output:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > member.size:
                    raise RuntimeError('archive file exceeds its declared size')
                output.write(chunk)
        target.chmod(member.mode & 0o777)
`;

const CAPTURE_SCRIPT = `import base64, hashlib, json, os, pathlib, subprocess
root = pathlib.Path('/workspace/repo').resolve()
base = os.environ.get('BUSY_BASE_SHA')
if not base or len(base) != 40:
    raise RuntimeError('missing workspace base SHA')
git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', str(root)]
git_env = os.environ.copy()
git_env['GIT_CONFIG_GLOBAL'] = os.devnull
git_env['GIT_CONFIG_SYSTEM'] = os.devnull
status = subprocess.check_output(git + ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z'], env=git_env)
baseline = subprocess.check_output(git + ['diff', '--name-status', '--no-renames', '-z', base], env=git_env)
records = []
for token in status.decode('utf-8', 'surrogateescape').split(chr(0)):
    if token:
        records.append((token[:2], token[3:]))
baseline_tokens = baseline.decode('utf-8', 'surrogateescape').split(chr(0))
index = 0
while index + 1 < len(baseline_tokens):
    code = baseline_tokens[index]
    rel = baseline_tokens[index + 1]
    index += 2
    if code and rel:
        records.append((code[:1], rel))
changes = []
seen = set()
for code, rel in records:
    if not rel or rel in seen:
        continue
    seen.add(rel)
    parts = pathlib.PurePosixPath(rel).parts
    if pathlib.PurePosixPath(rel).is_absolute() or any(part in ('', '..', '.git') for part in parts):
        raise RuntimeError('unsafe changed path')
    candidate = root
    for part in parts:
        candidate /= part
        if candidate.is_symlink():
            raise RuntimeError('changed symlinks and special files are not supported')
    path = candidate.resolve()
    if os.path.commonpath((str(root), str(path))) != str(root):
        raise RuntimeError('changed path escapes workspace')
    deleted = 'D' in code or not path.exists()
    if deleted:
        changes.append({'path': rel, 'status': 'deleted'})
        continue
    if not path.is_file():
        raise RuntimeError('changed symlinks and special files are not supported')
    size = path.stat().st_size
    if size > 4 * 1024 * 1024:
        raise RuntimeError('changed file exceeds the 4 MiB capture limit')
    content = path.read_bytes()
    mode = '100755' if (path.stat().st_mode & 0o111) else '100644'
    changes.append({'path': rel, 'status': 'added' if '?' in code or 'A' in code else 'modified', 'mode': mode, 'contentBase64': base64.b64encode(content).decode('ascii')})
if len(changes) > 20000:
    raise RuntimeError('too many changed files')
manifest = json.dumps(changes, sort_keys=True, separators=(',', ':'))
digest = hashlib.sha256(manifest.encode('utf-8')).hexdigest()
diff = subprocess.run(git + ['diff', '--binary', '--no-ext-diff', '--no-textconv', base], capture_output=True, check=True, env=git_env).stdout
pathlib.Path('/workspace/.busy-diff').write_bytes(diff)
payload = {'baseSha': base, 'manifestDigest': digest, 'changes': changes}
pathlib.Path('/workspace/.busy-capture.json').write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
`;

export async function prepareWorkspace(
  run: WorkspaceRun,
  archive: Uint8Array,
  remoteBaseSha?: string
): Promise<PreparedWorkspace> {
  await command(run, `rm -rf ${ROOT} && mkdir -p ${ROOT}`);
  await writeRemoteBytes(run, ARCHIVE, archive);
  await command(run, `python3 - <<'PY'\n${SAFE_EXTRACT}\nPY`);
  await command(
    run,
    `rm -f ${ARCHIVE} && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c core.hooksPath=/dev/null -C ${ROOT} init -q && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C ${ROOT} config --local core.hooksPath /dev/null && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C ${ROOT} config --local user.name Busy && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C ${ROOT} config --local user.email busy@local.invalid && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c commit.gpgSign=false -c core.hooksPath=/dev/null -C ${ROOT} add -A -f && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c commit.gpgSign=false -c core.hooksPath=/dev/null -C ${ROOT} commit -q -m 'Busy task baseline' && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c core.hooksPath=/dev/null -C ${ROOT} rev-parse HEAD`
  );
  const localBaseSha = (
    await command(
      run,
      `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c core.hooksPath=/dev/null -C ${ROOT} rev-parse HEAD`
    )
  ).trim();
  const fileCount = Number(
    (
      await command(
        run,
        `find ${ROOT} -type f -not -path '${ROOT}/.git/*' | wc -l`
      )
    ).trim()
  );
  if (!Number.isSafeInteger(fileCount) || fileCount > 20_000) {
    throw new WorkspaceError("Repository contains too many files");
  }
  return {
    localBaseSha,
    root: ROOT,
    ...(remoteBaseSha ? { remoteBaseSha } : {}),
    fileCount,
  };
}

export async function captureWorkspace(
  run: WorkspaceRun,
  baseSha: string
): Promise<WorkspaceCapture> {
  if (!SHA40.test(baseSha)) {
    throw new WorkspaceError("Local workspace base SHA is invalid");
  }
  await command(
    run,
    `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c core.hooksPath=/dev/null -C ${ROOT} rev-parse ${baseSha}`
  );
  await command(
    run,
    `BUSY_BASE_SHA=${baseSha} python3 - <<'PY'\n${CAPTURE_SCRIPT}\nPY`
  );
  const jsonSize = Number((await command(run, `wc -c < ${CAPTURE}`)).trim());
  const payload = JSON.parse(await readRemoteText(run, CAPTURE, jsonSize)) as {
    baseSha: string;
    manifestDigest: string;
    changes: GitHubChange[];
  };
  const diffSize = Number((await command(run, `wc -c < ${DIFF}`)).trim());
  const diff = await readRemoteText(
    run,
    DIFF,
    Math.min(diffSize, MAX_OUTPUT_BYTES)
  );
  if (
    payload.baseSha !== baseSha ||
    !SHA64.test(payload.manifestDigest) ||
    !Array.isArray(payload.changes)
  ) {
    throw new WorkspaceError("Workspace capture is invalid");
  }
  return {
    baseSha: payload.baseSha,
    changes: payload.changes,
    diff,
    // Agent task projections persist at most 100k characters. Mark the
    // boundary here while the remote byte size is still available, so the
    // viewer can distinguish an intentionally bounded capture.
    diffTruncated: diffSize >= MAX_PUBLIC_DIFF_CHARS,
    manifestDigest: payload.manifestDigest,
  };
}
