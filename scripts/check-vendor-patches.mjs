#!/usr/bin/env node
// 补丁面守卫：对照 vendor/.hive/baseline.sha256 与 vendor/.hive/patch-allowlist.txt，
// 校验 vendored teahouse 工作树。白名单外任何修改/删除/新增 → fail-closed（exit 1）。
// 纯 Node 零依赖；接入 .githooks/pre-push 与 CI。用法：
//   node scripts/check-vendor-patches.mjs [--root <repoRoot>]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class GuardConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardConfigError';
  }
}

export const VENDOR_REL = 'vendor/teahouse';
export const HIVE_REL = 'vendor/.hive';
const ALLOWED_MODES = new Set(['100644', '100755', '120000']);
const GENERATED_PREFIXES = [
  'node_modules/',
  'out/',
  'dist/',
  'release/',
  'src/renderer/public/ocr/',
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// 确定性路径排序（manifest 与违规列表共用）
function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function validRelPath(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    !p.startsWith('/') &&
    !p.endsWith('/') &&
    !p.split('/').includes('..') &&
    !p.startsWith('vendor/') && // 必须是相对 vendor/teahouse 的路径
    !p.startsWith('.github/') &&
    p !== '.github'
  );
}

// ---------- 输入解析（malformed → GuardConfigError，fail-closed） ----------

export function parseBaselineManifest(text) {
  const map = new Map();
  let declared = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const m = /^#\s*file-count:\s*(\d+)$/.exec(line);
      if (m) declared = Number(m[1]);
      continue;
    }
    const m = /^([0-9a-f]{64}) ([0-7]{6}) (.+)$/.exec(line);
    if (!m) {
      throw new GuardConfigError(`baseline.sha256 第 ${i + 1} 行无法解析: ${raw}`);
    }
    const [, hex, mode, rawPath] = m;
    const p = rawPath.trim();
    if (!ALLOWED_MODES.has(mode)) {
      throw new GuardConfigError(`baseline.sha256 第 ${i + 1} 行非法 mode: ${mode}`);
    }
    if (!validRelPath(p)) {
      throw new GuardConfigError(`baseline.sha256 第 ${i + 1} 行非法路径: ${p}`);
    }
    if (map.has(p)) {
      throw new GuardConfigError(`baseline.sha256 重复路径: ${p}`);
    }
    map.set(p, { sha256: hex, mode });
  }
  if (map.size === 0) {
    throw new GuardConfigError('baseline.sha256 为空');
  }
  if (declared !== null && declared !== map.size) {
    throw new GuardConfigError(
      `baseline.sha256 file-count=${declared} 与条目数 ${map.size} 不一致`,
    );
  }
  return map;
}

export function formatManifest(entries) {
  const sorted = [...entries].sort(byPath);
  const head = [
    '# hive vendor baseline — 由 scripts/gen-vendor-baseline.mjs 从 pristine 上游快照生成',
    `# file-count: ${sorted.length}`,
  ];
  const body = sorted.map((e) => `${e.sha256} ${e.mode} ${e.path}`);
  return `${[...head, ...body].join('\n')}\n`;
}

export function parseProvenance(text, manifestSize) {
  let provenance;
  try {
    provenance = JSON.parse(text);
  } catch (err) {
    throw new GuardConfigError(`provenance.json 无法解析: ${err.message}`);
  }
  const commit = provenance?.upstream?.commit;
  const archiveSha256 = provenance?.baseline?.archiveSha256;
  if (provenance?.upstream?.tag !== 'v0.60.2') {
    throw new GuardConfigError('provenance.json upstream.tag 必须是 v0.60.2');
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new GuardConfigError('provenance.json upstream.commit 非法');
  }
  if (provenance?.license !== 'GPL-3.0-only') {
    throw new GuardConfigError('provenance.json license 必须是 GPL-3.0-only');
  }
  if (!/^[0-9a-f]{64}$/.test(archiveSha256 ?? '')) {
    throw new GuardConfigError('provenance.json baseline.archiveSha256 非法');
  }
  if (provenance?.baseline?.manifest !== `${HIVE_REL}/baseline.sha256`) {
    throw new GuardConfigError('provenance.json baseline.manifest 与守卫路径不一致');
  }
  if (provenance?.baseline?.fileCount !== manifestSize) {
    throw new GuardConfigError(
      `provenance.json baseline.fileCount=${provenance?.baseline?.fileCount} 与 manifest 条目数 ${manifestSize} 不一致`,
    );
  }
  return provenance;
}

export function parseAllowlist(text) {
  const pathFiles = new Set();
  const newRules = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const sp = line.search(/\s/);
    const kw = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp).trim();
    if (kw === 'path') {
      if (!rest || rest.includes('*') || rest.includes('?') || rest.includes('[')) {
        throw new GuardConfigError(`patch-allowlist 第 ${i + 1} 行 path 必须是精确文件路径: ${line}`);
      }
      if (!validRelPath(rest)) {
        throw new GuardConfigError(`patch-allowlist 第 ${i + 1} 行非法路径: ${rest}`);
      }
      pathFiles.add(rest);
    } else if (kw === 'new') {
      if (!rest) {
        throw new GuardConfigError(`patch-allowlist 第 ${i + 1} 行 new 缺少路径: ${line}`);
      }
      if (rest.endsWith('/**')) {
        const base = rest.slice(0, -3);
        if (!base || base.includes('*') || base.includes('?') || !validRelPath(base)) {
          throw new GuardConfigError(`patch-allowlist 第 ${i + 1} 行非法 new 目录: ${rest}`);
        }
        newRules.push({ type: 'dir', value: `${base}/` });
      } else {
        if (rest.includes('*') || !validRelPath(rest)) {
          throw new GuardConfigError(`patch-allowlist 第 ${i + 1} 行非法 new 文件: ${rest}`);
        }
        newRules.push({ type: 'file', value: rest });
      }
    } else {
      throw new GuardConfigError(`patch-allowlist 第 ${i + 1} 行未知关键字: ${kw}`);
    }
  }
  if (pathFiles.size === 0 && newRules.length === 0) {
    throw new GuardConfigError('patch-allowlist 为空');
  }
  return { pathFiles, newRules };
}

export function matchNewRule(allowlist, relPath) {
  return allowlist.newRules.some((r) =>
    r.type === 'dir' ? relPath.startsWith(r.value) : relPath === r.value,
  );
}

// ---------- 判定核心（纯函数） ----------

// fileState(relPath) -> {exists:false} | {exists:true, sha256, mode}
// indexPaths: git index 中 vendor/teahouse 下的仓库相对路径（已剥前缀）
// statusEntries: [{code:'??', path:'src/x.ts'}, ...]（path 已剥前缀）
export function evaluatePatches({ manifest, allowlist, indexPaths, statusEntries, fileState }) {
  const violations = [];

  for (const [p, entry] of manifest) {
    if (allowlist.pathFiles.has(p)) continue; // path 白名单内，允许任意差异
    const st = fileState(p);
    if (!st.exists) {
      violations.push({ path: p, reason: 'baseline 文件被删除，且不在 path 白名单' });
    } else if (st.sha256 !== entry.sha256 || st.mode !== entry.mode) {
      violations.push({ path: p, reason: 'baseline 文件被修改，且不在 path 白名单' });
    }
  }

  // 候选 = index 与工作树中所有 baseline 之外的路径（去重；manifest 命中的不算新增）
  const candidates = new Set();
  for (const p of indexPaths) {
    if (!manifest.has(p)) candidates.add(p);
  }
  for (const s of statusEntries) {
    if (!manifest.has(s.path)) candidates.add(s.path);
  }
  for (const p of candidates) {
    if (!matchNewRule(allowlist, p)) {
      violations.push({ path: p, reason: '新增/未记账路径，不在 new 白名单' });
    }
  }

  violations.sort(byPath);
  return violations;
}

// ---------- 文件系统 / git 接线 ----------

export function hashFileState(absPath) {
  const st = fs.lstatSync(absPath);
  if (st.isSymbolicLink()) {
    return { sha256: sha256(fs.readlinkSync(absPath)), mode: '120000' };
  }
  return {
    sha256: sha256(fs.readFileSync(absPath)),
    mode: st.mode & 0o111 ? '100755' : '100644',
  };
}

function makeFileState(vendorDir) {
  const cache = new Map();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const abs = path.join(vendorDir, rel);
    let out;
    try {
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) out = { exists: false };
      else out = { exists: true, ...hashFileState(abs) };
    } catch {
      out = { exists: false };
    }
    cache.set(rel, out);
    return out;
  };
}

function isGeneratedPath(relPath) {
  return GENERATED_PREFIXES.some((prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix));
}

function listWorkingTreePaths(vendorDir) {
  const paths = [];
  const walk = (dir, prefix = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (isGeneratedPath(rel)) continue;
      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name), rel);
      } else {
        paths.push(rel);
      }
    }
  };
  walk(vendorDir);
  return paths;
}

function gitOut(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function stripVendorPrefix(p) {
  const prefix = `${VENDOR_REL}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

export function parsePorcelainZ(out) {
  const parts = out.split('\0');
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const e = parts[i];
    i += 1;
    if (!e || e.length < 4) continue;
    const code = e.slice(0, 2);
    const p = stripVendorPrefix(e.slice(3));
    if (p) entries.push({ code, path: p });
    if (code[0] === 'R' || code[0] === 'C') {
      const orig = parts[i];
      i += 1;
      const op = orig ? stripVendorPrefix(orig) : null;
      if (op) entries.push({ code, path: op });
    }
  }
  return entries;
}

export function runCheck(repoRoot) {
  const hiveDir = path.join(repoRoot, HIVE_REL);
  const manifestPath = path.join(hiveDir, 'baseline.sha256');
  const allowPath = path.join(hiveDir, 'patch-allowlist.txt');
  const provenancePath = path.join(hiveDir, 'provenance.json');
  for (const p of [manifestPath, allowPath, provenancePath]) {
    if (!fs.existsSync(p)) {
      throw new GuardConfigError(`缺少守卫账本: ${path.relative(repoRoot, p)}`);
    }
  }
  const manifest = parseBaselineManifest(fs.readFileSync(manifestPath, 'utf8'));
  parseProvenance(fs.readFileSync(provenancePath, 'utf8'), manifest.size);
  const allowlist = parseAllowlist(fs.readFileSync(allowPath, 'utf8'));

  const idxRaw = gitOut(repoRoot, ['ls-files', '-z', '--', VENDOR_REL]);
  const indexPaths = idxRaw
    .split('\0')
    .filter(Boolean)
    .map(stripVendorPrefix)
    .filter(Boolean);
  const statusRaw = gitOut(repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '-uall',
    '--',
    VENDOR_REL,
  ]);
  const statusEntries = parsePorcelainZ(statusRaw);
  const workingTreeEntries = listWorkingTreePaths(path.join(repoRoot, VENDOR_REL)).map((p) => ({
    code: 'FS',
    path: p,
  }));

  const violations = evaluatePatches({
    manifest,
    allowlist,
    indexPaths,
    statusEntries: [...statusEntries, ...workingTreeEntries],
    fileState: makeFileState(path.join(repoRoot, VENDOR_REL)),
  });
  return { violations, baselineFiles: manifest.size };
}

// ---------- CLI ----------

function main(argv) {
  let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      repoRoot = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      process.stderr.write(`未知参数: ${argv[i]}\n`);
      process.exit(2);
    }
  }
  try {
    const { violations, baselineFiles } = runCheck(repoRoot);
    if (violations.length === 0) {
      process.stdout.write(`patch surface OK — ${baselineFiles} baseline files, 0 violations\n`);
      process.exit(0);
    }
    for (const v of violations) {
      process.stdout.write(`FAIL ${VENDOR_REL}/${v.path}: ${v.reason}\n`);
    }
    process.stdout.write(
      `patch surface VIOLATED — ${violations.length} violation(s), ${baselineFiles} baseline files\n`,
    );
    process.exit(1);
  } catch (err) {
    if (err instanceof GuardConfigError) {
      process.stderr.write(`FAIL guard config error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2));
}
