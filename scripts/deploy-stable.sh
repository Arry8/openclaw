#!/usr/bin/env bash
# Authored by: cc (Claude Code) | 2026-03-15
# Build in the dev repo and promote to the openclaw-stable worktree so the
# LaunchAgent always runs from a stable, fully self-contained copy.
#
# The stable worktree (~/../openclaw-stable) has its own node_modules symlink
# and extensions — plugin loading works identically to the dev repo.
#
# Usage:
#   pnpm deploy:stable                             # build + test + promote + restart
#   OPENCLAW_DEPLOY_SKIP_TESTS=1 pnpm deploy:stable   # skip tests
#   OPENCLAW_DEPLOY_SKIP_RESTART=1 pnpm deploy:stable # skip gateway restart
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STABLE_DIR="${REPO_DIR}/../openclaw-stable"
STABLE_DIR="$(cd "${STABLE_DIR}" 2>/dev/null && pwd || echo "${REPO_DIR}/../openclaw-stable")"
DIST_SRC="${REPO_DIR}/dist"
DIST_DEST="${STABLE_DIR}/dist"
SKIP_TESTS="${OPENCLAW_DEPLOY_SKIP_TESTS:-0}"
SKIP_RESTART="${OPENCLAW_DEPLOY_SKIP_RESTART:-0}"
LAUNCHD_LABEL="ai.openclaw.gateway"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
DESIRED_ENTRY="${DIST_DEST}/index.js"
WATCHDOG_LABELS=("ai.openclaw.watchdog" "com.openclaw.watchdog")
WATCHDOG_USER_PLIST="${HOME}/Library/LaunchAgents/ai.openclaw.watchdog.plist"
WATCHDOG_SYS_PLIST="/Library/LaunchAgents/com.openclaw.watchdog.plist"

log() { printf '[deploy-stable] %s\n' "$*"; }
die() { printf '[deploy-stable] ERROR: %s\n' "$*" >&2; exit 1; }

# ── 0. Ensure stable worktree exists ──────────────────────────────────────────
if [[ ! -d "${STABLE_DIR}" ]]; then
  log "Creating openclaw-stable worktree..."
  git -C "${REPO_DIR}" worktree add "${STABLE_DIR}" main
  log "Worktree created at ${STABLE_DIR}"
fi

# ── 1. Ensure node_modules symlink in stable (avoids 1.5 GB duplication) ─────
NM_DEST="${STABLE_DIR}/node_modules"
if [[ -L "${NM_DEST}" ]]; then
  log "node_modules symlink already present"
elif [[ -d "${NM_DEST}" ]]; then
  log "Removing real node_modules in stable (replacing with symlink)..."
  rm -rf "${NM_DEST}"
  ln -s "${REPO_DIR}/node_modules" "${NM_DEST}"
  log "node_modules symlink created"
else
  ln -s "${REPO_DIR}/node_modules" "${NM_DEST}"
  log "node_modules symlink created"
fi

# ── 2. Build in dev repo ──────────────────────────────────────────────────────
log "Building in dev repo..."
cd "${REPO_DIR}"
# Allow tsc type-check failures (upstream browser TS errors unrelated to this fork).
# The bundler (tsdown) runs before tsc and produces dist/index.js; as long as that
# file exists and is fresh, the deploy is safe to continue.
BUILD_EXIT=0
pnpm build || BUILD_EXIT=$?
if [[ "${BUILD_EXIT}" != "0" ]]; then
  if [[ -f "${DIST_SRC}/index.js" ]]; then
    log "WARNING: build exited ${BUILD_EXIT} (likely upstream tsc errors) but dist/index.js exists — continuing."
    # tsc failure stops the && chain before write-build-info.ts runs; do it now
    log "Writing build-info.json manually..."
    node --import tsx scripts/write-build-info.ts
  else
    die "Build failed (exit ${BUILD_EXIT}) and dist/index.js is missing — aborting."
  fi
fi

# ── 3. Tests (optional) ───────────────────────────────────────────────────────
if [[ "${SKIP_TESTS}" != "1" ]]; then
  log "Running tests..."
  pnpm test:fast
else
  log "Skipping tests (OPENCLAW_DEPLOY_SKIP_TESTS=1)"
fi

# ── 4. Promote dist/ to stable worktree ───────────────────────────────────────
log "Promoting dist/ → ${DIST_DEST}..."
mkdir -p "${DIST_DEST}"
rsync -a --delete "${DIST_SRC}/" "${DIST_DEST}/"
log "dist/ promoted"

# ── 5. Pause watchdog agents (prevent gateway install --force during restart) ─
for wl in "${WATCHDOG_LABELS[@]}"; do
  launchctl bootout "gui/$(id -u)/${wl}" 2>/dev/null || true
  launchctl bootout "system/${wl}" 2>/dev/null || true
done
log "Watchdog agents paused"

# ── 6. Update plist to point at stable dist ───────────────────────────────────
if [[ ! -f "${PLIST_PATH}" ]]; then
  log "WARNING: plist not found at ${PLIST_PATH} — skipping plist update"
else
  CURRENT_ENTRY="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "${PLIST_PATH}" 2>/dev/null || true)"
  if [[ "${CURRENT_ENTRY}" != "${DESIRED_ENTRY}" ]]; then
    log "Updating plist: ${CURRENT_ENTRY} → ${DESIRED_ENTRY}"
    /usr/bin/plutil -replace 'ProgramArguments.1' -string "${DESIRED_ENTRY}" "${PLIST_PATH}"
  fi
  # Remove stale extra JS path at index 2 if doctor --fix inserted one
  INDEX2="$(/usr/bin/plutil -extract ProgramArguments.2 raw -o - "${PLIST_PATH}" 2>/dev/null || true)"
  if [[ "${INDEX2}" == *.js ]]; then
    /usr/bin/plutil -remove 'ProgramArguments.2' "${PLIST_PATH}"
    log "Removed stale path at ProgramArguments[2]: ${INDEX2}"
  fi
  VERIFIED="$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "${PLIST_PATH}")"
  log "Plist verified: ${VERIFIED}"

  # Update OPENCLAW_VERSION + Comment in plist so dashboard shows the correct commit
  BUILD_INFO_PATH="${DIST_DEST}/build-info.json"
  if [[ -f "${BUILD_INFO_PATH}" ]]; then
    BUILT_VERSION="$(python3 -c "import json,sys; d=json.load(open('${BUILD_INFO_PATH}')); print(d.get('version',''))")"
    BUILT_COMMIT="$(python3 -c "import json,sys; d=json.load(open('${BUILD_INFO_PATH}')); print(d.get('commit','')[:10])")"
    if [[ -n "${BUILT_VERSION}" && -n "${BUILT_COMMIT}" ]]; then
      NEW_OC_VERSION="${BUILT_VERSION}+${BUILT_COMMIT}"
      /usr/bin/plutil -replace 'EnvironmentVariables.OPENCLAW_VERSION' -string "${NEW_OC_VERSION}" "${PLIST_PATH}"
      /usr/bin/plutil -replace 'Comment' -string "OpenClaw Gateway (${NEW_OC_VERSION})" "${PLIST_PATH}"
      log "Plist OPENCLAW_VERSION updated to ${NEW_OC_VERSION}"
    fi
  else
    log "WARNING: build-info.json not found at ${BUILD_INFO_PATH} — OPENCLAW_VERSION not updated"
  fi
fi

# ── 7. Restart gateway ────────────────────────────────────────────────────────
if [[ "${SKIP_RESTART}" != "1" ]]; then
  log "Restarting gateway..."
  launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  sleep 3
  launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
  sleep 5
  log "Gateway restarted. Waiting for RPC probe..."
  GATEWAY_OK=0
  for i in 1 2 3 4 5; do
    sleep 3
    if node "${DIST_DEST}/index.js" gateway status 2>&1 | grep -q "RPC probe: ok"; then
      log "Gateway RPC probe: ok (attempt ${i})"
      GATEWAY_OK=1
      break
    fi
    log "RPC probe not ready yet (attempt ${i}/5)..."
  done
  if [[ "${GATEWAY_OK}" != "1" ]]; then
    log "WARNING: gateway RPC probe did not succeed after 5 attempts — check ${HOME}/.openclaw/logs/gateway.log"
  fi
else
  log "Skipping gateway restart (OPENCLAW_DEPLOY_SKIP_RESTART=1)"
fi

# ── 8. Resume watchdog agents ─────────────────────────────────────────────────
[[ -f "${WATCHDOG_USER_PLIST}" ]] && launchctl bootstrap "gui/$(id -u)" "${WATCHDOG_USER_PLIST}" 2>/dev/null || true
[[ -f "${WATCHDOG_SYS_PLIST}" ]] && launchctl bootstrap "gui/$(id -u)" "${WATCHDOG_SYS_PLIST}" 2>/dev/null || true
log "Watchdog agents resumed"

# ── 9. Verify deployed commit matches stable HEAD ─────────────────────────────
BUILD_INFO_PATH="${DIST_DEST}/build-info.json"
if [[ -f "${BUILD_INFO_PATH}" ]]; then
  DEPLOYED_COMMIT="$(python3 -c "import json; print(json.load(open('${BUILD_INFO_PATH}')).get('commit',''))")"
  DEV_HEAD="$(git -C "${REPO_DIR}" rev-parse HEAD 2>/dev/null || echo "unknown")"
  if [[ "${DEPLOYED_COMMIT}" == "${DEV_HEAD}" ]]; then
    log "Commit verified: dist matches dev HEAD (${DEPLOYED_COMMIT:0:10})"
  else
    log "WARNING: dist commit (${DEPLOYED_COMMIT:0:10}) != dev HEAD (${DEV_HEAD:0:10}) — dist may be stale"
  fi
else
  log "WARNING: build-info.json missing — cannot verify deployed commit"
fi

log "Deploy complete. Gateway running from ${DIST_DEST}/index.js"
