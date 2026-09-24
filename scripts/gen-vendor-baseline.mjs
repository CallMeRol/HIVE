#!/usr/bin/env node
// 从 pristine 的 vendor/teahouse 快照重新生成 vendor/.hive/baseline.sha256。
// 只允许在“刚解出上游、尚未 install/build”的干净树上运行（fail-closed 断言）。
// 用法：node scripts/gen-vendor-baseline.mjs [--root <repoRoot>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VENDOR_REL, HIVE_REL, formatManifest, hashFileState } from './check-vendor-patches.mjs';

const FORBIDDEN = ['.github', 'node_modules', 'out', 'release', 'dist'];

function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const abs = path.join(dir, ent.name);
    const rel = path.join(base, ent.name).replaceAll(path.sep, '/');
    if (ent.isDirectory()) {
      if (FORBIDDEN.includes(ent.name)) {
        throw new Error(`拒绝生成：快照内出现 ${rel}（必须是 pristine 上游树）`);
      }
      walk(abs, rel, out);
    } else if (ent.isFile()) {
      out.push({ path: rel, ...hashFileState(abs) });
    } else {
      throw new Error(`拒绝生成：不支持的文件类型 ${rel}`);
    }
  }
}

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
  const vendorDir = path.join(repoRoot, VENDOR_REL);
  if (!fs.existsSync(vendorDir)) {
    process.stderr.write(`缺少 ${VENDOR_REL}\n`);
    process.exit(1);
  }
  const entries = [];
  // 路径相对 vendor/teahouse/，与 patch-allowlist 语义一致
  walk(vendorDir, '', entries);
  if (entries.length === 0) {
    process.stderr.write('快照为空，拒绝生成\n');
    process.exit(1);
  }
  const outPath = path.join(repoRoot, HIVE_REL, 'baseline.sha256');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, formatManifest(entries), 'utf8');
  process.stdout.write(`wrote ${path.relative(repoRoot, outPath)} — ${entries.length} files\n`);
}

main(process.argv.slice(2));
