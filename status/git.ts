/**
 * Git Status Module
 *
 * Provides git status detection and .git directory resolution.
 * Used by the status extension to show branch, ahead/behind,
 * staged/modified/deleted/conflicted/untracked counts.
 */

import path from "node:path";

// ── Git status types ──

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  deleted: number;
  conflicted: number;
  untracked: number;
}

// ── Collect git status ──

export async function collectGitStatus(
  cwd: string,
  execFn: (cmd: string, args: string[], opts?: { cwd: string }) => Promise<{ stdout: string }>,
): Promise<GitStatus | null> {
  try {
    const checkResult = await execFn("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).catch(() => undefined);
    if (!checkResult?.stdout?.trim()?.startsWith("true")) return null;

    let branch = "detached";
    const branchResult = await execFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).catch(() => undefined);
    if (branchResult?.stdout?.trim()) {
      const b = branchResult.stdout.trim();
      branch = b === "HEAD" ? "detached" : b;
    }
    if (branch === "detached") {
      const shaResult = await execFn("git", ["rev-parse", "--short", "HEAD"], { cwd }).catch(() => undefined);
      if (shaResult?.stdout?.trim()) {
        branch = `detached@${shaResult.stdout.trim()}`;
      }
    }

    let ahead = 0;
    let behind = 0;
    const abResult = await execFn(
      "git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd },
    ).catch(() => undefined);
    if (abResult?.stdout?.trim()) {
      const parts = abResult.stdout.trim().split(/\s+/);
      ahead = parseInt(parts[0] || "0", 10) || 0;
      behind = parseInt(parts[1] || "0", 10) || 0;
    }

    let staged = 0;
    let modified = 0;
    let deleted = 0;
    let conflicted = 0;
    let untracked = 0;

    const statusResult = await execFn(
      "git", ["status", "--porcelain=2", "--untracked-files=normal"], { cwd },
    ).catch(() => undefined);
    if (statusResult?.stdout) {
      for (const line of statusResult.stdout.split("\n")) {
        if (line.startsWith("1 ")) {
          const xCh = line[2];
          const yCh = line[3];
          if (xCh === "u" || yCh === "u") { conflicted++; continue; }
          if (xCh === "?") { untracked++; continue; }
          if (xCh === "!") continue;
          if (xCh === "A" || xCh === "C" || xCh === "R") staged++;
          if (xCh === "M") staged++;
          if (xCh === "D") deleted++;
          if (yCh === "M" || yCh === "R") modified++;
          if (yCh === "D") deleted++;
        } else if (line.startsWith("2 ")) {
          staged++;
        } else if (line.startsWith("u ")) {
          conflicted++;
        } else if (line.startsWith("? ")) {
          untracked++;
        }
      }
    }

    return { branch, ahead, behind, staged, modified, deleted, conflicted, untracked };
  } catch {
    return null;
  }
}

// ── Resolve .git directory ──

/**
 * Determine the actual .git directory path (handles worktrees, submodules).
 * Returns null if not a git repository.
 */
export async function resolveGitDir(
  cwd: string,
  execFn: (cmd: string, args: string[], opts?: { cwd: string }) => Promise<{ stdout: string }>,
): Promise<string | null> {
  try {
    const result = await execFn("git", ["rev-parse", "--git-dir"], { cwd });
    const gitDir = result.stdout.trim();
    if (!gitDir) return null;
    return path.resolve(cwd, gitDir);
  } catch {
    return null;
  }
}
