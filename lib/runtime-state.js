const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadState(filePath, defaults) {
  try {
    if (!fs.existsSync(filePath)) {
      ensureDir(path.dirname(filePath));
      return { ...defaults };
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}

function saveState(filePath, state) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

module.exports = {
  loadState,
  saveState,
};
