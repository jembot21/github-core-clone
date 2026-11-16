# GitHub Core Clone — a one-process git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jembot21/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jembot21/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible forge in a single Node 22 process, standard library only — no dependencies, no git binary. Built for make.fun's [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty. `main.ts` (the kit's lifecycle file) registers the port; `app.ts` serves everything below from one in-memory store.

## The four surfaces, one store

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 capability advertisement, `ls-refs` (ref-prefix, peel, symrefs, unborn), `fetch` with shallow/deepen and sideband framing, and v0 `receive-pack` with report-status, fast-forward-only ref updates and per-ref `ok`/`ng` reporting. Packs are read and written in-process (OFS/REF deltas resolved, trailers verified); the same object store backs every surface, so a commit pushed over git is the commit the contents API reads, byte for byte.
- **REST v3** under `/api/v3` — repositories, branches, commits, the git refs API, contents (writes are real commits, with GitHub's 201/200/409 sha semantics), labels, issues and comments, and pull requests with file diffs and squash/merge/fast-forward merges (405 on conflict). Every reply is JSON with an `X-GitHub-Request-Id`; a repository under a stranger's login is a 404, never a 403.
- **GraphQL v4** at `/api/graphql` — a small parser/executor for the documents `gh` and `github-mcp-server` send: viewer, repository reads, issue/pull-request connections with cursor pagination, `node(id:)`, the five mutations (create/close issue, create/merge pull request, add comment), batched operations, and the `__type` introspection probes (Issue, PullRequest, Repository, SearchType) that client feature detection relies on.
- **MCP** at `/mcp` — a stateless streamable-HTTP JSON-RPC endpoint (legacy `initialize` era) exposing github-mcp-server's core tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`, `add_issue_comment`, `create_pull_request`, `merge_pull_request` — acting on the same store.

## Design notes

- **One user, adopted login.** The bearer token is opaque and names no login, so the forge adopts the first owner segment that addresses one of its repositories as the canonical login; every other owner is a 404.
- **Issues and pull requests share one number sequence** per repository, as on GitHub, and one record type — a pull request is an issue with head/base refs and merge state.
- **Merges are file-level three-way merges** against the merge-base tree: a path changed on one side takes that side, changed both ways conflicts. Squash, merge-commit and fast-forward all land through the same path the REST, GraphQL and MCP merge calls share in spirit.
- **Determinism where it counts.** Object ids are plain SHA-1 over git's object format; nothing on the wire depends on wall-clock luck beyond commit timestamps.

## Layout

- `main.ts` — the kit lifecycle (register port, wait for done). Unchanged from the starter.
- `app.ts` — the HTTP server: auth gate, routing, health check.
- `lib/store.ts` — the in-memory store (repositories, labels, issues, pull requests).
- `lib/gitstore.ts` — the git object store: hashing, trees, commits, refs, ancestry, three-way merge.
- `lib/pack.ts` — pkt-line framing and packfile read/write with delta resolution.
- `lib/githttp.ts` — smart HTTP: advertisements, ls-refs, fetch (shallow/deepen), receive-pack.
- `lib/rest.ts` — the REST v3 surface.
- `lib/graphql.ts` — the GraphQL parser, executor and resolvers.
- `lib/mcp.ts` — the MCP JSON-RPC endpoint and its tools.
- `lib/http.ts` — small HTTP helpers shared by the surfaces.
