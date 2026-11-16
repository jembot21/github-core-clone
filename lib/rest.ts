// The REST v3 surface under /api/v3. Step 1 covers the root, meta, the viewer and
// repository CRUD with pagination; contents, issues and pull requests mount on the
// same dispatcher in later steps. Every reply is JSON with the contract headers
// (lib/http.ts), every error is a JSON object with a string message, and a
// repository addressed under a stranger's login is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRepo,
  deleteRepo,
  findRepo,
  nowIso,
  viewerLogin,
  type RepoRec,
  type Store,
} from './store.ts';
import {
  applyChanges,
  commitInfo,
  deleteRef,
  dropGitRepo,
  flattenTree,
  gitRepo,
  isAncestor,
  readObject,
  refSha,
  setRef,
  walkCommits,
  writeCommit,
  writeObject,
  type GitRepo,
} from './gitstore.ts';
import { baseUrl, boolField, parseJsonBody, readBody, sendEmpty, sendError, sendJson, stringField } from './http.ts';

/** The scopes header the API root must carry. */
const SCOPES = 'repo, read:org';

/** The viewer as a GitHub user object. */
export function userJson(store: Store, base: string): Record<string, unknown> {
  const login = viewerLogin(store);
  return {
    login,
    id: 1,
    node_id: 'MDQ6VXNlcjE=',
    avatar_url: `${base}/avatars/${login}`,
    gravatar_id: '',
    url: `${base}/api/v3/users/${login}`,
    html_url: `${base}/${login}`,
    type: 'User',
    site_admin: false,
    name: login,
    email: `${login}@example.invalid`,
  };
}

/** A repository as a GitHub repository object. */
export function repoJson(store: Store, repo: RepoRec, base: string): Record<string, unknown> {
  const login = viewerLogin(store);
  const fullName = `${login}/${repo.name}`;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: fullName,
    owner: userJson(store, base),
    private: repo.isPrivate,
    html_url: `${base}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    clone_url: `${base}/${fullName}.git`,
    ssh_url: `git@${base.replace(/^https?:\/\//, '')}:${fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks_count: 0,
    open_issues_count: repo.items.filter((item) => item.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
  };
}

/** Page parameters from a list URL: per_page defaults to 30, page to 1. */
function pageParams(url: URL): { perPage: number; page: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

/**
 * Slice one page out of a list and, while more remain, link the next page (and
 * the last) with a Link header whose URLs stay on this origin, as the suite
 * follows them. Returns the page items.
 */
export function paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: readonly T[]): T[] {
  const { perPage, page } = pageParams(url);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page < lastPage) {
    const base = baseUrl(req);
    const linkFor = (p: number): string => {
      const next = new URL(url.pathname, base);
      for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
      next.searchParams.set('page', String(p));
      next.searchParams.set('per_page', String(perPage));
      return next.toString();
    };
    res.setHeader('link', `<${linkFor(page + 1)}>; rel="next", <${linkFor(lastPage)}>; rel="last"`);
  }
  return slice;
}

/** GET /api/v3 — the API root, with the scopes header. */
function handleRoot(store: Store, req: IncomingMessage, res: ServerResponse): void {
  const base = baseUrl(req);
  sendJson(
    res,
    200,
    {
      current_user_url: `${base}/api/v3/user`,
      current_user_repositories_url: `${base}/api/v3/user/repos`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      meta_url: `${base}/api/v3/meta`,
    },
    { 'x-oauth-scopes': SCOPES },
  );
}

/** The REST dispatcher. Returns true when the route belonged to this surface. */
export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const seg = path.split('/').filter((part) => part !== '');
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const base = baseUrl(req);
  const rest = seg.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') {
      handleRoot(store, req, res);
      return true;
    }
    return false;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '3.0.0-forge',
      hooks: [],
      git: [],
      api: [],
      web: [],
    });
    return true;
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, userJson(store, base));
    return true;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const page = paginate(req, res, url, all);
      sendJson(res, 200, page.map((repo) => repoJson(store, repo, base)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(await readBody(req));
      if ('malformed' in parsed) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const name = stringField(parsed.value, 'name');
      if (name === null || name === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
        return true;
      }
      const repo = createRepo(store, {
        name,
        description: stringField(parsed.value, 'description') ?? undefined,
        isPrivate: boolField(parsed.value, 'private') ?? undefined,
        defaultBranch: stringField(parsed.value, 'default_branch') ?? undefined,
      });
      if (repo === null) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
        return true;
      }
      sendJson(res, 201, repoJson(store, repo, base));
      return true;
    }
    return false;
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1] ?? '');
    const name = decodeURIComponent(rest[2] ?? '');
    if (rest.length === 3) {
      if (method === 'GET') {
        const repo = findRepo(store, owner, name);
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, repoJson(store, repo, base));
        return true;
      }
      if (method === 'PATCH') {
        const repo = findRepo(store, owner, name);
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const parsed = parseJsonBody(await readBody(req));
        if ('malformed' in parsed) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const description = stringField(parsed.value, 'description');
        if (description !== null) repo.description = description;
        const isPrivate = boolField(parsed.value, 'private');
        if (isPrivate !== null) repo.isPrivate = isPrivate;
        const defaultBranch = stringField(parsed.value, 'default_branch');
        if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
        const newName = stringField(parsed.value, 'name');
        if (newName !== null && newName !== '' && newName !== repo.name && !store.repos.has(newName)) {
          store.repos.delete(repo.name);
          repo.name = newName;
          store.repos.set(repo.name, repo);
        }
        repo.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        sendJson(res, 200, repoJson(store, repo, base));
        return true;
      }
      if (method === 'DELETE') {
        const repo = findRepo(store, owner, name);
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        deleteRepo(store, repo.name);
        dropGitRepo(repo.id);
        sendEmpty(res, 204);
        return true;
      }
      return false;
    }
    // Deeper repository routes: contents, branches, commits, git refs, and in
    // later steps labels, issues and pull requests.
    const repo = findRepo(store, owner, name);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    return handleRepoDeep(store, req, res, url, repo, rest.slice(3));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Repository-deep routes: branches, commits, the git refs API and the contents
// API. Contents writes are real git commits on the branch they name, so the
// REST view and the git view never disagree.

/** A commit as a GitHub commit object. */
export function commitJson(store: Store, g: GitRepo, sha: string, base: string, fullName: string): Record<string, unknown> {
  const info = commitInfo(g, sha);
  const date = info === null ? nowIso() : new Date(info.authorTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const person = {
    name: info?.authorName ?? '',
    email: info?.authorEmail ?? '',
    date,
  };
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      author: person,
      committer: person,
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '', url: `${base}/api/v3/repos/${fullName}/git/trees/${info?.tree ?? ''}` },
      url: `${base}/api/v3/repos/${fullName}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `${base}/api/v3/repos/${fullName}/commits/${sha}`,
    html_url: `${base}/${fullName}/commit/${sha}`,
    comments_url: `${base}/api/v3/repos/${fullName}/commits/${sha}/comments`,
    author: userJson(store, base),
    committer: userJson(store, base),
    parents: (info?.parents ?? []).map((parent) => ({
      sha: parent,
      url: `${base}/api/v3/repos/${fullName}/commits/${parent}`,
      html_url: `${base}/${fullName}/commit/${parent}`,
    })),
  };
}

/** The branch head's commit sha for a repository, or null when unborn. */
function branchHead(g: GitRepo, branch: string): string | null {
  return refSha(g, `refs/heads/${branch}`);
}

/** Resolve a ref-ish (branch name or commit sha) to a commit sha. */
function resolveCommit(g: GitRepo, ref: string): string | null {
  const byBranch = branchHead(g, ref);
  if (byBranch !== null) return byBranch;
  const obj = readObject(g, ref);
  return obj !== null && obj.type === 'commit' ? ref : null;
}

/** Commit one set of file changes onto a branch; returns the new commit sha. */
function commitChanges(
  store: Store,
  repo: RepoRec,
  g: GitRepo,
  branch: string,
  changes: ReadonlyMap<string, string | null>,
  message: string,
): string {
  const head = branchHead(g, branch);
  const headInfo = head === null ? null : commitInfo(g, head);
  const tree = applyChanges(g, headInfo?.tree ?? null, changes);
  const login = viewerLogin(store);
  const sha = writeCommit(g, {
    tree,
    parents: head === null ? [] : [head],
    authorName: login,
    authorEmail: `${login}@example.invalid`,
    message,
  });
  setRef(g, `refs/heads/${branch}`, sha);
  repo.updatedAt = nowIso();
  return sha;
}

/** One entry of a contents listing / a file object, in GitHub's shape. */
function contentEntryJson(
  base: string,
  fullName: string,
  path: string,
  entry: { sha: string; mode: string } | null,
  size: number,
): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  const isDir = entry === null || entry.mode === '40000';
  return {
    type: isDir ? 'dir' : 'file',
    encoding: isDir ? '' : 'base64',
    size: isDir ? 0 : size,
    name,
    path,
    sha: entry?.sha ?? '',
    url: `${base}/api/v3/repos/${fullName}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry?.sha ?? ''}`,
    html_url: `${base}/${fullName}/${isDir ? 'tree' : 'blob'}/main/${path}`,
    download_url: isDir ? null : `${base}/${fullName}/raw/main/${path}`,
    _links: {
      self: `${base}/api/v3/repos/${fullName}/contents/${path}`,
      git: `${base}/api/v3/repos/${fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry?.sha ?? ''}`,
      html: `${base}/${fullName}/${isDir ? 'tree' : 'blob'}/main/${path}`,
    },
  };
}

/** The tree sha a contents request reads from: ?ref= wins, else the default branch. */
function contentsTree(g: GitRepo, repo: RepoRec, url: URL): string | null {
  const ref = url.searchParams.get('ref');
  const commit = ref !== null && ref !== '' ? resolveCommit(g, ref) : branchHead(g, repo.defaultBranch);
  if (commit === null) return null;
  return commitInfo(g, commit)?.tree ?? null;
}

/** GET /contents/{path}: a file object, or a directory's entries. */
function handleContentsGet(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  path: string,
): void {
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const g = gitRepo(repo.id);
  const tree = contentsTree(g, repo, url);
  if (tree === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const flat = flattenTree(g, tree);
  if (path === '') {
    // Root listing: the top-level entries of the tree.
    const entries: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const [filePath, entry] of flat) {
      const first = filePath.split('/')[0] as string;
      if (seen.has(first)) continue;
      seen.add(first);
      const isDir = filePath.includes('/');
      const sub = isDir ? null : entry;
      entries.push(contentEntryJson(base, fullName, first, isDir ? { sha: '', mode: '40000' } : sub, isDir ? 0 : (readObject(g, entry.sha)?.data.length ?? 0)));
    }
    entries.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
    sendJson(res, 200, entries);
    return;
  }
  const direct = flat.get(path);
  if (direct !== undefined) {
    const blob = readObject(g, direct.sha);
    const data = blob?.data ?? Buffer.alloc(0);
    const json = contentEntryJson(base, fullName, path, direct, data.length);
    json.content = data.toString('base64');
    sendJson(res, 200, json);
    return;
  }
  // A directory: list its immediate children.
  const prefix = `${path}/`;
  const children = new Map<string, { sha: string; mode: string; size: number }>();
  for (const [filePath, entry] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const restPath = filePath.slice(prefix.length);
    const first = restPath.split('/')[0] as string;
    if (children.has(first)) continue;
    const isDir = restPath.includes('/');
    children.set(first, isDir ? { sha: '', mode: '40000', size: 0 } : { sha: entry.sha, mode: entry.mode, size: readObject(g, entry.sha)?.data.length ?? 0 });
  }
  if (children.size === 0) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const entries = [...children.entries()]
    .map(([name, entry]) => contentEntryJson(base, fullName, `${path}/${name}`, entry.mode === '40000' ? { sha: '', mode: '40000' } : entry, entry.size))
    .sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
  sendJson(res, 200, entries);
}

/** PUT /contents/{path}: create or update a file with a commit. */
async function handleContentsPut(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec,
  path: string,
): Promise<void> {
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const parsed = parseJsonBody(await readBody(req));
  if ('malformed' in parsed) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const message = stringField(parsed.value, 'message') ?? 'Update file';
  const contentB64 = stringField(parsed.value, 'content');
  if (contentB64 === null) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'content', code: 'missing_field' }] });
    return;
  }
  const branch = stringField(parsed.value, 'branch') ?? repo.defaultBranch;
  const g = gitRepo(repo.id);
  const head = branchHead(g, branch);
  const headTree = head === null ? null : (commitInfo(g, head)?.tree ?? null);
  const existing = headTree === null ? undefined : flattenTree(g, headTree).get(path);
  const givenSha = stringField(parsed.value, 'sha');
  if (existing !== undefined) {
    if (givenSha !== existing.sha) {
      sendError(res, 409, `${path} does not match ${givenSha ?? ''}`);
      return;
    }
  }
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const blobSha = writeObject(g, 'blob', data);
  const commitSha = commitChanges(store, repo, g, branch, new Map([[path, blobSha]]), message);
  const json = contentEntryJson(base, fullName, path, { sha: blobSha, mode: '100644' }, data.length);
  sendJson(res, existing !== undefined ? 200 : 201, {
    content: json,
    commit: commitJson(store, g, commitSha, base, fullName),
  });
}

/** DELETE /contents/{path}: remove a file with a commit. */
async function handleContentsDelete(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec,
  path: string,
): Promise<void> {
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const parsed = parseJsonBody(await readBody(req));
  if ('malformed' in parsed) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const message = stringField(parsed.value, 'message') ?? 'Delete file';
  const branch = stringField(parsed.value, 'branch') ?? repo.defaultBranch;
  const g = gitRepo(repo.id);
  const head = branchHead(g, branch);
  const headTree = head === null ? null : (commitInfo(g, head)?.tree ?? null);
  const existing = headTree === null ? undefined : flattenTree(g, headTree).get(path);
  if (existing === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const givenSha = stringField(parsed.value, 'sha');
  if (givenSha !== null && givenSha !== existing.sha) {
    sendError(res, 409, `${path} does not match ${givenSha}`);
    return;
  }
  const commitSha = commitChanges(store, repo, g, branch, new Map([[path, null]]), message);
  sendJson(res, 200, { content: null, commit: commitJson(store, g, commitSha, base, fullName) });
}

/** A git ref as the refs API reports it. */
function refJson(base: string, fullName: string, ref: string, sha: string): Record<string, unknown> {
  return {
    ref,
    node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
    url: `${base}/api/v3/repos/${fullName}/git/${ref}`,
    object: { sha, type: 'commit', url: `${base}/api/v3/repos/${fullName}/git/commits/${sha}` },
  };
}

/** Routes under /repos/{owner}/{repo}/… — repo already resolved and owned. */
async function handleRepoDeep(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const base = baseUrl(req);
  const fullName = `${viewerLogin(store)}/${repo.name}`;
  const g = gitRepo(repo.id);
  const head = parts[0] ?? '';

  if (head === 'branches') {
    if (parts.length === 1 && method === 'GET') {
      const branches = [...g.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: {
            sha: g.refs.get(`refs/heads/${name}`) ?? '',
            url: `${base}/api/v3/repos/${fullName}/commits/${g.refs.get(`refs/heads/${name}`) ?? ''}`,
          },
          protected: false,
        }));
      sendJson(res, 200, paginate(req, res, url, branches));
      return true;
    }
    if (parts.length === 2 && method === 'GET') {
      const name = decodeURIComponent(parts[1] ?? '');
      const sha = branchHead(g, name);
      if (sha === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, {
        name,
        commit: commitJson(store, g, sha, base, fullName),
        protected: false,
        _links: { self: `${base}/api/v3/repos/${fullName}/branches/${name}`, html: `${base}/${fullName}/tree/${name}` },
      });
      return true;
    }
    return false;
  }

  if (head === 'commits') {
    if (parts.length === 1 && method === 'GET') {
      const refParam = url.searchParams.get('sha') ?? url.searchParams.get('branch');
      const start = refParam !== null && refParam !== '' ? resolveCommit(g, refParam) : branchHead(g, repo.defaultBranch);
      if (start === null) {
        sendJson(res, 200, []);
        return true;
      }
      let shas = walkCommits(g, start);
      const pathFilter = url.searchParams.get('path');
      if (pathFilter !== null && pathFilter !== '') {
        shas = shas.filter((sha) => {
          const tree = commitInfo(g, sha)?.tree;
          return tree !== undefined && flattenTree(g, tree).has(pathFilter);
        });
      }
      const page = paginate(req, res, url, shas);
      sendJson(res, 200, page.map((sha) => commitJson(store, g, sha, base, fullName)));
      return true;
    }
    if (parts.length === 2 && method === 'GET') {
      const sha = parts[1] ?? '';
      if (commitInfo(g, sha) === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, commitJson(store, g, sha, base, fullName));
      return true;
    }
    return false;
  }

  if (head === 'git') {
    // POST /git/refs creates a ref; GET /git/refs lists them; GET /git/ref/{ref}
    // reads one (the ref name itself contains slashes).
    if (parts[1] === 'refs' && parts.length === 2) {
      if (method === 'GET') {
        const all = [...g.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => refJson(base, fullName, ref, sha));
        sendJson(res, 200, paginate(req, res, url, all));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(await readBody(req));
        if ('malformed' in parsed) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const ref = stringField(parsed.value, 'ref');
        const sha = stringField(parsed.value, 'sha');
        if (ref === null || sha === null || commitInfo(g, sha) === null) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Ref', field: 'sha', code: 'invalid' }] });
          return true;
        }
        setRef(g, ref, sha);
        sendJson(res, 201, refJson(base, fullName, ref, sha));
        return true;
      }
      return false;
    }
    if (parts[1] === 'ref' && parts.length >= 3 && method === 'GET') {
      const ref = parts.slice(2).map((part) => decodeURIComponent(part)).join('/');
      const sha = refSha(g, ref);
      if (sha === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, refJson(base, fullName, ref, sha));
      return true;
    }
    if (parts[1] === 'refs' && parts.length >= 3 && method === 'DELETE') {
      const ref = parts.slice(2).map((part) => decodeURIComponent(part)).join('/');
      if (!deleteRef(g, ref)) {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      sendEmpty(res, 204);
      return true;
    }
    return false;
  }

  if (head === 'contents') {
    const path = parts.slice(1).map((part) => decodeURIComponent(part)).join('/');
    if (method === 'GET') {
      handleContentsGet(store, req, res, url, repo, path);
      return true;
    }
    if (method === 'PUT') {
      await handleContentsPut(store, req, res, repo, path);
      return true;
    }
    if (method === 'DELETE') {
      await handleContentsDelete(store, req, res, repo, path);
      return true;
    }
    return false;
  }

  return false;
}
