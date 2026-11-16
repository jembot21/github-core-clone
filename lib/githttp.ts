// Git smart HTTP: ref advertisement (protocol v0 and v2), upload-pack
// (ls-refs and fetch, with shallow/deepen) and receive-pack (v0, report-status
// in sideband). One store underlies it all — the same objects the REST contents
// API writes are the objects a clone receives, byte for byte.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { findRepo, viewerLogin, type RepoRec, type Store } from './store.ts';
import {
  commitInfo,
  gitRepo,
  isAncestor,
  parseTree,
  readObject,
  refSha,
  setRef,
  deleteRef,
  type GitRepo,
  type GitObject,
} from './gitstore.ts';
import { buildPack, parsePktLines, pktDelim, pktFlush, pktLine, readPack, splitPktLines, type PktItem } from './pack.ts';
import { readBody } from './http.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'SANTO-forge/1.0';

/** Every ref the store holds, sorted by name: [name, sha] pairs. */
function allRefs(g: GitRepo): [string, string][] {
  return [...g.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Follow tag objects from a sha to the commit they name, or null. */
function peelToCommit(g: GitRepo, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = readObject(g, current);
    if (obj === null) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

/** The commit a ref ultimately names (through annotated tags), or null. */
function refCommit(g: GitRepo, sha: string): string | null {
  return peelToCommit(g, sha);
}

// ---------------------------------------------------------------------------
// Advertisements.

/** The v0 ref advertisement body for a service. */
function advertiseV0(g: GitRepo, repo: RepoRec, service: string): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status delete-refs side-band-64k quiet ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = allRefs(g);
  const headSha = refSha(g, `refs/heads/${repo.defaultBranch}`) ?? ZERO;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO} capabilities^{}\0${caps}`));
    return Buffer.concat([...lines, pktFlush()]);
  }
  lines.push(pktLine(`${headSha} HEAD\0${caps}`));
  for (const [name, sha] of refs) {
    lines.push(pktLine(`${sha} ${name}\n`));
    const obj = readObject(g, sha);
    if (obj !== null && obj.type === 'tag') {
      const peeled = peelToCommit(g, sha);
      if (peeled !== null) lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

/** The v2 capability advertisement (upload-pack only in protocol v2). */
function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------
// Object selection: what a fetch sends, given wants, haves, the client's
// shallow boundary and an optional depth.

/** Every object reachable from a set of root shas (commits walk to parents). */
function closure(g: GitRepo, roots: Iterable<string>, into: Set<string>): void {
  const stack = [...roots];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const obj = readObject(g, sha);
    if (obj === null) continue;
    into.add(sha);
    if (obj.type === 'commit') {
      const info = commitInfo(g, sha);
      if (info !== null) {
        stack.push(info.tree, ...info.parents);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as string);
    }
  }
}

/** The tree closure of one commit (the commit itself not included). */
function treeClosure(g: GitRepo, commitSha: string, into: Set<string>): void {
  const info = commitInfo(g, commitSha);
  if (info !== null) closure(g, [info.tree], into);
}

/**
 * The closure of the client's haves, bounded by its shallow lines: a commit
 * the client lists as shallow is held together with its trees, but its
 * ancestry is NOT — the shallow line is exactly the client saying so. A plain
 * closure here would wrongly treat the whole history as already delivered.
 */
function haveClosure(g: GitRepo, haves: string[], shallowSet: ReadonlySet<string>): Set<string> {
  const into = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const obj = readObject(g, sha);
    if (obj === null) continue;
    into.add(sha);
    if (obj.type === 'commit') {
      const info = commitInfo(g, sha);
      if (info !== null) {
        stack.push(info.tree);
        if (!shallowSet.has(sha)) stack.push(...info.parents);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) stack.push(match[1] as string);
    }
  }
  return into;
}

interface Selection {
  objects: Map<string, GitObject>;
  boundary: string[];
  unshallow: string[];
}

function selectObjects(
  g: GitRepo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): Selection {
  // What the client already holds in full: everything reachable from its
  // haves, without crossing its shallow boundary.
  const shallowSet = new Set(clientShallow);
  const haveSet = haveClosure(g, haves, shallowSet);
  const haveCommits = new Set<string>();
  for (const sha of haveSet) {
    const obj = readObject(g, sha);
    if (obj !== null && obj.type === 'commit') haveCommits.add(sha);
  }
  // Shallow-held commits: the client holds the commit and its trees, not its
  // ancestry. Their objects are not sent again; their parents are not implied.
  const shallowHeld = new Set<string>();
  for (const sha of clientShallow) {
    if (readObject(g, sha)?.type === 'commit') {
      shallowHeld.add(sha);
      treeClosure(g, sha, shallowHeld);
    }
  }
  const heldCommits = new Set([...haveCommits, ...clientShallow.filter((s) => readObject(g, s)?.type === 'commit')]);

  // Commits to include, by generation from the wants (depth counts commits).
  // Traversal stops at commits the client holds WITH their history (a have
  // that is not shallow): everything behind those is held too. A shallow-held
  // commit is traversed through — it anchors the generations — and counts as
  // included for the boundary math, but its objects are never re-sent.
  const fullHeld = new Set([...haveCommits].filter((sha) => !shallowSet.has(sha)));
  const included = new Set<string>();
  const nonCommitWants: string[] = [];
  let frontier: string[] = [];
  for (const want of wants) {
    const obj = readObject(g, want);
    if (obj === null) continue;
    if (obj.type === 'commit') frontier.push(want);
    else nonCommitWants.push(want);
  }
  let generation = 0;
  const visited = new Set<string>();
  while (frontier.length > 0) {
    if (depth !== null && generation >= depth) break;
    const next: string[] = [];
    for (const sha of frontier) {
      if (visited.has(sha)) continue;
      visited.add(sha);
      if (fullHeld.has(sha)) continue;
      included.add(sha);
      const info = commitInfo(g, sha);
      if (info !== null) next.push(...info.parents);
    }
    frontier = next;
    generation += 1;
  }

  // The boundary: included commits with a parent the client does not hold and
  // we are not sending.
  const boundary: string[] = [];
  for (const sha of included) {
    const info = commitInfo(g, sha);
    if (info === null) continue;
    const cut = info.parents.some((parent) => !included.has(parent) && !heldCommits.has(parent) && readObject(g, parent) !== null);
    if (cut) boundary.push(sha);
  }
  const boundarySet = new Set(boundary);
  const unshallow = clientShallow.filter((sha) => included.has(sha) && !boundarySet.has(sha));

  // Assemble the object set: included commits and their trees, minus anything
  // the client holds; plus non-commit wants (tags) with their closure.
  const objects = new Map<string, GitObject>();
  const addObject = (sha: string): void => {
    if (haveSet.has(sha) || shallowHeld.has(sha) || objects.has(sha)) return;
    const obj = readObject(g, sha);
    if (obj !== null) objects.set(sha, obj);
  };
  for (const sha of included) {
    addObject(sha);
    const trees = new Set<string>();
    treeClosure(g, sha, trees);
    for (const treeObj of trees) addObject(treeObj);
  }
  for (const want of nonCommitWants) {
    const all = new Set<string>();
    closure(g, [want], all);
    for (const sha of all) addObject(sha);
  }
  return { objects, boundary, unshallow };
}

/** Frame pack bytes as sideband band-1 packets, with an optional progress line. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line payload is at most 65516 bytes, and one of them is the band byte.
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, at + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** Build the pack bytes for a selection (possibly zero objects). */
function packOf(selection: Selection): Buffer {
  return buildPack([...selection.objects.entries()].map(([sha, obj]) => ({ sha, type: obj.type, data: obj.data })));
}

// ---------------------------------------------------------------------------
// upload-pack.

/** Answer a v2 ls-refs command. */
function lsRefs(g: GitRepo, repo: RepoRec, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = refSha(g, headRef);
  if (matches('HEAD')) {
    if (headSha !== null) {
      lines.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, sha] of allRefs(g)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const obj = readObject(g, sha);
      if (obj !== null && obj.type === 'tag') {
        const peeled = peelToCommit(g, sha);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

/** Parse fetch arguments (the lines after the capability delimiter). */
interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.deepen = Number(arg.slice(7).trim());
    else if (arg === 'done') out.done = true;
  }
  return out;
}

/** Answer a v2 fetch command. */
function fetchV2(g: GitRepo, args: string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const selection = selectObjects(g, parsed.wants, parsed.haves, parsed.shallow, parsed.deepen);
  const parts: Buffer[] = [];
  if (parsed.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const ack = [...parsed.haves].reverse().find((have) => readObject(g, have)?.type === 'commit');
    parts.push(pktLine(ack !== undefined ? `ACK ${ack}\n` : 'NAK\n'));
    parts.push(pktDelim());
  }
  if (parsed.deepen !== null || parsed.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of selection.boundary) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of selection.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(packOf(selection)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer a v0 upload-pack POST. */
function fetchV0(g: GitRepo, body: Buffer): Buffer {
  const { items } = splitPktLines(body);
  const lines = items.filter((i): i is Extract<PktItem, { kind: 'data' }> => i.kind === 'data').map((i) => i.payload.toString('utf8'));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let sideband = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const nul = rest.indexOf('\0');
      wants.push((nul === -1 ? rest : rest.slice(0, nul)).trim());
      if (nul !== -1 && rest.slice(nul + 1).includes('side-band-64k')) sideband = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
  }
  const selection = selectObjects(g, wants, haves, shallow, deepen);
  const parts: Buffer[] = [];
  for (const sha of selection.boundary) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of selection.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = packOf(selection);
  if (sideband) parts.push(sidebandPack(pack), pktFlush());
  else parts.push(pack);
  return Buffer.concat(parts);
}

/** Dispatch a POST to git-upload-pack: v2 command or v0 negotiation. */
function uploadPack(g: GitRepo, repo: RepoRec, req: IncomingMessage, body: Buffer): Buffer {
  const protocol = req.headers['git-protocol'] ?? '';
  if (!protocol.includes('version=2')) return fetchV0(g, body);
  const items = parsePktLines(body);
  const texts = items.filter((i): i is Extract<PktItem, { kind: 'data' }> => i.kind === 'data').map((i) => i.payload.toString('utf8').replace(/\n$/, ''));
  const command = texts[0] ?? '';
  // Arguments are the lines after the capability delimiter; in the parsed item
  // stream the delimiter is its own item, so rebuild from raw items.
  const args: string[] = [];
  let pastDelim = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (item.kind !== 'data') continue;
    if (pastDelim) args.push(item.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (command === 'command=ls-refs') return lsRefs(g, repo, args);
  if (command === 'command=fetch') return fetchV2(g, args);
  return pktFlush();
}

// ---------------------------------------------------------------------------
// receive-pack.

interface RefCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Answer a receive-pack POST: import the pack, judge each ref update, report. */
function receivePack(g: GitRepo, body: Buffer): Buffer {
  const { items, rest } = splitPktLines(body);
  const commands: RefCommand[] = [];
  let caps = '';
  for (const item of items) {
    if (item.kind !== 'data') continue;
    let text = item.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length === 3) commands.push({ oldSha: parts[0] as string, newSha: parts[1] as string, ref: parts[2] as string });
  }

  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (sha) => readObject(g, sha));
      for (const [sha, obj] of objects) {
        if (!g.objects.has(sha)) g.objects.set(sha, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = refSha(g, command.ref);
    if (command.newSha === ZERO) {
      // A deletion.
      if (current === null) results.push({ ref: command.ref, ok: false, reason: 'reference not found' });
      else {
        deleteRef(g, command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    const target = readObject(g, command.newSha);
    if (target === null || (target.type !== 'commit' && target.type !== 'tag')) {
      results.push({ ref: command.ref, ok: false, reason: 'bad object' });
      continue;
    }
    if (command.oldSha === ZERO) {
      if (current !== null) {
        results.push({ ref: command.ref, ok: false, reason: 'reference already exists' });
        continue;
      }
      setRef(g, command.ref, command.newSha);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (current !== command.oldSha) {
      results.push({ ref: command.ref, ok: false, reason: 'stale ref' });
      continue;
    }
    if (target.type === 'commit' && !isAncestor(g, command.oldSha, command.newSha)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    setRef(g, command.ref, command.newSha);
    results.push({ ref: command.ref, ok: true });
  }

  const report: Buffer[] = [];
  report.push(pktLine(unpackError === null ? 'unpack ok\n' : `unpack error: ${unpackError}\n`));
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  report.push(pktFlush());
  const reportBytes = Buffer.concat(report);
  if (caps.includes('side-band-64k')) {
    return Buffer.concat([sidebandPack(reportBytes), pktFlush()]);
  }
  return reportBytes;
}

// ---------------------------------------------------------------------------
// Routing.

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** The git smart-HTTP dispatcher. Returns true when the route was git's. */
export async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = GIT_PATH.exec(url.pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const service = match[3] as string;
  const repo = findRepo(store, owner, name);
  if (repo === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return true;
  }
  const g = gitRepo(repo.id);
  const method = req.method ?? 'GET';

  if (service === 'info/refs' && method === 'GET') {
    const wanted = url.searchParams.get('service');
    if (wanted !== 'git-upload-pack' && wanted !== 'git-receive-pack') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('service required\n');
      return true;
    }
    const protocol = req.headers['git-protocol'] ?? '';
    const body =
      wanted === 'git-upload-pack' && protocol.includes('version=2') ? advertiseV2() : advertiseV0(g, repo, wanted);
    res.writeHead(200, {
      'content-type': `application/x-${wanted}-advertisement`,
      'cache-control': 'no-cache, max-age=0, must-revalidate',
    });
    res.end(body);
    return true;
  }

  if (service === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(uploadPack(g, repo, req, body));
    return true;
  }

  if (service === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
    res.end(receivePack(g, body));
    return true;
  }

  return false;
}
