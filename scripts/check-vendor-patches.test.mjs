// 补丁面守卫测试：白名单外的 vendored 修改必须 fail-closed。
// 纯函数矩阵 + 真实 git fixture 端到端。node:test 零依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  GuardConfigError,
  evaluatePatches,
  formatManifest,
  hashFileState,
  parseAllowlist,
  parseBaselineManifest,
  parseProvenance,
} from './check-vendor-patches.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, 'check-vendor-patches.mjs');
const H64 = (ch) => ch.repeat(64);

function baseManifest() {
  return parseBaselineManifest(
    formatManifest([
      { path: 'src/a.txt', sha256: H64('a'), mode: '100644' },
      { path: 'src/b.sh', sha256: H64('b'), mode: '100755' },
      { path: 'package.json', sha256: H64('c'), mode: '100644' },
    ]),
  );
}

function allow(text) {
  return parseAllowlist(text);
}

const CLEAN_ALLOW = allow('path package.json\nnew src/hive/**\n');
const FIXTURE_PROVENANCE = {
  upstream: { tag: 'v0.60.2', commit: 'a'.repeat(40) },
  license: 'GPL-3.0-only',
  baseline: {
    archiveSha256: 'b'.repeat(64),
    fileCount: 2,
    manifest: 'vendor/.hive/baseline.sha256',
  },
};

// fileState: path -> {exists, sha256, mode}
function state(map) {
  return (p) => map[p] ?? { exists: false };
}

const CLEAN_STATE = state({
  'src/a.txt': { exists: true, sha256: H64('a'), mode: '100644' },
  'src/b.sh': { exists: true, sha256: H64('b'), mode: '100755' },
  'package.json': { exists: true, sha256: H64('c'), mode: '100644' },
});

test('parseBaselineManifest: 合法内容解析为 path 索引', () => {
  const m = baseManifest();
  assert.equal(m.size, 3);
  assert.deepEqual(m.get('src/b.sh'), { sha256: H64('b'), mode: '100755' });
});

test('parseBaselineManifest: 非法 sha256 / mode / 重复路径 / 坏行 → GuardConfigError', () => {
  assert.throws(() => parseBaselineManifest('nothex64 100644  src/a.txt\n'), GuardConfigError);
  assert.throws(() => parseBaselineManifest(`${H64('a')} 100777  src/a.txt\n`), GuardConfigError);
  assert.throws(
    () => parseBaselineManifest(`${H64('a')} 100644  src/a.txt\n${H64('b')} 100644  src/a.txt\n`),
    GuardConfigError,
  );
  assert.throws(() => parseBaselineManifest('garbage line\n'), GuardConfigError);
  // 注释与空行被忽略，合法条目正常解析
  assert.doesNotThrow(() => parseBaselineManifest(`# comment\n\n${H64('a')} 100644  src/a.txt\n`));
});

test('parseBaselineManifest: file-count 头与条目数不一致 → fail-closed', () => {
  assert.throws(
    () => parseBaselineManifest(`# file-count: 9\n${H64('a')} 100644  src/a.txt\n`),
    GuardConfigError,
  );
});

test('parseProvenance: 固定来源字段与 manifest 数量必须自洽', () => {
  assert.doesNotThrow(() => parseProvenance(JSON.stringify(FIXTURE_PROVENANCE), 2));
  assert.throws(
    () => parseProvenance(JSON.stringify({ ...FIXTURE_PROVENANCE, license: 'MIT' }), 2),
    GuardConfigError,
  );
  assert.throws(() => parseProvenance('{', 2), GuardConfigError);
  assert.throws(() => parseProvenance(JSON.stringify(FIXTURE_PROVENANCE), 3), GuardConfigError);
});

test('parseAllowlist: path 精确条目 + new 目录/文件条目', () => {
  const a = allow('# c\npath package.json\nnew src/hive/**\nnew src/one.ts\n');
  assert.ok(a.pathFiles.has('package.json'));
  assert.equal(a.newRules.length, 2);
  assert.ok(a.newRules.some((r) => r.type === 'dir' && r.value === 'src/hive/'));
  assert.ok(a.newRules.some((r) => r.type === 'file' && r.value === 'src/one.ts'));
});

test('parseAllowlist: 未知关键字 / path 含通配 / 非法路径 → GuardConfigError', () => {
  assert.throws(() => allow('dir src/\n'), GuardConfigError);
  assert.throws(() => allow('path src/*.ts\n'), GuardConfigError);
  assert.throws(() => allow('path /abs/x\n'), GuardConfigError);
  assert.throws(() => allow('path ../x\n'), GuardConfigError);
  assert.throws(() => allow('new src/hive*\n'), GuardConfigError);
  assert.throws(() => allow('path\n'), GuardConfigError);
});

test('evaluate: 干净树 → 0 违规', () => {
  const v = evaluatePatches({
    manifest: baseManifest(),
    allowlist: CLEAN_ALLOW,
    indexPaths: ['package.json', 'src/a.txt', 'src/b.sh'],
    statusEntries: [],
    fileState: CLEAN_STATE,
  });
  assert.deepEqual(v, []);
});

test('evaluate: 白名单外修改 → 违规；白名单内修改 → 放行', () => {
  const tamperedA = state({
    'src/a.txt': { exists: true, sha256: H64('d'), mode: '100644' },
    'src/b.sh': { exists: true, sha256: H64('b'), mode: '100755' },
    'package.json': { exists: true, sha256: H64('c'), mode: '100644' },
  });
  const v1 = evaluatePatches({
    manifest: baseManifest(),
    allowlist: CLEAN_ALLOW,
    indexPaths: ['package.json', 'src/a.txt', 'src/b.sh'],
    statusEntries: [{ code: ' M', path: 'src/a.txt' }],
    fileState: tamperedA,
  });
  assert.equal(v1.length, 1);
  assert.equal(v1[0].path, 'src/a.txt');

  const tamperedPkg = state({
    'src/a.txt': { exists: true, sha256: H64('a'), mode: '100644' },
    'src/b.sh': { exists: true, sha256: H64('b'), mode: '100755' },
    'package.json': { exists: true, sha256: H64('e'), mode: '100644' },
  });
  const v2 = evaluatePatches({
    manifest: baseManifest(),
    allowlist: CLEAN_ALLOW,
    indexPaths: ['package.json', 'src/a.txt', 'src/b.sh'],
    statusEntries: [{ code: ' M', path: 'package.json' }],
    fileState: tamperedPkg,
  });
  assert.deepEqual(v2, []);
});

test('evaluate: 白名单外删除 → 违规；白名单内删除 → 放行', () => {
  const noA = state({
    'src/b.sh': { exists: true, sha256: H64('b'), mode: '100755' },
    'package.json': { exists: true, sha256: H64('c'), mode: '100644' },
  });
  const v1 = evaluatePatches({
    manifest: baseManifest(),
    allowlist: CLEAN_ALLOW,
    indexPaths: ['src/b.sh', 'package.json'],
    statusEntries: [{ code: ' D', path: 'src/a.txt' }],
    fileState: noA,
  });
  assert.equal(v1.length, 1);
  assert.equal(v1[0].path, 'src/a.txt');

  const noPkg = state({
    'src/a.txt': { exists: true, sha256: H64('a'), mode: '100644' },
    'src/b.sh': { exists: true, sha256: H64('b'), mode: '100755' },
  });
  const v2 = evaluatePatches({
    manifest: baseManifest(),
    allowlist: CLEAN_ALLOW,
    indexPaths: ['src/a.txt', 'src/b.sh'],
    statusEntries: [{ code: 'D ', path: 'package.json' }],
    fileState: noPkg,
  });
  assert.deepEqual(v2, []);
});

test('evaluate: mode 变化等同修改，受白名单管辖', () => {
  const flipped = state({
    'src/a.txt': { exists: true, sha256: H64('a'), mode: '100755' },
    'src/b.sh': { exists: true, sha256: H64('b'), mode: '100755' },
    'package.json': { exists: true, sha256: H64('c'), mode: '100644' },
  });
  const v = evaluatePatches({
    manifest: baseManifest(),
    allowlist: CLEAN_ALLOW,
    indexPaths: ['package.json', 'src/a.txt', 'src/b.sh'],
    statusEntries: [{ code: ' M', path: 'src/a.txt' }],
    fileState: flipped,
  });
  assert.equal(v.length, 1);
});

test('evaluate: 新增文件 — 白名单外违规，new 目录规则内放行，exact new 放行', () => {
  const base = {
    manifest: baseManifest(),
    allowlist: allow('path package.json\nnew src/hive/**\nnew src/one.ts\n'),
    statusEntries: [],
    fileState: CLEAN_STATE,
  };
  const idxExtra = ['package.json', 'src/a.txt', 'src/b.sh'];

  const vOut = evaluatePatches({
    ...base,
    indexPaths: [...idxExtra, 'src/evil.ts'],
    statusEntries: [{ code: '??', path: 'src/evil.ts' }],
  });
  assert.equal(vOut.length, 1);
  assert.equal(vOut[0].path, 'src/evil.ts');

  const vDir = evaluatePatches({
    ...base,
    indexPaths: [...idxExtra, 'src/hive/local-api.ts'],
    statusEntries: [{ code: 'A ', path: 'src/hive/local-api.ts' }],
  });
  assert.deepEqual(vDir, []);

  const vFile = evaluatePatches({
    ...base,
    indexPaths: [...idxExtra, 'src/one.ts'],
    statusEntries: [{ code: '??', path: 'src/one.ts' }],
  });
  assert.deepEqual(vFile, []);
});

test('evaluate: new 规则不能豁免 baseline 文件的修改', () => {
  const dirty = state({
    'src/a.txt': { exists: true, sha256: H64('f'), mode: '100644' },
    'src/b.sh': { exists: true, sha256: H64('b'), mode: '100755' },
    'package.json': { exists: true, sha256: H64('c'), mode: '100644' },
  });
  const v = evaluatePatches({
    manifest: baseManifest(),
    allowlist: allow('new src/**\n'), // 目录级 new 不含任何 path 条目
    indexPaths: ['package.json', 'src/a.txt', 'src/b.sh'],
    statusEntries: [{ code: ' M', path: 'src/a.txt' }],
    fileState: dirty,
  });
  assert.equal(v.length, 1);
  assert.equal(v[0].path, 'src/a.txt');
});

test('evaluate: index 中不在 manifest 的已跟踪路径按 new 判定', () => {
  const v = evaluatePatches({
    manifest: baseManifest(),
    allowlist: CLEAN_ALLOW,
    indexPaths: ['package.json', 'src/a.txt', 'src/b.sh', 'docs/readme.md'],
    statusEntries: [],
    fileState: CLEAN_STATE,
  });
  assert.equal(v.length, 1);
  assert.equal(v[0].path, 'docs/readme.md');
});

// ---------- 端到端：真实 git fixture + CLI ----------

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function setupFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-vendor-guard-'));
  const vendor = path.join(dir, 'vendor/teahouse');
  fs.mkdirSync(path.join(vendor, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'vendor/.hive'), { recursive: true });
  fs.writeFileSync(path.join(vendor, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(vendor, 'src/a.txt'), 'alpha\n');

  const entries = [
    { path: 'package.json', ...hashFileState(path.join(vendor, 'package.json')) },
    { path: 'src/a.txt', ...hashFileState(path.join(vendor, 'src/a.txt')) },
  ];
  fs.writeFileSync(
    path.join(dir, 'vendor/.hive/baseline.sha256'),
    formatManifest(entries),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'vendor/.hive/patch-allowlist.txt'),
    'path package.json\nnew src/hive/**\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'vendor/.hive/provenance.json'),
    `${JSON.stringify(FIXTURE_PROVENANCE, null, 2)}\n`,
    'utf8',
  );
  sh('git', ['init', '-q'], dir);
  sh('git', ['add', '-A'], dir);
  return dir;
}

function runChecker(root) {
  return spawnSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' });
}

test('e2e: fixture 干净 → exit 0', () => {
  const dir = setupFixture();
  const r = runChecker(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('e2e: 改白名单外文件 → exit 1 并点名路径', () => {
  const dir = setupFixture();
  fs.appendFileSync(path.join(dir, 'vendor/teahouse/src/a.txt'), 'tamper\n');
  const r = runChecker(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /src\/a\.txt/);
});

test('e2e: 改白名单内 package.json → exit 0', () => {
  const dir = setupFixture();
  fs.appendFileSync(path.join(dir, 'vendor/teahouse/package.json'), '// patched\n');
  const r = runChecker(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('e2e: 删除白名单外文件 → exit 1', () => {
  const dir = setupFixture();
  fs.rmSync(path.join(dir, 'vendor/teahouse/src/a.txt'));
  const r = runChecker(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('e2e: 白名单外新文件 → exit 1；new 规则目录内 → exit 0', () => {
  const dir = setupFixture();
  fs.writeFileSync(path.join(dir, 'vendor/teahouse/src/evil.ts'), 'export {}\n');
  let r = runChecker(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /evil\.ts/);

  fs.rmSync(path.join(dir, 'vendor/teahouse/src/evil.ts'));
  fs.mkdirSync(path.join(dir, 'vendor/teahouse/src/hive'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendor/teahouse/src/hive/local-api.ts'), 'export {}\n');
  r = runChecker(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('e2e: vendored .gitignore 忽略的新文件仍 fail-closed', () => {
  const dir = setupFixture();
  fs.writeFileSync(path.join(dir, 'vendor/teahouse/.gitignore'), 'docs/*\n');
  sh('git', ['add', 'vendor/teahouse/.gitignore'], dir);
  const manifestPath = path.join(dir, 'vendor/.hive/baseline.sha256');
  const manifest = parseBaselineManifest(fs.readFileSync(manifestPath, 'utf8'));
  manifest.set('.gitignore', hashFileState(path.join(dir, 'vendor/teahouse/.gitignore')));
  fs.writeFileSync(
    manifestPath,
    formatManifest([...manifest].map(([entryPath, file]) => ({ path: entryPath, ...file }))),
  );
  fs.writeFileSync(
    path.join(dir, 'vendor/.hive/provenance.json'),
    `${JSON.stringify({
      ...FIXTURE_PROVENANCE,
      baseline: { ...FIXTURE_PROVENANCE.baseline, fileCount: 3 },
    }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(dir, 'vendor/teahouse/docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendor/teahouse/docs/hidden.md'), 'hidden\n');

  const r = runChecker(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /docs\/hidden\.md/);
});

test('e2e: 损坏的 manifest / allowlist → exit 1（fail-closed）', () => {
  const dir = setupFixture();
  fs.writeFileSync(path.join(dir, 'vendor/.hive/baseline.sha256'), 'garbage\n');
  let r = runChecker(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);

  fs.writeFileSync(path.join(dir, 'vendor/.hive/patch-allowlist.txt'), 'dir src/\n');
  r = runChecker(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('e2e: 缺失 .hive 账本 → exit 1', () => {
  const dir = setupFixture();
  fs.rmSync(path.join(dir, 'vendor/.hive/baseline.sha256'));
  fs.rmSync(path.join(dir, 'vendor/.hive/patch-allowlist.txt'));
  fs.rmSync(path.join(dir, 'vendor/.hive/provenance.json'));
  const r = runChecker(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
