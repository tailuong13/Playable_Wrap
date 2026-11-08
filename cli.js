#!/usr/bin/env node
// CLI with the same arguments as Tools/Playable/wrap_playable.py:
//   node cli.js <input.html> -o <outdir> [--ios URL] [--android URL] [--networks applovin,mintegral]
//               [--keep-debug-error] [--keep-remote-debug] [--start-ms N]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { deflateRawSync, constants } from "node:zlib";
import { wrapPlayable } from "./public/wrap-core.js";
import { buildZip } from "./public/zip.js";

function parseArgs(argv) {
  const a = { outdir: ".", ios: "", android: "", networks: "applovin,mintegral",
              keepDebugError: false, keepRemoteDebug: false, startMs: 0, input: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${k}`);
      return argv[++i];
    };
    if (k === "-o" || k === "--outdir") a.outdir = next();
    else if (k === "--ios") a.ios = next();
    else if (k === "--android") a.android = next();
    else if (k === "--networks") a.networks = next();
    else if (k === "--keep-debug-error") a.keepDebugError = true;
    else if (k === "--keep-remote-debug") a.keepRemoteDebug = true;
    else if (k === "--start-ms") a.startMs = parseInt(next(), 10) || 0;
    else if (k === "-h" || k === "--help") { usage(); process.exit(0); }
    else if (k.startsWith("-")) fail(`unknown option ${k}`);
    else a.input = k;
  }
  if (!a.input) { usage(); process.exit(2); }
  return a;
}

function usage() {
  console.log("usage: node cli.js <input.html> [-o OUTDIR] [--ios URL] [--android URL] " +
              "[--networks applovin,mintegral] [--keep-debug-error] [--keep-remote-debug] [--start-ms N]");
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

const mb = (n) => (n / 1048576).toFixed(2);

const a = parseArgs(process.argv.slice(2));
const html = readFileSync(a.input, "utf8");
let result;
try {
  result = wrapPlayable(html, {
    fileName: basename(a.input),
    ios: a.ios,
    android: a.android,
    networks: a.networks.split(",").map((s) => s.trim()).filter(Boolean),
    keepDebugError: a.keepDebugError,
    keepRemoteDebug: a.keepRemoteDebug,
    startMs: a.startMs,
  });
} catch (e) {
  fail(e.message);
}

result.logs.forEach((l) => console.log(l));
result.warnings.forEach((w) => console.error(`WARN: ${w}`));
mkdirSync(a.outdir, { recursive: true });

for (const o of result.outputs) {
  const out = join(a.outdir, o.fileName);
  const bytes = Buffer.from(o.html, "utf8");
  if (o.network === "mintegral") {
    const zip = await buildZip([{ name: "index.html", data: bytes }],
      (b) => deflateRawSync(b, { level: constants.Z_BEST_COMPRESSION }));
    writeFileSync(out, zip);
    console.log(`${out}  ${mb(zip.length)} MB (raw ${mb(bytes.length)} MB)`);
  } else {
    writeFileSync(out, bytes);
    console.log(`${out}  ${mb(bytes.length)} MB`);
  }
}
