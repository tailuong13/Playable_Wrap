import {
  wrapPlayable, detectLinks, detectLockedOrientation, MRAID_TAG,
} from "./wrap-core.js";
import { buildZip, deflateRawBrowser } from "./zip.js";

const $ = (id) => document.getElementById(id);

const state = {
  file: null,          // { name, size, html }
  outputs: [],         // { network, fileName, html, blob, url }
  previewUrl: null,
  previewNetwork: null,
  previewHtml: null,
  landscape: false,
};

// ---------- input ----------

const drop = $("drop");
const fileInput = $("fileInput");

fileInput.addEventListener("change", () => fileInput.files[0] && loadFile(fileInput.files[0]));
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => {
  e.preventDefault();
  drop.classList.add("over");
}));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => {
  e.preventDefault();
  drop.classList.remove("over");
}));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

async function loadFile(f) {
  const html = await f.text();
  state.file = { name: f.name, size: f.size, html };

  $("fileName").textContent = f.name;
  $("fileSize").textContent = fmtMB(f.size);
  $("fileInfo").classList.remove("hidden");

  const links = detectLinks(html);
  const locked = detectLockedOrientation(html);
  const items = [
    check(html.includes("</body>"), "Có </body> (single-file export)", "Không thấy </body> - không phải single-file export?"),
    check(!!links.ios, `iosLink bake sẵn: ${links.ios || ""}`, "iosLink trống trong build", "warn"),
    check(!!links.android, `androidLink bake sẵn: ${links.android || ""}`, "androidLink trống trong build", "warn"),
    check(!locked, "Orientation: unspecified (OK cho Mintegral)", `Orientation khoá '${locked}' - Mintegral sẽ từ chối`, "warn"),
    info(html.includes("console.warn(Object.defineProperties(new Error,"), "Có Luna devtools-probe console Error (sẽ gỡ)"),
    info(html.includes("insertYourRemoteDebuggingTokenHere"), "Có block remote-debug override console (sẽ gỡ)"),
  ].filter(Boolean);
  $("detectList").innerHTML = items.join("");

  $("iosHint").textContent = links.ios ? `Để trống = dùng ${links.ios}` : "Build không có iosLink - nên điền";
  $("androidHint").textContent = links.android ? `Để trống = dùng ${links.android}` : "Build không có androidLink";
  $("wrapBtn").disabled = false;
}

function check(ok, okText, badText, badLevel = "bad") {
  return `<li class="${ok ? "ok" : badLevel}">${escapeHtml(ok ? okText : badText)}</li>`;
}
function info(present, text) {
  return present ? `<li class="info">${escapeHtml(text)}</li>` : "";
}

// ---------- wrap ----------

$("wrapBtn").addEventListener("click", runWrap);

async function runWrap() {
  if (!state.file) return;
  const btn = $("wrapBtn");
  btn.disabled = true;
  btn.textContent = "Đang wrap…";

  try {
    const networks = [];
    if ($("netApplovin").checked) networks.push("applovin");
    if ($("netMintegral").checked) networks.push("mintegral");
    if (!networks.length) throw new Error("Chọn ít nhất 1 network.");

    const result = wrapPlayable(state.file.html, {
      fileName: state.file.name,
      ios: $("ios").value.trim(),
      android: $("android").value.trim(),
      networks,
      keepDebugError: $("keepDebugError").checked,
      keepRemoteDebug: $("keepRemoteDebug").checked,
      startMs: parseInt($("startMs").value, 10) || 0,
    });

    clearOutputs();
    const enc = new TextEncoder();
    const lines = [...result.logs];

    for (const o of result.outputs) {
      const bytes = enc.encode(o.html);
      if (o.network === "mintegral") {
        const zip = await buildZip([{ name: "index.html", data: bytes }], deflateRawBrowser);
        o.blob = new Blob([zip], { type: "application/zip" });
        lines.push(`${o.fileName}  ${fmtMB(zip.length)} (raw ${fmtMB(bytes.length)})`);
      } else {
        o.blob = new Blob([bytes], { type: "text/html" });
        lines.push(`${o.fileName}  ${fmtMB(bytes.length)}`);
      }
      o.url = URL.createObjectURL(o.blob);
      state.outputs.push(o);
    }

    renderLog(lines, result.warnings);
    renderOutputs();
  } catch (err) {
    renderLog([], [err.message || String(err)], true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Wrap playable";
  }
}

function clearOutputs() {
  for (const o of state.outputs) URL.revokeObjectURL(o.url);
  state.outputs = [];
}

function renderLog(lines, warnings, isError = false) {
  const log = $("log");
  log.classList.remove("empty");
  log.innerHTML =
    lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("") +
    warnings.map((w) => `<div class="${isError ? "err" : "warn"}">${isError ? "ERROR" : "WARN"}: ${escapeHtml(w)}</div>`).join("");
}

function renderOutputs() {
  const box = $("outputs");
  box.innerHTML = state.outputs.map((o, i) => `
    <div class="output">
      <div class="output-meta">
        <span class="net net-${o.network}">${o.network === "applovin" ? "AppLovin" : "Mintegral"}</span>
        <span class="output-name">${escapeHtml(o.fileName)}</span>
        <span class="muted">${fmtMB(o.blob.size)}</span>
      </div>
      <div class="output-actions">
        <a class="btn small" href="${o.url}" download="${escapeHtml(o.fileName)}">Download</a>
        <button class="btn small ghost" data-preview="${i}">Preview</button>
      </div>
    </div>`).join("");
  box.querySelectorAll("[data-preview]").forEach((b) =>
    b.addEventListener("click", () => preview(state.outputs[+b.dataset.preview])));
}

// ---------- preview ----------

/**
 * Preview-only harness, injected first in <head>: mocks the network SDK and reports Luna
 * lifecycle / CTA / errors to this page. Never part of the downloaded files.
 */
function harness(network) {
  const sdk = network === "applovin" ? `
  var ready = [];
  window.mraid = {
    getVersion: function () { return "2.0"; },
    getState: function () { return "default"; },
    isViewable: function () { return true; },
    getPlacementType: function () { return "interstitial"; },
    addEventListener: function (n, fn) { if (n === "ready") setTimeout(fn, 0); else if (n === "viewableChange") setTimeout(function () { fn(true); }, 0); },
    removeEventListener: function () {},
    open: function (u) { send("cta", "mraid.open(" + (u || "") + ")"); },
    close: function () { send("sdk", "mraid.close()"); },
    useCustomClose: function () {},
    expand: function () {},
    getScreenSize: function () { return { width: innerWidth, height: innerHeight }; },
    getMaxSize: function () { return { width: innerWidth, height: innerHeight }; },
    getCurrentPosition: function () { return { x: 0, y: 0, width: innerWidth, height: innerHeight }; },
    getDefaultPosition: function () { return { x: 0, y: 0, width: innerWidth, height: innerHeight }; },
    supports: function () { return false; }
  };` : `
  window.gameReady = function () { send("sdk", "gameReady()"); };
  window.gameEnd = function () { send("sdk", "gameEnd()"); };
  window.install = function () { send("cta", "install()"); };`;

  return `<script>/* playable-wrapper preview harness */
(function () {
  function send(kind, text) { try { parent.postMessage({ __pw: 1, kind: kind, text: String(text) }, "*"); } catch (e) {} }
  window.addEventListener("error", function (e) { send("error", (e.message || "error") + (e.filename ? " @" + e.filename.slice(-40) + ":" + e.lineno : "")); });
  window.addEventListener("unhandledrejection", function (e) { send("error", "unhandled rejection: " + (e.reason && e.reason.message || e.reason)); });
  ["luna:build", "luna:started", "luna:ended", "luna:pause", "luna:resume", "luna:unsafe:pause", "luna:unsafe:resume"]
    .forEach(function (n) { window.addEventListener(n, function () { send("luna", n); }); });
  var origOpen = window.open;
  window.open = function (u) { send("cta", "window.open(" + (u || "") + ")"); return null; };
  ${sdk}
  send("sdk", "${network} mock ready");
})();
</script>`;
}

function buildPreviewHtml(o) {
  let html = o.html;
  if (o.network === "applovin") html = html.replace(MRAID_TAG, "");   // blob URL cannot load mraid.js - mocked instead
  const h = /<head[^>]*>/i.exec(html);
  const tag = harness(o.network);
  return h ? html.slice(0, h.index + h[0].length) + tag + html.slice(h.index + h[0].length) : tag + html;
}

function preview(o) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewNetwork = o.network;
  state.previewHtml = buildPreviewHtml(o);
  state.previewUrl = URL.createObjectURL(new Blob([state.previewHtml], { type: "text/html" }));

  $("events").innerHTML = "";
  addEvent("sdk", `Preview ${o.fileName}`);
  $("frame").src = state.previewUrl;
  $("deviceEmpty").classList.add("hidden");
  $("reloadBtn").disabled = false;
  $("sdkBar").classList.toggle("hidden", o.network !== "mintegral");
}

$("reloadBtn").addEventListener("click", () => {
  if (!state.previewUrl) return;
  $("events").innerHTML = "";
  $("frame").src = "about:blank";
  requestAnimationFrame(() => { $("frame").src = state.previewUrl; });
});

$("sdkStart").addEventListener("click", () => callFrame("gameStart"));
$("sdkClose").addEventListener("click", () => callFrame("gameClose"));

function callFrame(fn) {
  const w = $("frame").contentWindow;
  try {
    if (w && typeof w[fn] === "function") { w[fn](); addEvent("sdk", `→ ${fn}()`); }
    else addEvent("error", `${fn}() chưa có (game chưa load xong?)`);
  } catch (e) {
    addEvent("error", `${fn}(): ${e.message}`);
  }
}

window.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.__pw) addEvent(d.kind, d.text);
});

function addEvent(kind, text) {
  const li = document.createElement("li");
  li.className = `ev ev-${kind}`;
  const t = new Date();
  li.innerHTML = `<span class="ev-time">${t.toTimeString().slice(0, 8)}</span><span class="ev-kind">${kind}</span><span class="ev-text">${escapeHtml(text)}</span>`;
  const list = $("events");
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}

$("clearEvents").addEventListener("click", () => { $("events").innerHTML = ""; });

// ---------- device frame ----------

$("deviceSelect").addEventListener("change", fitDevice);
$("rotateBtn").addEventListener("click", () => { state.landscape = !state.landscape; fitDevice(); });
// The stage settles its height after layout/fonts - refit on every stage resize, not just window resize.
new ResizeObserver(fitDevice).observe($("stage"));

function fitDevice() {
  let [w, h] = $("deviceSelect").value.split("x").map(Number);
  if (state.landscape) [w, h] = [h, w];
  const stage = $("stage");
  const pad = 40;   // room for the 8px bezel + shadow
  const scale = Math.min((stage.clientWidth - pad) / w, (stage.clientHeight - pad) / h, 1);
  const device = $("device");
  device.style.width = `${w}px`;
  device.style.height = `${h}px`;
  device.style.transform = `scale(${scale})`;
}
fitDevice();

// ---------- utils ----------

function fmtMB(bytes) { return `${(bytes / 1048576).toFixed(2)} MB`; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
