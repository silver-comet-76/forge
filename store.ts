// The forge's store: one in-memory model for every surface (git, REST, GraphQL, MCP).
// A repository owns its git objects, refs, labels, issues and pull requests; the four surfaces
// read and write the same objects, so a commit pushed over git is the commit REST lists.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

/** The scenario's fixed viewer: the login the trial's bearer token names. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
/** The scenario's fixed epoch (2025-01-01T00:00:00Z); server-built commits count up from it. */
export const EPOCH_SEC = 1735689600;

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  /** One numbering sequence for issues and pull requests, as GitHub numbers them. */
  nextNumber: number;
  nextCommentId: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly repoOrder: Repo[] = [];
  private nextRepoId = 5000;
  private nextGlobalId = 1;
  private seq = 0;

  /** A strictly increasing sequence, for creation order and deterministic commit timestamps. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The commit timestamp for a server-built commit: the scenario epoch plus the sequence. */
  commitTimestamp(): number {
    return EPOCH_SEC + this.nextSeq();
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    return this.repoOrder.filter((repo) => repo.owner === VIEWER_LOGIN);
  }

  getRepoById(id: number): Repo | undefined {
    return this.repoOrder.find((repo) => repo.id === id);
  }

  // -------------------------------------------------------------------------------------------
  // git objects and refs
  // -------------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Resolve a branch name or a commit/tag oid to a commit oid, or null. */
  resolveCommit(repo: Repo, refOrSha: string): string | null {
    const byRef = repo.refs.get(`refs/heads/${refOrSha}`);
    if (byRef !== undefined) return peelToCommit(this.lookup(repo), byRef);
    if (repo.refs.has(`refs/tags/${refOrSha}`)) {
      return peelToCommit(this.lookup(repo), repo.refs.get(`refs/tags/${refOrSha}`)!);
    }
    if (isObjectId(refOrSha)) {
      const object = repo.objects.get(refOrSha);
      if (!object) return null;
      if (object.type === 'commit') return refOrSha;
      if (object.type === 'tag') return peelToCommit(this.lookup(repo), refOrSha);
    }
    return null;
  }

  /** The commit a ref points at (peeled), or null when the ref does not exist. */
  refCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    return peelToCommit(this.lookup(repo), oid);
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!ref.startsWith('refs/heads/')) continue;
      out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
    }
    return out;
  }

  /** Commits reachable from a ref/oid, newest first (depth-first from the tip). */
  listCommits(repo: Repo, refOrSha: string): Array<{ sha: string; message: string }> {
    const tip = this.resolveCommit(repo, refOrSha);
    if (tip === null) return [];
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      // The stored object ends its message with a newline (git's convention); the REST view
      // presents the message the caller sent, without it.
      out.push({ sha: oid, message: commit.message.replace(/\n$/, '') });
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // trees: flat path maps, built and read back
  // -------------------------------------------------------------------------------------------

  /** A tree as a flat path -> {oid, mode} map (recursive, sorted by path). */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree from a flat path map, creating every intermediate tree object. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Read one path out of a commit's tree: a file, a directory listing, or null. */
  readPath(
    repo: Repo,
    commitOid: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const flat = this.flattenTree(repo, parseCommit(commit.data).tree);
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean === '') {
      const entries: Array<{ name: string; path: string; oid: string; mode: string }> = [];
      const seen = new Set<string>();
      for (const [filePath, entry] of flat) {
        const top = filePath.split('/')[0]!;
        if (seen.has(top)) continue;
        seen.add(top);
        if (filePath === top) entries.push({ name: top, path: top, oid: entry.oid, mode: entry.mode });
        else {
          // A directory: its oid is the tree object at that path.
          const treeOid = this.treeOidAtPath(repo, parseCommit(commit.data).tree, top);
          if (treeOid !== null) entries.push({ name: top, path: top, oid: treeOid, mode: '40000' });
        }
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { kind: 'dir', entries };
    }
    const file = flat.get(clean);
    if (file) {
      const blob = repo.objects.get(file.oid);
      if (!blob || blob.type !== 'blob') return null;
      return { kind: 'file', oid: file.oid, data: blob.data };
    }
    // A directory: every flat path under clean/ contributes one entry.
    const prefix = `${clean}/`;
    const entries: Array<{ name: string; path: string; oid: string; mode: string }> = [];
    const seen = new Map<string, { oid: string; mode: string }>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const top = rest.split('/')[0]!;
      if (seen.has(top)) continue;
      if (rest === top) seen.set(top, entry);
      else {
        const treeOid = this.treeOidAtPath(repo, parseCommit(commit.data).tree, `${clean}/${top}`);
        if (treeOid !== null) seen.set(top, { oid: treeOid, mode: '40000' });
      }
    }
    if (seen.size === 0) return null;
    for (const [name, entry] of [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries.push({ name, path: `${clean}/${name}`, oid: entry.oid, mode: entry.mode });
    }
    return { kind: 'dir', entries };
  }

  private treeOidAtPath(repo: Repo, rootTreeOid: string, path: string): string | null {
    let current = rootTreeOid;
    for (const segment of path.split('/')) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  // -------------------------------------------------------------------------------------------
  // contents: commit a file, delete a file
  // -------------------------------------------------------------------------------------------

  /**
   * Write one file on a branch, building the commit. When the branch does not exist it is created
   * from the default branch's tip (or as the root commit when the repo is empty). Returns the
   * commit sha, the blob sha and whether the file was created (201) or updated (200).
   * A stale `sha` (not the file's current blob) is a 409.
   */
  commitFile(
    repo: Repo,
    options: { branch: string; path: string; content: Buffer; message: string; sha?: string },
  ): { status: 201 | 200; commitSha: string; blobSha: string } | { error: 409 | 422; message: string } {
    const ref = `refs/heads/${options.branch}`;
    const tipOid = repo.refs.get(ref);
    let baseFiles = new Map<string, { oid: string; mode: string }>();
    let parents: string[] = [];
    if (tipOid !== undefined) {
      const tipCommit = this.refCommit(repo, ref);
      if (tipCommit === null) return { error: 422, message: `branch ${options.branch} points at an unreadable object` };
      const commit = repo.objects.get(tipCommit);
      if (!commit || commit.type !== 'commit') return { error: 422, message: `branch ${options.branch} points at an unreadable object` };
      baseFiles = this.flattenTree(repo, parseCommit(commit.data).tree);
      parents = [tipCommit];
    } else if (options.branch !== repo.defaultBranch) {
      // A new branch starts from the default branch's tip.
      const defaultTip = this.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== null) {
        const commit = repo.objects.get(defaultTip);
        if (commit && commit.type === 'commit') {
          baseFiles = this.flattenTree(repo, parseCommit(commit.data).tree);
          parents = [defaultTip];
        }
      }
    }
    const cleanPath = options.path.replace(/^\/+/, '');
    const existing = baseFiles.get(cleanPath);
    const blobSha = this.putObject(repo, 'blob', options.content);
    if (existing) {
      if (options.sha !== undefined && options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return { error: 409, message: `sha ${options.sha} does not match the current blob ${existing.oid}` };
      }
    }
    const files = new Map(baseFiles);
    files.set(cleanPath, { oid: blobSha, mode: '100644' });
    const treeOid = this.buildTreeFromFiles(repo, files);
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents,
        message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
        author: VIEWER_IDENTITY,
        committer: VIEWER_IDENTITY,
        timestamp: this.commitTimestamp(),
      }),
    );
    repo.refs.set(ref, commitOid);
    return { status: existing ? 200 : 201, commitSha: commitOid, blobSha };
  }

  /** Delete one file from a branch's tip, building the commit. */
  deleteFile(
    repo: Repo,
    options: { branch: string; path: string; message: string; sha?: string },
  ): { commitSha: string } | { error: 404 | 409; message: string } {
    const ref = `refs/heads/${options.branch}`;
    const tipCommit = this.refCommit(repo, ref);
    if (tipCommit === null) return { error: 404, message: `branch ${options.branch} does not exist` };
    const commit = repo.objects.get(tipCommit);
    if (!commit || commit.type !== 'commit') return { error: 404, message: `branch ${options.branch} does not exist` };
    const cleanPath = options.path.replace(/^\/+/, '');
    const files = this.flattenTree(repo, parseCommit(commit.data).tree);
    const existing = files.get(cleanPath);
    if (!existing) return { error: 404, message: `path ${cleanPath} does not exist` };
    if (options.sha !== undefined && options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { error: 409, message: `sha ${options.sha} does not match the current blob ${existing.oid}` };
    }
    files.delete(cleanPath);
    const treeOid = this.buildTreeFromFiles(repo, files);
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [tipCommit],
        message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
        author: VIEWER_IDENTITY,
        committer: VIEWER_IDENTITY,
        timestamp: this.commitTimestamp(),
      }),
    );
    repo.refs.set(ref, commitOid);
    return { commitSha: commitOid };
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: 422; message: string } {
    const labels: string[] = [];
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { error: 422, message: `label ${JSON.stringify(name)} does not exist` };
      labels.push(name);
    }
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      createdSeq: this.nextSeq(),
      comments: [],
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: repo.nextCommentId, body };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests: diff, merge
  // -------------------------------------------------------------------------------------------

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: 422; message: string } {
    const headTip = this.refCommit(repo, `refs/heads/${head}`);
    if (headTip === null) return { error: 422, message: `head branch ${head} does not exist` };
    const baseTip = this.refCommit(repo, `refs/heads/${base}`);
    if (baseTip === null) return { error: 422, message: `base branch ${base} does not exist` };
    const existing = repo.pulls.find(
      (pull) => pull.head.ref === head && pull.base.ref === base && pull.state === 'open',
    );
    if (existing) return { error: 422, message: `a pull request from ${head} to ${base} is already open` };
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: head, sha: headTip },
      base: { ref: base, sha: baseTip },
    };
    this.nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The first common ancestor of two commits (nearest by BFS from both sides), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = new Map<string, number>();
    const queueA: string[] = [a];
    fromA.set(a, 0);
    while (queueA.length) {
      const oid = queueA.shift()!;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!fromA.has(parent)) {
          fromA.set(parent, fromA.get(oid)! + 1);
          queueA.push(parent);
        }
      }
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>([b]);
    let best: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    while (queueB.length) {
      const oid = queueB.shift()!;
      const distA = fromA.get(oid);
      if (distA !== undefined && distA < bestDist) {
        best = oid;
        bestDist = distA;
      }
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seenB.has(parent)) {
          seenB.add(parent);
          queueB.push(parent);
        }
      }
    }
    return best;
  }

  /** Line counts for a changed file: additions and deletions by line-multiset diff. */
  private lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
    const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    const newCounts = new Map<string, number>();
    for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
    for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
    return { additions, deletions };
  }

  /** The changed files between two commits' trees. */
  diffCommits(
    repo: Repo,
    baseCommitOid: string,
    headCommitOid: string,
  ): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const baseCommit = repo.objects.get(baseCommitOid);
    const headCommit = repo.objects.get(headCommitOid);
    if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') return [];
    const baseFiles = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFiles = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base && !head) {
        const data = repo.objects.get(base.oid)?.data ?? null;
        const { deletions } = this.lineDiff(data, null);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!base && head) {
        const data = repo.objects.get(head.oid)?.data ?? null;
        const { additions } = this.lineDiff(null, data);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base && head && base.oid !== head.oid) {
        const oldData = repo.objects.get(base.oid)?.data ?? null;
        const newData = repo.objects.get(head.oid)?.data ?? null;
        const { additions, deletions } = this.lineDiff(oldData, newData);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose tree is the head tip's
   * tree, parented on the base tip. Returns the merge commit sha, or a conflict when the head and
   * the base both changed the same file differently since their merge base.
   */
  /** Whether a pull request would merge cleanly right now (its GraphQL mergeable). */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.merged) return 'MERGEABLE';
    const headTip = this.refCommit(repo, `refs/heads/${pull.head.ref}`);
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base.ref}`);
    if (headTip === null || baseTip === null) return 'CONFLICTING';
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseCommit = base === null ? null : repo.objects.get(base);
    const baseTree = baseCommit && baseCommit.type === 'commit' ? this.flattenTree(repo, parseCommit(baseCommit.data).tree) : new Map<string, { oid: string; mode: string }>();
    const headCommit = repo.objects.get(headTip);
    const baseTipCommit = repo.objects.get(baseTip);
    if (!headCommit || headCommit.type !== 'commit' || !baseTipCommit || baseTipCommit.type !== 'commit') {
      return 'CONFLICTING';
    }
    const headFiles = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const baseTipFiles = this.flattenTree(repo, parseCommit(baseTipCommit.data).tree);
    for (const path of new Set([...headFiles.keys(), ...baseTipFiles.keys(), ...baseTree.keys()])) {
      const atBase = baseTree.get(path)?.oid ?? null;
      const atHead = headFiles.get(path)?.oid ?? null;
      const atTip = baseTipFiles.get(path)?.oid ?? null;
      if (atHead !== atBase && atTip !== atBase && atHead !== atTip) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: 405; message: string } {
    if (pull.state !== 'open' || pull.merged) return { error: 405, message: `pull request #${pull.number} is already ${pull.merged ? 'merged' : 'closed'}` };
    const headTip = this.refCommit(repo, `refs/heads/${pull.head.ref}`);
    const baseTip = this.refCommit(repo, `refs/heads/${pull.base.ref}`);
    if (headTip === null || baseTip === null) return { error: 405, message: 'the head or base branch no longer exists' };
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseCommit = base === null ? null : repo.objects.get(base);
    const baseTree = baseCommit && baseCommit.type === 'commit' ? this.flattenTree(repo, parseCommit(baseCommit.data).tree) : new Map<string, { oid: string; mode: string }>();
    const headCommit = repo.objects.get(headTip);
    const baseTipCommit = repo.objects.get(baseTip);
    if (!headCommit || headCommit.type !== 'commit' || !baseTipCommit || baseTipCommit.type !== 'commit') {
      return { error: 405, message: 'the head or base tip is unreadable' };
    }
    const headFiles = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const baseTipFiles = this.flattenTree(repo, parseCommit(baseTipCommit.data).tree);
    for (const path of new Set([...headFiles.keys(), ...baseTipFiles.keys(), ...baseTree.keys()])) {
      const atBase = baseTree.get(path)?.oid ?? null;
      const atHead = headFiles.get(path)?.oid ?? null;
      const atTip = baseTipFiles.get(path)?.oid ?? null;
      if (atHead !== atBase && atTip !== atBase && atHead !== atTip) {
        return { error: 405, message: `merge conflict in ${path}` };
      }
    }
    const headTree = parseCommit(headCommit.data).tree;
    const mergeOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: headTree,
        parents: [baseTip],
        message: `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}\n`,
        author: VIEWER_IDENTITY,
        committer: VIEWER_IDENTITY,
        timestamp: this.commitTimestamp(),
      }),
    );
    repo.refs.set(`refs/heads/${pull.base.ref}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = new Date(this.commitTimestamp() * 1000).toISOString();
    pull.merge_commit_sha = mergeOid;
    pull.base.sha = mergeOid;
    return { sha: mergeOid };
  }

  /** The objects reachable from a repo's refs (for the git fixture's bookkeeping). */
  reachableFromRefs(repo: Repo): Set<string> {
    const tips: string[] = [];
    for (const oid of repo.refs.values()) {
      const object = repo.objects.get(oid);
      if (object) tips.push(oid);
    }
    return collectReachable(tips, this.lookup(repo), { allowMissing: true });
  }
}

/** True when `ancestor` is an ancestor of `tip` in this repo (or equal). */
export function isAncestorIn(repo: Repo, ancestor: string, tip: string): boolean {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  return isAncestor(lookup, ancestor, tip);
}

/** The tag object at a ref, peeled to its commit, or null. */
export function peeledTagTarget(repo: Repo, refOid: string): string | null {
  const object = repo.objects.get(refOid);
  if (!object) return null;
  if (object.type === 'tag') return peelToCommit((oid) => repo.objects.get(oid), refOid);
  if (object.type === 'commit') return refOid;
  return null;
}

/** Parse a tag object for its target, or return the oid itself when it is not a tag. */
export function tagTarget(repo: Repo, oid: string): { target: string; isTag: boolean } {
  const object = repo.objects.get(oid);
  if (object && object.type === 'tag') {
    return { target: parseTag(object.data).object, isTag: true };
  }
  return { target: oid, isTag: false };
}
