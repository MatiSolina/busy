import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorkspace,
  prepareWorkspace,
  type WorkspaceRun,
} from "./workspace";

const execFile = promisify(execFileCallback);
const SHA64 = /^[0-9a-f]{64}$/u;
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/busy-workspace-`);
  roots.push(root);
  return root;
}

async function archive(
  root: string,
  kind: "safe" | "traversal" | "git" = "safe"
): Promise<Uint8Array> {
  const output = `${root}/archive.tar.gz`;
  let script: string;
  if (kind === "traversal") {
    script = `import tarfile,sys; t=tarfile.open(sys.argv[1],'w:gz'); i=tarfile.TarInfo('../escape.txt'); b=b'bad'; i.size=len(b); t.addfile(i, __import__('io').BytesIO(b)); t.close()`;
  } else if (kind === "git") {
    script = `import io,tarfile,sys; t=tarfile.open(sys.argv[1],'w:gz'); i=tarfile.TarInfo('repo-base/.git/config'); b=b'[core]\\n\thooksPath = /tmp/evil\\n'; i.size=len(b); t.addfile(i, io.BytesIO(b)); t.close()`;
  } else {
    script = `import pathlib,tarfile,sys; root=pathlib.Path(sys.argv[1]).parent/'source'; root.mkdir(); (root/'hello.txt').write_text('hello\\n'); (root/'empty.txt').write_bytes(b''); (root/'binary.bin').write_bytes(bytes([0,1,255])); t=tarfile.open(sys.argv[1],'w:gz'); t.add(root,arcname='repo-base'); t.close()`;
  }
  await execFile("python3", ["-c", script, output]);
  return new Uint8Array(await readFile(output));
}

function runner(root: string): WorkspaceRun {
  return {
    run: async (command) => {
      const rewritten = command.replaceAll("/workspace", root);
      const result = await execFile("bash", ["-lc", rewritten], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return result.stdout;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("fenced workspace preparation", () => {
  it("captures committed, untracked, deleted, binary and empty-file changes against the original baseline", async () => {
    const root = await tempRoot();
    const run = runner(root);
    const prepared = await prepareWorkspace(
      run,
      await archive(root),
      "a".repeat(40)
    );
    await run.run(
      "printf 'changed\\n' > /workspace/repo/hello.txt && printf 'new' > /workspace/repo/new.txt && : > /workspace/repo/new-empty.txt && rm /workspace/repo/empty.txt && git -c commit.gpgSign=false -c core.hooksPath=/dev/null -C /workspace/repo add hello.txt && git -c commit.gpgSign=false -c core.hooksPath=/dev/null -C /workspace/repo commit -m changed -q"
    );
    const capture = await captureWorkspace(run, prepared.localBaseSha);
    expect(capture.baseSha).toBe(prepared.localBaseSha);
    expect(capture.diffTruncated).toBe(false);
    expect(capture.manifestDigest).toMatch(SHA64);
    expect(capture.changes.map((change) => change.path).sort()).toEqual([
      "empty.txt",
      "hello.txt",
      "new-empty.txt",
      "new.txt",
    ]);
    expect(
      capture.changes.find((change) => change.path === "empty.txt")?.status
    ).toBe("deleted");
    expect(
      capture.changes.find((change) => change.path === "hello.txt")
        ?.contentBase64
    ).toBe(Buffer.from("changed\n").toString("base64"));
    expect(
      capture.changes.find((change) => change.path === "new-empty.txt")
        ?.contentBase64
    ).toBe("");
    expect(capture.diff).toContain("changed");
  }, 20_000);

  it("rejects archive traversal and changed symlinks", async () => {
    const attackRoot = await tempRoot();
    await expect(
      prepareWorkspace(
        runner(attackRoot),
        await archive(attackRoot, "traversal")
      )
    ).rejects.toThrow("unsafe path");
    const gitRoot = await tempRoot();
    await expect(
      prepareWorkspace(runner(gitRoot), await archive(gitRoot, "git"))
    ).rejects.toThrow("unsafe path");
    const root = await tempRoot();
    const run = runner(root);
    const prepared = await prepareWorkspace(run, await archive(root));
    await run.run("ln -s hello.txt /workspace/repo/link.txt");
    await expect(captureWorkspace(run, prepared.localBaseSha)).rejects.toThrow(
      "symlinks"
    );
  }, 20_000);
});
