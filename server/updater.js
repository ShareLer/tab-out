// server/updater.js
// ─────────────────────────────────────────────────────────────────────────────
// Read-only update checker. Compares local git commit with GitHub's latest.
// No shell commands, no code execution. Just a boolean: is there a newer version?
// ─────────────────────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const path = require('path');

const REPO_URL = 'https://github.com/zarazhangrui/tab-out';
const API_URL = 'https://api.github.com/repos/zarazhangrui/tab-out/commits/main';
const CHECK_INTERVAL = 48 * 60 * 60 * 1000; // 48 hours
const PROJECT_ROOT = path.resolve(__dirname, '..');

let status = {
  updateAvailable: false,
  currentCommit: '',
  checkedAt: null,
};

function getLocalCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function checkForUpdate() {
  try {
    const localCommit = getLocalCommit();
    if (!localCommit) return;

    const res = await fetch(API_URL, {
      headers: { 'User-Agent': 'tab-out-updater' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return;

    const data = await res.json();
    const remoteCommit = data.sha;

    status = {
      updateAvailable: remoteCommit && localCommit !== remoteCommit,
      currentCommit: localCommit.slice(0, 7),
      checkedAt: new Date().toISOString(),
    };

    if (status.updateAvailable) {
      console.log(`[updater] Update available (local: ${localCommit.slice(0, 7)}, remote: ${remoteCommit.slice(0, 7)})`);
    }
  } catch {
    // Fail silently -- offline, rate limited, private repo, etc.
  }
}

function startUpdateChecker() {
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_INTERVAL);
}

function getUpdateStatus() {
  return status;
}

module.exports = { startUpdateChecker, getUpdateStatus };
