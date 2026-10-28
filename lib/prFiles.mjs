// This module works out, for each repo, the pull request that its current branch would open: the base
// branch, any PR that already exists, the commits, and the files. Those files are what skim shows.
// It only reads: it runs git and the read-only gh commands, and never `gh pr create`.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The repos in the order their PRs should be merged: Core first, the clients after. */
export const DEFAULT_REPOS = ['TheBrainNetCore', 'Athena', 'Vulcan', 'Deku', 'TheBrainCloud', 'KezaEdit', 'Ceres'];

const SKIMMABLE = /\.(cs|razor)$/;

async function git(cwd, args) {
	const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

async function tryGit(cwd, args) {
	try {
		return await git(cwd, args);
	} catch {
		return null;
	}
}

async function gh(args) {
	const { stdout } = await run('gh', args, { maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

/**
 * Returns one group per repo whose branch has commits that its base does not. Options: `root` (the tb
 * folder), `repos` (folder names), `base` (forces the base branch), `onlyNew` (only added files), `only`
 * (folder prefixes or globs, relative to root) and `fetch` (runs `git fetch` first).
 */
export async function loadPrGroups({ root, repos = DEFAULT_REPOS, base, onlyNew = false, only = [], fetch = false }) {
	const matchers = only.map(toMatcher);
	const groups = await Promise.all(repos.map(repo => loadRepo(root, repo, { base, onlyNew, matchers, fetch })));
	return groups.filter(g => g != null);
}

async function loadRepo(root, repo, { base, onlyNew, matchers, fetch }) {
	const dir = path.join(root, repo);
	if(!existsSync(path.join(dir, '.git'))) {
		return null;
	}
	if(fetch) {
		await tryGit(dir, ['fetch', '--quiet', 'origin']);
	}
	const branch = (await git(dir, ['branch', '--show-current'])).trim();
	if(branch === '') {
		return null;
	}
	const remote = ((await tryGit(dir, ['remote', 'get-url', 'origin'])) ?? '').trim();
	const ghRepo = /github\.com[:/](.+?)(\.git)?$/.exec(remote)?.[1] ?? null;
	const notes = [];
	const pr = ghRepo == null ? null : await findOpenPr(ghRepo, branch, notes);
	const baseBranch = (base ?? pr?.baseRefName ?? (ghRepo == null ? null : await defaultBranch(ghRepo, notes)) ?? 'master').replace(/^origin\//, '');
	if(branch === baseBranch) {
		return null;
	}
	const baseRef = `origin/${baseBranch}`;
	const commits = count(await tryGit(dir, ['rev-list', '--count', `${baseRef}..HEAD`]));
	if(!commits) {
		return null;
	}

	const [behindBase, upstream, diffFiles, dirty] = await Promise.all([
		tryGit(dir, ['rev-list', '--count', `HEAD..${baseRef}`]).then(count),
		readUpstream(dir),
		pr != null ? prFilesFromGh(ghRepo, pr.number, dir, baseRef, notes) : diffFilesFromGit(dir, baseRef),
		readDirty(dir),
	]);

	const byPath = new Map(diffFiles.map(f => [f.repoPath, f]));
	for(const [repoPath, untracked] of dirty) {
		const file = byPath.get(repoPath);
		if(file != null) {
			file.dirty = true;
		} else {
			byPath.set(repoPath, { repoPath, status: untracked ? 'N' : 'W', add: null, del: null, dirty: true });
		}
	}

	const all = [...byPath.values()];
	const deleted = all.filter(f => f.status === 'D').length;
	const files = all
		.filter(f => f.status !== 'D' && SKIMMABLE.test(f.repoPath))
		.map(f => ({ ...f, path: `${repo}/${f.repoPath}` }))
		.filter(f => !onlyNew || f.status === 'A' || f.status === 'N')
		.filter(f => matchers.length === 0 || matchers.some(m => m(f.path)))
		.sort((a, b) => a.path.localeCompare(b.path));
	await Promise.all(files.map(async f => {
		try {
			const text = await readFile(path.join(root, f.path), 'utf8');
			f.lines = text.split('\n').length;
		} catch {
			f.lines = null;
		}
	}));

	return {
		repo,
		ghRepo,
		branch,
		base: baseBranch,
		pr,
		commits,
		behindBase,
		upstream,
		dirtyCount: dirty.size,
		changedCount: diffFiles.length,
		deletedCount: deleted,
		notes,
		files,
	};
}

async function findOpenPr(ghRepo, branch, notes) {
	try {
		const out = await gh(['pr', 'list', '-R', ghRepo, '--head', branch, '--state', 'open', '--json', 'number,url,title,baseRefName,isDraft']);
		return JSON.parse(out)[0] ?? null;
	} catch(e) {
		notes.push(`gh pr list failed, so an existing PR may be missed: ${firstLine(e)}`);
		return null;
	}
}

async function defaultBranch(ghRepo, notes) {
	try {
		const out = await gh(['repo', 'view', ghRepo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']);
		return out.trim() || null;
	} catch(e) {
		notes.push(`gh repo view failed, so the base is assumed to be master: ${firstLine(e)}`);
		return null;
	}
}

/** Reads an existing PR's files from GitHub. The status of each file comes from the local diff, since
 * gh does not always report it. */
async function prFilesFromGh(ghRepo, number, dir, baseRef, notes) {
	const local = await diffFilesFromGit(dir, baseRef);
	try {
		const out = await gh(['pr', 'view', String(number), '-R', ghRepo, '--json', 'files']);
		const statusOf = new Map(local.map(f => [f.repoPath, f.status]));
		return JSON.parse(out).files.map(f => ({
			repoPath: f.path,
			status: statusOf.get(f.path) ?? changeTypeStatus(f.changeType),
			add: f.additions,
			del: f.deletions,
			dirty: false,
		}));
	} catch(e) {
		notes.push(`gh pr view failed, so the files come from the local diff: ${firstLine(e)}`);
		return local;
	}
}

function changeTypeStatus(changeType) {
	return { ADDED: 'A', DELETED: 'D', RENAMED: 'R', COPIED: 'A' }[changeType] ?? 'M';
}

/** Lists the files that `baseRef...HEAD` changes, which is exactly what a PR into that base shows. */
async function diffFilesFromGit(dir, baseRef) {
	const range = `${baseRef}...HEAD`;
	const [nameStatus, numstat] = await Promise.all([
		git(dir, ['diff', '--name-status', '-M', '-z', range]),
		git(dir, ['diff', '--numstat', '-M', '-z', range]),
	]);
	const files = new Map();
	const tokens = nameStatus.split('\0');
	for(let i = 0; i < tokens.length; i++) {
		const status = tokens[i];
		if(status === '') {
			continue;
		}
		if(status[0] === 'R' || status[0] === 'C') {
			const oldPath = tokens[i + 1];
			const repoPath = tokens[i + 2];
			files.set(repoPath, { repoPath, oldPath, status: status[0] === 'R' ? 'R' : 'A', add: 0, del: 0, dirty: false });
			i += 2;
		} else {
			const repoPath = tokens[i + 1];
			files.set(repoPath, { repoPath, status: status[0], add: 0, del: 0, dirty: false });
			i += 1;
		}
	}
	const stats = numstat.split('\0');
	for(let i = 0; i < stats.length; i++) {
		if(stats[i] === '') {
			continue;
		}
		const [add, del, name] = stats[i].split('\t');
		let repoPath = name;
		if(name === '') {
			// A rename is written as "add del" followed by the old and new paths as separate entries.
			repoPath = stats[i + 2];
			i += 2;
		}
		const file = files.get(repoPath);
		if(file != null) {
			file.add = add === '-' ? null : Number(add);
			file.del = del === '-' ? null : Number(del);
		}
	}
	return [...files.values()];
}

/** Returns the working tree's uncommitted files, mapped to true when the file is untracked. */
async function readDirty(dir) {
	const out = (await tryGit(dir, ['status', '--porcelain=v1', '-z', '-uall'])) ?? '';
	const dirty = new Map();
	const tokens = out.split('\0');
	for(let i = 0; i < tokens.length; i++) {
		const entry = tokens[i];
		if(entry.length < 4) {
			continue;
		}
		const xy = entry.slice(0, 2);
		dirty.set(entry.slice(3), xy === '??');
		if(xy[0] === 'R' || xy[0] === 'C') {
			// A rename is followed by its old path as a separate entry.
			i++;
		}
	}
	return dirty;
}

async function readUpstream(dir) {
	const name = ((await tryGit(dir, ['rev-parse', '--abbrev-ref', '@{u}'])) ?? '').trim();
	if(name === '') {
		return null;
	}
	const counts = ((await tryGit(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])) ?? '').trim().split(/\s+/);
	return { name, behind: Number(counts[0]) || 0, ahead: Number(counts[1]) || 0 };
}

/** Turns an `--only` argument into a test on root-relative paths. A plain path matches itself and
 * everything under it, and a pattern with `*` or `?` is a glob in which `**` crosses folders. */
function toMatcher(pattern) {
	const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
	if(!/[*?]/.test(p)) {
		return f => f === p || f.startsWith(p + '/');
	}
	const source = p
		.replace(/[.+^${}()|[\]]/g, '\\$&')
		.replace(/\*\*\//g, '\u0000')
		.replace(/\*\*/g, '\u0001')
		.replace(/\*/g, '[^/]*')
		.replace(/\?/g, '[^/]')
		.replace(/\u0000/g, '(.*/)?')
		.replace(/\u0001/g, '.*');
	const regex = new RegExp(`^${source}$`);
	return f => regex.test(f);
}

function count(text) {
	return text == null ? 0 : Number(text.trim()) || 0;
}

function firstLine(error) {
	return String(error.stderr || error.message || error).split('\n')[0];
}
