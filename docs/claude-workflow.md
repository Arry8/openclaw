<!-- Authored by: cc (Claude Code) | 2026-03-13 -->

# Claude Code Token Efficiency Playbook

> Supplementary to AGENTS.md. AGENTS.md stays authoritative for upstream conventions;
> this playbook adds efficiency patterns for Claude Code workflows.

---

## 1. Permanent Context (CLAUDE.md)

Keep a root `CLAUDE.md` (or symlink to `AGENTS.md`) that Claude Code loads on every session. This is your highest-leverage token investment — it amortizes across every prompt.

**What belongs in CLAUDE.md:**

- Stack identity: TypeScript (ESM), Node 22+, pnpm, Bun for TS execution
- Build commands: `pnpm build`, `pnpm check`, `pnpm test`
- Module boundaries: `src/` (core), `extensions/` (plugins), `skills/` (tools)
- Commit conventions: `scripts/committer "<msg>" <files...>`
- Hard constraints: no `any`, no `@ts-nocheck`, Oxlint clean

**What does not belong:**

- Ephemeral task context (put in prompt instead)
- Full API docs (link to them)
- Code samples longer than 10 lines (put in `prompts/`)

**Template:**

```markdown
# Project: OpenClaw

- Language: TypeScript (ESM), strict mode
- Runtime: Node 22+, Bun for scripts
- Package manager: pnpm 10.x
- Build: `pnpm build` (tsdown -> dist/)
- Lint: `pnpm check` (Oxlint + Oxfmt)
- Test: `pnpm test` (Vitest, V8 coverage >= 70%)
- Source: src/, Extensions: extensions/, Skills: skills/
- Commits: `scripts/committer "<msg>" <files...>`
```

---

## 2. Repo Map Architecture

Maintain a curated `docs/repo-map.json` so Claude can locate files without scanning the directory tree (which burns tokens on irrelevant paths).

**Schema:**

```json
{
  "version": "1.0",
  "generated": "2026-03-13",
  "files": {
    "src/gateway/boot.ts": {
      "purpose": "Gateway startup, port binding, channel probe",
      "exports": ["bootGateway"],
      "dependencies": ["src/config/", "src/infra/ports.ts"]
    }
  },
  "entry_points": ["openclaw.mjs", "src/entry.ts", "src/index.ts"],
  "test_conventions": "Vitest, colocated *.test.ts, V8 coverage 70%"
}
```

**Regeneration:**

```bash
# Manual curation is preferred over auto-generation.
# When adding a major module, update docs/repo-map.json with:
# - purpose (one line)
# - exports (public API surface)
# - dependencies (imports from other modules)
```

**Usage in prompts:** Reference `docs/repo-map.json` in task runner templates so Claude reads the map before searching the file system.

---

## 3. Issue -> Branch -> Patch

Standard workflow for issue-driven development:

```bash
# 1. Create branch from issue
git checkout -b feature/1234-add-voice-support

# 2. Implement per-file with Claude
claude "Implement the voice handler in src/channels/voice.ts per #1234.
Read docs/repo-map.json first. Output diff-only."

# 3. Verify
pnpm build && pnpm check && pnpm test

# 4. Commit with scoped staging
scripts/committer "channels: add voice handler (#1234)" src/channels/voice.ts

# 5. PR
gh pr create --title "channels: add voice handler" --body "Closes #1234"
```

**Per-file implementation:** Give Claude one file at a time. Include the target file path, the interface it must satisfy, and any types it imports. This keeps each prompt small and each diff reviewable.

---

## 4. Diff-Only Response

When modifying existing files, instruct Claude to return only the diff — not the full file. This cuts response tokens by 60-80% on large files.

**Prompt pattern:**

```
Edit src/gateway/auth.ts to add rate limiting per IP.
Return ONLY the unified diff (--- a/ +++ b/ format).
Do not return unchanged lines. Do not wrap in a code fence.
```

**When to use full-file output:**

- New files (no diff baseline)
- Files under 50 lines
- Complete rewrites

**When to use diff-only:**

- Any edit to an existing file over 50 lines
- Multi-file refactors (one diff block per file)

---

## 5. Context Guardrails

Prevent context window overflow by setting explicit limits.

**Hard guardrails (abort if exceeded):**

```
HARD LIMIT: Do not read more than 5 files in a single turn.
HARD LIMIT: Do not generate responses longer than 200 lines.
HARD LIMIT: If the task requires touching more than 10 files, stop and decompose.
```

**Soft guardrails (warn and adjust):**

```
PREFER: Read docs/repo-map.json before scanning src/.
PREFER: Use rg (ripgrep) to locate symbols instead of reading whole files.
PREFER: Ask for clarification rather than guessing module boundaries.
```

**Recovery from blown context:**

```
If context is saturated, start a new session with this handoff:
"Previous session completed steps 1-3 of 5. Remaining: step 4 (update tests),
step 5 (update docs). Changed files: src/gateway/auth.ts, src/gateway/auth.test.ts."
```

---

## 6. Task Runner Templates

Reusable prompt templates for common workflows. Store in `prompts/` and reference in scripts.

**Template: implement-issue**

```
You are working on the OpenClaw repo (TypeScript/ESM).
Read docs/repo-map.json and docs/architecture_summary.md first.

Issue: {ISSUE_URL}
Branch: feature/{ISSUE_NUMBER}-{SLUG}

Steps:
1. Read the issue description
2. Identify affected files using the repo map
3. Implement the change, one file at a time
4. Write or update colocated *.test.ts files
5. Return diff-only output for each file
```

**Template: debug-issue**

```
Error: {ERROR_TEXT}
File: {FILE_PATH}:{LINE_NUMBER}

1. Read the file around the error location
2. Trace the call chain using the repo map
3. Identify the root cause (not symptoms)
4. Return a minimal diff fix
5. If a regression test is feasible, include it
```

See `prompts/` for all templates.

---

## 7. Chunked Refactoring

Large refactors exceed context limits when done in one shot. Break them into sequential chunks, each verifiable independently.

**Example: Extract channel interface**

Chunk 1 — Define the interface:

```
Create src/channels/channel-interface.ts with the ChannelHandler interface.
Export: onMessage, onConnect, onDisconnect, getStatus.
Return diff-only.
```

Verify: `pnpm tsgo` (type-check only, no runtime changes yet)

Chunk 2 — Update registration:

```
Update src/channels/dock.ts to accept ChannelHandler interface
instead of the current inline type. Import from channel-interface.ts.
Return diff-only.
```

Verify: `pnpm build`

Chunk 3 — Migrate first channel:

```
Update src/discord/ to implement ChannelHandler.
Return diff-only for each changed file.
```

Verify: `pnpm test`

Chunk 4 — Migrate remaining channels + update tests:

```
Update src/telegram/, src/slack/, src/signal/ to implement ChannelHandler.
Update affected *.test.ts files.
Return diff-only.
```

Verify: `pnpm build && pnpm test`

**Chunk sizing rule:** Each chunk should touch 3-5 files max and be independently buildable.

---

## 8. Log Pre-Summarization

Raw test/build output wastes tokens. Summarize before sending to the main model.

**Pattern: filter -> summarize -> fix**

```bash
# Step 1: Capture raw output
pnpm test 2>&1 | tee /tmp/test-output.log

# Step 2: Filter to failures only
grep -A 5 "FAIL\|Error\|AssertionError" /tmp/test-output.log > /tmp/failures.log

# Step 3: Summarize with Haiku (fast, cheap)
claude --model claude-haiku-4-5 \
  "Summarize these test failures. For each: file, test name, assertion, expected vs actual." \
  < /tmp/failures.log > /tmp/summary.txt

# Step 4: Fix with Sonnet (accurate, reasoned)
claude --model claude-sonnet-4-5 \
  "Fix these test failures. Read each source file before proposing changes. Diff-only." \
  < /tmp/summary.txt
```

**When to pre-summarize:**

- Test output > 100 lines
- Build errors > 50 lines
- Lint output > 30 warnings

---

## 9. Model Tiering

Use the cheapest model that handles each task reliably.

| Task                            | Model  | CLI Flag                    | Why                                          |
| ------------------------------- | ------ | --------------------------- | -------------------------------------------- |
| Classify/triage                 | Haiku  | `--model claude-haiku-4-5`  | Fast, cheap, 90%+ accuracy on classification |
| Code generation                 | Sonnet | `--model claude-sonnet-4-5` | Best cost/quality for implementation         |
| Architecture, complex refactors | Opus   | `--model claude-opus-4-5`   | Deep reasoning, multi-file coherence         |
| Log summarization               | Haiku  | `--model claude-haiku-4-5`  | Structured extraction, no reasoning needed   |
| Code review                     | Sonnet | `--model claude-sonnet-4-5` | Catches bugs, understands patterns           |
| Test generation                 | Sonnet | `--model claude-sonnet-4-5` | Needs context of module behavior             |

**Tiering in scripts:**

```bash
# Decompose with Haiku
PLAN=$(claude --model claude-haiku-4-5 "Break this issue into implementation steps: $ISSUE_BODY")

# Implement with Sonnet
claude --model claude-sonnet-4-5 "Implement step 1: $STEP1"
```

---

## 10. Local Search-First

Search locally before asking the model. Local tools are free; model tokens are not.

**ripgrep patterns for TypeScript:**

```bash
# Find function definition
rg "export (async )?function handleCall" --type ts

# Find interface/type
rg "export (interface|type) ChannelHandler" --type ts

# Find imports of a module
rg "from ['\"].*gateway/auth" --type ts

# Find test files for a module
rg -l "describe.*auth" --type ts --glob "*.test.ts"

# Find TODO/FIXME
rg "TODO|FIXME|HACK" --type ts -n
```

**Type checking as search:**

```bash
# Faster than asking Claude "does this type-check?"
pnpm tsgo 2>&1 | head -20
```

**Symbol navigation:**

```bash
# Find all exports from a file
rg "^export " src/gateway/auth.ts

# Find all callers of a function
rg "handleCall\(" --type ts -l
```

---

## 11. Context Compression

Techniques to reduce token consumption without losing information.

**Strip comments from source before sending:**

```bash
# Remove single-line TS comments
grep -v "^\s*//" src/gateway/auth.ts | claude "Review this code for security issues"
```

**Compress git diffs:**

```bash
# Only show changed functions, not full context
git diff --unified=1 src/gateway/auth.ts
```

**Session reset with handoff:**
When context is exhausted, start a new session with a compact handoff:

```
Handoff from previous session:
- Task: Implement rate limiting (#1234)
- Completed: src/gateway/auth-rate-limit.ts (new file), src/gateway/auth.ts (updated)
- Remaining: tests for auth-rate-limit, update docs/gateway/
- Key decisions: per-IP sliding window, 60 req/min default, configurable via openclaw.json
```

**Aggressive compression for large files:**

```bash
# Extract only the function signatures (not bodies)
rg "^export (async )?(function|const|class) " src/gateway/boot.ts
```

---

## 12. Autonomous Agent Loop

A script that takes an issue number and drives it to a PR with minimal human intervention.

See `scripts/run-issue.sh` for the full implementation.

**Loop structure:**

```
1. Fetch issue -> extract requirements
2. Decompose into steps (Haiku)
3. For each step:
   a. Implement (Sonnet)
   b. Build check (pnpm build)
   c. If build fails -> fix (Sonnet) -> retry once
4. Run full tests (pnpm test)
5. If tests fail -> summarize failures (Haiku) -> fix (Sonnet) -> retry once
6. Create PR (gh pr create)
```

**Safety valves:**

- Max 3 retries per step before aborting
- Total budget cap: stop after N turns
- Never force-push or modify files outside the issue scope
- Always run `pnpm check` before PR creation

---

## 13. Token Budget Tracking

Estimate token costs before starting work to avoid mid-task context exhaustion.

**Budget table (approximate):**

| Asset                             | Tokens (est.) |
| --------------------------------- | ------------- |
| CLAUDE.md / AGENTS.md             | ~3,000        |
| docs/repo-map.json                | ~1,500        |
| docs/architecture_summary.md      | ~600          |
| Average TypeScript file (300 LOC) | ~2,000        |
| Average test file (200 LOC)       | ~1,200        |
| Prompt template                   | ~300          |
| Git diff (typical PR)             | ~1,000        |

**Context window budget (200k):**

```
System prompt + CLAUDE.md:     ~5,000
Repo map + arch summary:       ~2,100
Task prompt:                    ~500
Source files (5 files):        ~10,000
Response budget:               ~5,000
---
Total per turn:               ~22,600
Remaining for conversation:  ~177,400  (plenty for multi-turn)
```

**Red flags:**

- Reading more than 10 files in one turn (~20k+ tokens consumed)
- Response exceeding 300 lines (likely returning full files instead of diffs)
- Repeating the same file read across turns (should summarize or cache)

---

## 14. Prompt Templates Library

All templates live in `prompts/`. Reference them in scripts or copy into Claude Code sessions.

| Template        | File                          | Use Case                |
| --------------- | ----------------------------- | ----------------------- |
| Implement Issue | `prompts/implement-issue.txt` | Drive an issue to code  |
| Debug Issue     | `prompts/debug-issue.txt`     | Diagnose and fix errors |
| Write Test      | `prompts/write-test.txt`      | Generate Vitest tests   |
| Refactor        | `prompts/refactor.txt`        | Scoped refactoring      |
| Review Diff     | `prompts/review-diff.txt`     | Code review on diffs    |

**Using templates in scripts:**

```bash
# Load template, substitute variables, pipe to Claude
TEMPLATE=$(cat prompts/implement-issue.txt)
PROMPT="${TEMPLATE//\{ISSUE_URL\}/$ISSUE_URL}"
PROMPT="${PROMPT//\{ISSUE_NUMBER\}/$ISSUE_NUMBER}"
echo "$PROMPT" | claude --model claude-sonnet-4-5
```

**Template conventions:**

- Variables use `{VARIABLE_NAME}` (curly braces, uppercase)
- Each template starts with context-setting ("You are working on the OpenClaw repo")
- Each template references `docs/repo-map.json` for file discovery
- Each template specifies the expected output format (diff-only, list, etc.)
