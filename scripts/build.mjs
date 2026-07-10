import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const outdir = resolve(root, "build");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const iconDir = resolve(root, "icons");
await mkdir(iconDir, { recursive: true });
await Promise.all([16, 32, 48, 128].map((size) => sharp(resolve(root, "assets/icon.svg"))
  .resize(size, size)
  .png({ compressionLevel: 9 })
  .toFile(resolve(iconDir, `icon-${size}.png`))));

const common = {
  absWorkingDir: root,
  bundle: true,
  charset: "utf8",
  legalComments: "inline",
  logLevel: "info",
  minify: false,
  platform: "browser",
  sourcemap: false,
  target: ["chrome111", "edge111"]
};

await Promise.all([
  build({
    ...common,
    entryPoints: {
      "background/service-worker": "src/background/service-worker.js",
      "ui/downloader": "src/ui/downloader.js"
    },
    format: "esm",
    outdir
  }),
  build({
    ...common,
    entryPoints: {
      "content/content-script": "src/content/content-script.js",
      "content/page-hook": "src/content/page-hook.js"
    },
    format: "iife",
    outdir
  })
]);
