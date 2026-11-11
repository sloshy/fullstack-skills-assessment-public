# Decision log

Architectural and process decisions made while working on this assessment, in
chronological order. Each entry: context, decision, and why.

---

## 001 · 2026-11-11 · Scala backend track

**Context:** Part B asks for either the .NET or the Scala track.
**Decision:** Scala track. `surcharge-service/` is worked on locally;
`payments-api/` runs only in Docker. Fixes that belong in the C# service are
described in `NOTES.md` (file, change, reason) rather than made.
**Why:** Scala is the candidate's strongest language, followed by TypeScript.

## 002 · 2026-11-11 · Stay on Scala 2.13 / Play 3

**Context:** The service is on Scala 2.13.18, sbt 1.11.2, Play 3.0.10
(pinned via the Play sbt-plugin). Scala 3 has been the current major version
for some time.
**Decision:** No migration. All work stays on the existing 2.13 toolchain, and
tooling is chosen to support 2.13.
**Why:** A migration is out of scope for the assessment, would make the diff
much larger and harder to review, and has nothing to do with the tickets.
Worth listing as a follow-up instead.

## 003 · 2026-11-11 · Node 22 per `.nvmrc`

**Context:** The machine's default Node is v25; `bff/.nvmrc` and `web/.nvmrc`
pin 22, which matches the Docker images.
**Decision:** Use Node 22 (`nvm use` inside `bff/` and `web/`) for installs,
builds and tests.
**Why:** Matching the pinned and containerised runtime avoids "works on my
machine" differences.

## 004 · 2026-11-11 · Code intelligence: TypeScript LSP + Metals MCP (no Scala LSP plugin)

**Context:** Claude Code has an official TypeScript LSP plugin but no Scala
one. A Metals LSP plugin would by default be rooted at the repo root, while
the sbt build lives in `surcharge-service/`, so Metals would not find the
build.
**Decision:** TypeScript uses the `typescript-lsp` plugin. Scala uses the
standalone `metals-mcp` server (Metals 1.6.9, installed with
`cs install metals-mcp`), registered in Claude Code at local scope over stdio
with `--workspace surcharge-service`. Nothing about it is committed.
**Why:** `metals-mcp` gives compile diagnostics, symbol search, inspect,
usages and test running against an explicitly chosen workspace, and has been
checked against this 2.13 build on 2026-11-11 with a stdio session calling
`import-build`, `glob-search` and `compile-full`, all of which succeeded.
Losing automatic post-edit diagnostics is covered by running `sbt compile` /
`sbt test`.

## 005 · 2026-11-11 · Working agreement for the assessment

- **Commit messages, PR descriptions and similar:** Claude drafts them; the
  candidate reviews and approves before anything is committed or published.
- **Each task:** implemented by subagents. Every change (code or docs) gets an
  adversarial review from a separate subagent before it is committed or
  signed off.
- **Parallel work:** done and tested in its own git worktree, then merged
  back into `main`.
- **Decisions:** recorded here, in order.
- **Remotes:** Bitbucket `origin` is treated as read-only upstream; work is
  pushed to a private GitHub repository.
