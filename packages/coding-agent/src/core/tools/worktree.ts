import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorktreeInfo {
	path: string;
	branch: string;
	baseBranch: string;
}

/**
 * Check if cwd is inside a git repository.
 */
export function isGitRepo(cwd: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the current branch name.
 */
function getCurrentBranch(cwd: string): string {
	try {
		return execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: "pipe" }).toString().trim();
	} catch {
		return "HEAD";
	}
}

/**
 * Create a git worktree for an agent to work in isolation.
 * Returns the worktree path and branch name.
 */
export function createWorktree(cwd: string, agentName: string): WorktreeInfo {
	const timestamp = Date.now();
	const branch = `dg-pi/agent/${agentName}-${timestamp}`;
	const worktreePath = join(tmpdir(), `dg-pi-wt-${agentName}-${timestamp}`);
	const baseBranch = getCurrentBranch(cwd);

	execSync(`git worktree add -b "${branch}" "${worktreePath}"`, {
		cwd,
		stdio: "pipe",
	});

	return { path: worktreePath, branch, baseBranch };
}

/**
 * Check if a worktree has uncommitted changes.
 */
export function hasChanges(worktreePath: string): boolean {
	try {
		const output = execSync("git status --porcelain", { cwd: worktreePath, stdio: "pipe" }).toString().trim();
		return output.length > 0;
	} catch {
		return false;
	}
}

/**
 * Remove a git worktree and its branch (if no changes).
 */
export function removeWorktree(cwd: string, worktreePath: string, branch: string): void {
	try {
		execSync(`git worktree remove "${worktreePath}" --force`, { cwd, stdio: "pipe" });
	} catch {
		// Worktree may already be removed
	}

	// Delete the branch if it exists
	try {
		execSync(`git branch -d "${branch}"`, { cwd, stdio: "pipe" });
	} catch {
		// Branch may have been deleted or have unmerged changes
	}
}
