#!/usr/bin/env node
/**
 * 版本管理：单一真相源是 package.json 的 version。
 *
 * 用法：
 *   node scripts/version.mjs current
 *   node scripts/version.mjs bump [patch|minor|major] [--notes "说明"]
 *   node scripts/version.mjs package [--force]
 *   node scripts/version.mjs release [patch|minor|major] [--notes "说明"] [--force]
 *
 * release = bump + package（推荐发测试/正式包时用）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const changelogPath = path.join(root, "CHANGELOG.md");

function readPkg() {
  return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
}

function writePkg(pkg) {
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

function parseSemver(version) {
  const m = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) {
    throw new Error(`非法 semver: ${version}`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function formatSemver({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(version, level) {
  const v = parseSemver(version);
  if (level === "major") {
    return formatSemver({ major: v.major + 1, minor: 0, patch: 0 });
  }
  if (level === "minor") {
    return formatSemver({ major: v.major, minor: v.minor + 1, patch: 0 });
  }
  if (level === "patch") {
    return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1 });
  }
  throw new Error(`未知 bump 级别: ${level}（用 patch|minor|major）`);
}

function todayIsoDate() {
  // 本地日历日，与用户「今天」一致
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prependChangelog(version, notes) {
  const date = todayIsoDate();
  const body =
    notes.length > 0
      ? notes.map((n) => `- ${n}`).join("\n")
      : "- （请补充本版本变更说明）";

  const section = `## [${version}] - ${date}\n\n### Changed\n\n${body}\n\n`;

  let existing = "";
  if (fs.existsSync(changelogPath)) {
    existing = fs.readFileSync(changelogPath, "utf8");
  } else {
    existing = "# Changelog\n\n所有显著变更都记录在此文件中。\n\n";
  }

  // 已有同版本段落则拒绝（防止重复 bump 写两段）
  if (existing.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG 已有 ${version} 段落，拒绝重复写入`);
  }

  const marker = "# Changelog";
  if (existing.startsWith(marker)) {
    // 插在标题与导语之后、第一个 ## 之前
    const firstSection = existing.indexOf("\n## ");
    if (firstSection === -1) {
      existing = `${existing.trimEnd()}\n\n${section}`;
    } else {
      existing = `${existing.slice(0, firstSection + 1)}${section}${existing.slice(firstSection + 1)}`;
    }
  } else {
    existing = `${marker}\n\n所有显著变更都记录在此文件中。\n\n${section}${existing}`;
  }

  fs.writeFileSync(changelogPath, existing, "utf8");
}

function vsixName(pkg) {
  // 与 vsce 默认命名一致：<name>-<version>.vsix
  return `${pkg.name}-${pkg.version}.vsix`;
}

function vsixPath(pkg) {
  return path.join(root, vsixName(pkg));
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} 失败（exit ${result.status}）`);
  }
}

function ensureExecutableBins() {
  // 部分环境 node_modules/.bin 丢失可执行位
  const bins = [
    path.join(root, "node_modules/.bin/tsc"),
    path.join(root, "node_modules/.bin/vsce"),
  ];
  for (const bin of bins) {
    try {
      fs.chmodSync(bin, 0o755);
    } catch {
      // ignore
    }
  }
}

function cmdCurrent() {
  const pkg = readPkg();
  console.log(pkg.version);
  console.log(`vsix: ${vsixName(pkg)}`);
}

function cmdBump(level, notes) {
  const pkg = readPkg();
  const from = pkg.version;
  const to = bumpVersion(from, level);
  pkg.version = to;
  writePkg(pkg);
  prependChangelog(to, notes);
  console.log(`version: ${from} -> ${to}`);
  console.log(`updated: package.json, CHANGELOG.md`);
  return to;
}

function cmdPackage({ force }) {
  ensureExecutableBins();
  const pkg = readPkg();
  const out = vsixPath(pkg);

  if (fs.existsSync(out) && !force) {
    throw new Error(
      `已存在 ${path.basename(out)}。\n` +
        `  - 若是新构建：先 npm run version:bump -- patch（或 minor/major）再打包\n` +
        `  - 若确认覆盖同版本：npm run vsix -- --force`,
    );
  }

  // 编译（不依赖 .bin 可执行位）
  const tsc = path.join(root, "node_modules/typescript/bin/tsc");
  run(process.execPath, [tsc, "-p", "./"]);

  const vsceJs = path.join(root, "node_modules/@vscode/vsce/vsce");
  // vsce 会再跑 vscode:prepublish；.bin 已 chmod
  run(process.execPath, [vsceJs, "package", "--no-update-package-json"]);

  if (!fs.existsSync(out)) {
    // vsce 偶尔用 publisher.name 命名；兜底查找
    const alt = path.join(root, `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`);
    if (fs.existsSync(alt)) {
      fs.renameSync(alt, out);
    }
  }

  if (!fs.existsSync(out)) {
    throw new Error(`打包完成但未找到 ${path.basename(out)}`);
  }

  const stat = fs.statSync(out);
  console.log(`DONE  ${out}`);
  console.log(`size  ${(stat.size / 1024).toFixed(1)} KB`);
  console.log(`install: code --install-extension "${out}"`);
  return out;
}

function parseArgs(argv) {
  const args = [...argv];
  const flags = new Set();
  const notes = [];
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") {
      flags.add("force");
      continue;
    }
    if (a === "--notes") {
      const n = args[++i];
      if (!n) {
        throw new Error("--notes 需要参数");
      }
      notes.push(n);
      continue;
    }
    if (a.startsWith("--notes=")) {
      notes.push(a.slice("--notes=".length));
      continue;
    }
    positionals.push(a);
  }

  return { positionals, flags, notes };
}

function usage() {
  console.log(`用法:
  npm run version:current
  npm run version:bump -- patch|minor|major [--notes "变更说明"]
  npm run vsix [-- --force]
  npm run release -- patch|minor|major [--notes "变更说明"] [--force]

约定:
  - package.json version 是唯一真相源
  - 每次发布测试包先 bump，再 package（release 一步完成）
  - 默认禁止覆盖已存在的同版本 .vsix（需 --force）
`);
}

function main() {
  const { positionals, flags, notes } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0] || "current";
  const force = flags.has("force");

  try {
    if (cmd === "current") {
      cmdCurrent();
      return;
    }
    if (cmd === "bump") {
      const level = positionals[1] || "patch";
      cmdBump(level, notes);
      return;
    }
    if (cmd === "package" || cmd === "vsix") {
      cmdPackage({ force });
      return;
    }
    if (cmd === "release") {
      const level = positionals[1] || "patch";
      cmdBump(level, notes);
      cmdPackage({ force });
      return;
    }
    usage();
    process.exit(1);
  } catch (error) {
    console.error(`ERROR  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
