// Byte-for-byte parity against the original Python script (test/wrap_playable.py, copied from
// branch PlayableAds/CF Tools/Playable/). Runs both on synthetic fixtures plus any real Luna export
// passed as argv: node test/parity.test.js [real_export.html ...]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..");
const PY = join(here, "wrap_playable.py");

const LUNA_FIXTURE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body>
<script>window.$environment={packageConfig:{iosLink:"__IOSB__",androidLink:"https://play.google.com/store/apps/details?id=x",orientation:"__ORI__"}};</script>
<script>(function(){var d=1;console.warn(Object.defineProperties(new Error,{message:{get:function(){d=2;return "[DEBUGGING]"}},toString:{value:function(){return (f(1)+(g(2)))}}}));})();</script>
<script>var token="insertYourRemoteDebuggingTokenHere";["log","warn"].forEach(function(m){console[m]=function(){}});</script>
<script>/* game ü 漢字 $& $1 */ var x = "</body" + ">";</script>
</body></html>`;

function fixture({ iosBaked = "", ori = "unspecified" } = {}) {
  return LUNA_FIXTURE.replace("__IOSB__", iosBaked).replace("__ORI__", ori);
}

function unzipIndex(buf) {
  // single entry: local header at 0
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error("not a zip");
  const method = dv.getUint16(8, true);
  const compSize = dv.getUint32(18, true);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const name = buf.subarray(30, 30 + nameLen).toString("utf8");
  const start = 30 + nameLen + extraLen;
  const comp = buf.subarray(start, start + compSize);
  return { name, data: method === 8 ? inflateRawSync(comp) : Buffer.from(comp) };
}

const cases = [
  { name: "defaults (links baked, no ios)", html: fixture(), args: [] },
  { name: "ios+android override", html: fixture({ iosBaked: "https://apps.apple.com/app/id1" }),
    args: ["--ios", "https://apps.apple.com/app/id9$&", "--android", "https://play.google.com/x?id=a&b=$1"] },
  { name: "locked portrait + start-ms", html: fixture({ ori: "portrait" }), args: ["--start-ms", "1500"] },
  { name: "keep debug blocks", html: fixture(), args: ["--keep-debug-error", "--keep-remote-debug"] },
  { name: "applovin only", html: fixture(), args: ["--networks", "applovin"] },
];
for (const real of process.argv.slice(2)) {
  cases.push({ name: `real: ${basename(real)}`, html: readFileSync(real, "utf8"), args: [], file: basename(real) });
}

let failed = 0;
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), "pw-parity-"));
  try {
    const input = join(dir, c.file || "My Playable.html");
    writeFileSync(input, c.html);
    const py = execFileSync("python3", [PY, input, "-o", join(dir, "py"), ...c.args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    const js = execFileSync("node", [join(root, "cli.js"), input, "-o", join(dir, "js"), ...c.args], { stdio: ["ignore", "pipe", "pipe"] }).toString();

    const base = basename(input).replace(/\.[^.]*$/, "").replace(/ /g, "_");
    const problems = [];
    const nets = c.args.includes("--networks") ? c.args[c.args.indexOf("--networks") + 1].split(",") : ["applovin", "mintegral"];

    if (nets.includes("applovin")) {
      const a = readFileSync(join(dir, "py", `${base}_applovin.html`));
      const b = readFileSync(join(dir, "js", `${base}_applovin.html`));
      if (!a.equals(b)) problems.push("applovin html differs");
    }
    if (nets.includes("mintegral")) {
      const a = unzipIndex(readFileSync(join(dir, "py", `${base}_mintegral.zip`)));
      const b = unzipIndex(readFileSync(join(dir, "js", `${base}_mintegral.zip`)));
      if (a.name !== "index.html" || b.name !== "index.html") problems.push("zip entry name");
      if (!a.data.equals(b.data)) problems.push("mintegral index.html differs");
    }
    const pyLines = py.split("\n").filter((l) => l.startsWith("Luna"));
    const jsLines = js.split("\n").filter((l) => l.startsWith("Luna"));
    if (pyLines.join("|") !== jsLines.join("|")) problems.push(`log differs: ${pyLines} vs ${jsLines}`);

    if (problems.length) { failed++; console.log(`FAIL  ${c.name}: ${problems.join("; ")}`); }
    else console.log(`ok    ${c.name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(failed ? `\n${failed} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
