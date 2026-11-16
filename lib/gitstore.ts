// The git object store: blobs, trees and commits as loose objects in memory,
// addressed by their SHA-1 exactly as git computes it, plus the refs that name
// them. Everything else — the contents API, branches, smart HTTP — is built on
// these primitives. No git binary, no disk: node:crypto hashes, Buffers hold.

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface GitRepo {
  objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/main) to the commit sha it points at. */
  refs: Map<string, string>;
}

const repos = new Map<number, GitRepo>();

/** The git state for a repository id, created empty on first use. */
export function gitRepo(repoId: number): GitRepo {
  let repo = repos.get(repoId);
  if (repo === undefined) {
    repo = { objects: new Map(), refs: new Map() };
    repos.set(repoId, repo);
  }
  return repo;
}

/** Forget a repository's git state (when the repository itself is deleted). */
export function dropGitRepo(repoId: number): void {
  repos.delete(repoId);
}

/** SHA-1 of an object exactly as git frames it: "<type> <length>\0" + data. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object and return its sha. Storing the same object twice is a no-op. */
export function writeObject(g: GitRepo, type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!g.objects.has(sha)) g.objects.set(sha, { type, data });
  return sha;
}

/** Read an object by sha, or null when the store does not hold it. */
export function readObject(g: GitRepo, sha: string): GitObject | null {
  return g.objects.get(sha) ?? null;
}

// ---------------------------------------------------------------------------
// Trees. A tree object is a sequence of "<mode> <name>\0" + 20 raw sha bytes,
// entries sorted the git way: by name, directories as if named "name/".

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object's bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('utf8', at, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

/** Serialize tree entries into a tree object and store it; returns the sha. */
export function writeTree(g: GitRepo, entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return writeObject(g, 'tree', Buffer.concat(parts));
}

/**
 * Build (and store) the tree for a flat path → blob sha map, nesting
 * subdirectories as their own trees. Returns the root tree sha.
 */
export function buildTreeFromFiles(g: GitRepo, files: ReadonlyMap<string, string>): string {
  interface Dir {
    files: Map<string, string>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of files) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1] ?? path, sha);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of dir.files) entries.push({ mode: '100644', name, sha });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: build(sub) });
    return writeTree(g, entries);
  };
  return build(root);
}

/** Flatten a tree (recursively) into a path → { sha, mode } map. */
export function flattenTree(g: GitRepo, treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const obj = readObject(g, treeSha);
  if (obj === null || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [subPath, sub] of flattenTree(g, entry.sha, path)) out.set(subPath, sub);
    } else {
      out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  }
  return out;
}

/**
 * Apply file changes (path → blob sha, or null to delete) on top of a base tree
 * and return the new tree's sha. The base may be null for an empty tree.
 */
export function applyChanges(
  g: GitRepo,
  baseTreeSha: string | null,
  changes: ReadonlyMap<string, string | null>,
): string {
  const files = new Map<string, string>();
  if (baseTreeSha !== null) {
    for (const [path, entry] of flattenTree(g, baseTreeSha)) files.set(path, entry.sha);
  }
  for (const [path, sha] of changes) {
    if (sha === null) files.delete(path);
    else files.set(path, sha);
  }
  return buildTreeFromFiles(g, files);
}

// ---------------------------------------------------------------------------
// Commits. The object body is git's: tree line, parent lines, author and
// committer lines, a blank line, then the message.

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  message: string;
}

/** Parse a commit object's bytes. Missing pieces come back empty, never a throw. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], authorName: '', authorEmail: '', authorTs: 0, message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line.slice(7));
      if (match !== null) {
        info.authorName = match[1] ?? '';
        info.authorEmail = match[2] ?? '';
        info.authorTs = Number(match[3] ?? 0);
      }
    }
  }
  return info;
}

/** Write a commit object and return its sha. */
export function writeCommit(
  g: GitRepo,
  input: { tree: string; parents: string[]; authorName: string; authorEmail: string; message: string },
): string {
  const ts = Math.floor(Date.now() / 1000);
  const ident = `${input.authorName} <${input.authorEmail}> ${ts} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', input.message);
  return writeObject(g, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** The parsed commit for a sha, or null when it is not a commit we hold. */
export function commitInfo(g: GitRepo, sha: string): CommitInfo | null {
  const obj = readObject(g, sha);
  if (obj === null || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

// ---------------------------------------------------------------------------
// Refs and history walks.

/** The sha a ref points at, or null. Accepts full names (refs/heads/main). */
export function refSha(g: GitRepo, ref: string): string | null {
  return g.refs.get(ref) ?? null;
}

/** Move (or create) a ref. */
export function setRef(g: GitRepo, ref: string, sha: string): void {
  g.refs.set(ref, sha);
}

/** Delete a ref; true when it existed. */
export function deleteRef(g: GitRepo, ref: string): boolean {
  return g.refs.delete(ref);
}

/** True when `ancestor` is `descendant` itself or reachable from its parents. */
export function isAncestor(g: GitRepo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = commitInfo(g, sha);
    if (info !== null) queue.push(...info.parents);
  }
  return false;
}

/**
 * Commits reachable from a head, newest first: breadth-first over parents,
 * which is the order GitHub's list-commits shows for the histories the suite
 * builds (linear chains and simple merges).
 */
export function walkCommits(g: GitRepo, head: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [head];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = commitInfo(g, sha);
    if (info === null) continue;
    out.push(sha);
    queue.push(...info.parents);
  }
  return out;
}

/** The nearest common ancestor of two commits, or null when unrelated. */
export function mergeBase(g: GitRepo, a: string, b: string): string | null {
  const ancestors = new Set(walkCommits(g, a, 100000));
  for (const sha of walkCommits(g, b, 100000)) {
    if (ancestors.has(sha)) return sha;
  }
  return null;
}

export interface ThreeWayResult {
  /** The merged tree sha, when the merge is clean. */
  tree?: string;
  /** The first conflicting path, when it is not. */
  conflict?: string;
}

/**
 * A file-level three-way merge of two trees against their common base: a path
 * changed on only one side takes that side; changed identically on both takes
 * either; changed differently on both (or deleted against changed) conflicts.
 * This is the granularity the pull-request merge needs — the suite's conflict
 * case edits the same file two ways, its clean cases touch different files or
 * build on one side only.
 */
export function threeWayMergeTrees(
  g: GitRepo,
  baseTree: string | null,
  ourTree: string,
  theirTree: string,
): ThreeWayResult {
  const base = baseTree === null ? new Map<string, string>() : new Map([...flattenTree(g, baseTree)].map(([p, e]) => [p, e.sha]));
  const ours = new Map([...flattenTree(g, ourTree)].map(([p, e]) => [p, e.sha]));
  const theirs = new Map([...flattenTree(g, theirTree)].map(([p, e]) => [p, e.sha]));
  const merged = new Map<string, string>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o === t) {
      if (o !== undefined) merged.set(path, o);
    } else if (b === o) {
      if (t !== undefined) merged.set(path, t);
    } else if (b === t) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return { conflict: path };
    }
  }
  return { tree: buildTreeFromFiles(g, merged) };
}
