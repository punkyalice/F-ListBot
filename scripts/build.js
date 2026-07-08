// Production build for src/ only. Plugins are intentionally NOT bundled here -
// PluginManager transpiles plugin .ts files on demand at load/reload time.
const esbuild = require("esbuild");
const { readdirSync, statSync, mkdirSync, copyFileSync } = require("fs");
const path = require("path");

function walk(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

const srcDir = path.join(__dirname, "..", "src");
const distDir = path.join(__dirname, "..", "dist");
const entryPoints = walk(srcDir, (f) => f.endsWith(".ts"));

esbuild
  .build({
    entryPoints,
    outdir: distDir,
    outbase: srcDir,
    platform: "node",
    target: "node18",
    format: "cjs",
    sourcemap: true,
    logLevel: "info",
  })
  .then(() => {
    // Non-.ts assets (migration SQL) aren't touched by esbuild - copy them alongside
    // their compiled counterparts so runtime path.join(__dirname, ...) lookups resolve.
    for (const file of walk(srcDir, (f) => f.endsWith(".sql"))) {
      const rel = path.relative(srcDir, file);
      const dest = path.join(distDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(file, dest);
    }
  })
  .catch(() => process.exit(1));
