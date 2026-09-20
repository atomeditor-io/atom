'use strict';

const fs = require('fs');
const path = require('path');

const GITHUB_LIB_REL = path.join('node_modules', 'github', 'lib');

function collectScripts(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectScripts(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

function isEsm(source) {
  return /^(import |export )/.test(source);
}

function transpileFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  if (!isEsm(source)) {
    return false;
  }
  const babel = require('@babel/core');
  const result = babel.transformSync(source, {
    filename: filePath,
    presets: [
      [
        require.resolve('@babel/preset-env'),
        { targets: { electron: '39.0.0' }, modules: 'commonjs' }
      ],
      require.resolve('@babel/preset-react')
    ],
    plugins: [require.resolve('@babel/plugin-proposal-class-properties')]
  });
  if (isEsm(result.code)) {
    throw new Error(`Unexpected ESM remaining after transpile: ${filePath}`);
  }
  fs.writeFileSync(filePath, result.code);
  return true;
}

function transpileGithubEsm(nodeModulesRoot) {
  const githubLibRoot = path.join(nodeModulesRoot, ...GITHUB_LIB_REL.split(path.sep));
  if (!fs.existsSync(githubLibRoot)) {
    return 0;
  }
  let count = 0;
  for (const filePath of collectScripts(githubLibRoot)) {
    if (transpileFile(filePath)) {
      count++;
    }
  }
  if (count > 0) {
    console.log(`Transpiled github/lib ES modules to CommonJS (${count} files)`);
  }
  return count;
}

module.exports = { transpileGithubEsm };
