<!-- Authored by: cc (Claude Code) | 2026-03-13 -->

# Claude Code Token Efficiency Playbook

Supplements AGENTS.md. All rules here are directives, not suggestions.

---

## 1. Permanent Context

CLAUDE.md (symlinked to AGENTS.md) loads every session. Keep it to: stack identity, build commands, module boundaries, commit conventions, hard constraints. No ephemeral task context, no code samples over 10 lines (put those in `prompts/`).

## 2. Repo Map

Read `docs/repo-map.json` before searching `src/` or `extensions/`. It maps files to purpose, exports, and dependencies. Use it to identify targets, then read only those files.

Update the map when adding major modules: purpose (one line), exports, dependencies.

## 3. Issue Workflow

```bash
git checkout -b feature/{NUMBER}-{SLUG}
# Implement one file at a time, verify between files
pnpm build && pnpm check && pnpm test
scripts/committer "{scope}: {description} (#{NUMBER})" {files...}
gh pr create --title "{scope}: {description}" --body "Closes #{NUMBER}"
```

## 4. Diff-Only Output

Return unified diffs for edits to files over 50 lines. Full content only for new files or files under 50 lines.

## 5. Context Guardrails

**Hard limits:**

- Max 5 file reads per turn
- Max 200 lines per response
- If task touches 10+ files, decompose first

**Soft limits:**

- Read `docs/repo-map.json` before scanning `src/`
- Use `rg` to locate symbols instead of reading whole files
- Ask for clarification rather than guessing module boundaries

**Context exhaustion recovery:** Start new session with handoff: task, completed files, remaining steps, key decisions.

## 6. Prompt Templates

Templates in `prompts/`: `implement-issue.txt`, `debug-issue.txt`, `write-test.txt`, `refactor.txt`, `review-diff.txt`.

Variables use `{VARIABLE_NAME}`. Each template sets context, references `docs/repo-map.json`, and specifies output format.

```bash
TEMPLATE=$(cat prompts/implement-issue.txt)
PROMPT="${TEMPLATE//\{ISSUE_URL\}/$ISSUE_URL}"
echo "$PROMPT" | claude --model claude-sonnet-4-5
```

## 7. Chunked Refactoring

Break refactors into chunks of 3-5 files, each independently buildable:

1. Define new interfaces/types -> verify: `pnpm tsgo`
2. Update core implementation -> verify: `pnpm build`
3. Migrate callers -> verify: `pnpm build`
4. Update tests -> verify: `pnpm test`

## 8. Log Pre-Summarization

Filter raw output before sending to the model:

```bash
pnpm test 2>&1 | grep -A 5 "FAIL\|Error" > /tmp/failures.log
claude --model claude-haiku-4-5 "Summarize: file, test, expected vs actual" < /tmp/failures.log > /tmp/summary.txt
claude --model claude-sonnet-4-5 "Fix these. Diff-only." < /tmp/summary.txt
```

Pre-summarize when: test output > 100 lines, build errors > 50 lines, lint > 30 warnings.

## 9. Model Tiering

| Task                             | Model  | Flag                        |
| -------------------------------- | ------ | --------------------------- |
| Classify, triage, summarize logs | Haiku  | `--model claude-haiku-4-5`  |
| Code gen, review, tests          | Sonnet | `--model claude-sonnet-4-5` |
| Architecture, complex refactors  | Opus   | `--model claude-opus-4-5`   |

## 10. Local Search-First

Use local tools before spending model tokens:

```bash
rg "export (async )?function handleCall" --type ts   # definition
rg "from ['\"].*gateway/auth" --type ts               # importers
rg -l "describe.*auth" --glob "*.test.ts"             # test files
pnpm tsgo 2>&1 | head -20                             # type errors
```

## 11. Context Compression

- Strip comments: `grep -v "^\s*//" src/file.ts`
- Narrow diffs: `git diff --unified=1 src/file.ts`
- Signatures only: `rg "^export (async )?(function|const|class) " src/file.ts`
- Session handoff: task + completed files + remaining steps + key decisions

## 12. Autonomous Agent Loop

See `scripts/run-issue.sh`. Structure: fetch issue -> decompose (Haiku) -> implement per-step (Sonnet) -> `pnpm build` between steps -> `pnpm test` at end -> `gh pr create`.

Safety: max 3 retries/step, no force-push, `pnpm check` before PR.

## 13. Token Budget

| Asset                        | Tokens |
| ---------------------------- | ------ |
| CLAUDE.md / AGENTS.md        | ~3,000 |
| docs/repo-map.json           | ~1,500 |
| docs/architecture_summary.md | ~600   |
| TypeScript file (300 LOC)    | ~2,000 |
| Test file (200 LOC)          | ~1,200 |
| Prompt template              | ~300   |
| Git diff (typical PR)        | ~1,000 |

Per-turn budget: ~22k tokens (system + repo map + 5 source files + response). Red flags: 10+ file reads, 300+ line responses, repeated reads of the same file.

## 14. Template Index

| Template  | File                          | Use                |
| --------- | ----------------------------- | ------------------ |
| Implement | `prompts/implement-issue.txt` | Issue to code      |
| Debug     | `prompts/debug-issue.txt`     | Error diagnosis    |
| Test      | `prompts/write-test.txt`      | Vitest generation  |
| Refactor  | `prompts/refactor.txt`        | Scoped refactoring |
| Review    | `prompts/review-diff.txt`     | Diff review        |
