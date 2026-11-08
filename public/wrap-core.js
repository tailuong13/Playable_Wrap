// Port of Tools/Playable/wrap_playable.py (branch PlayableAds/CF).
// Wraps a Luna Playground `unityads` single-file export for AppLovin / Mintegral.
// Pure string functions: shared by the browser UI (app.js) and the Node CLI (cli.js).

export const APPLOVIN_SHIM = `
<script>/* --- AppLovin wrapper (MRAID 2.0) --- */
(function () {
  var IOS = "__IOS__", AND = "__AND__";
  function patchLinks() {
    var c = window.$environment && window.$environment.packageConfig;
    if (!c) return;
    if (!c.iosLink && IOS) c.iosLink = IOS;
    if (!c.androidLink && AND) c.androidLink = AND;
  }
  patchLinks();
  window.addEventListener("luna:build", patchLinks);

  // AppLovin previewer expects an explicit CTA entry point.
  window.handleAppLovinCTA = function () {
    try { Luna.Unity.Playable.InstallFullGame(); }
    catch (e) { if (typeof mraid !== "undefined") mraid.open(); }
  };
})();
</script>
`;

export const MINTEGRAL_SHIM = `
<script>/* --- Mintegral (Mindworks / Playturbo) wrapper --- */
/* Mirrors Luna's own \`mintegral\` target wiring.
   SDK -> game : window.gameStart(), window.gameClose()   (we define them)
   game -> SDK : gameReady(), gameEnd(), install()        (the SDK defines them) */
(function () {
  // pi.logEvent calls pi.injectAdData(), which reads mraid.getMraidAdData() - throws on every
  // tracked event since Mintegral's harness never injects \`mraid\` (unlike AppLovin's).
  if (window.pi) window.pi.injectAdData = function () {};

  var IOS = "__IOS__", AND = "__AND__";
  var AUTOSTART_MS = __START_MS__;   // 0 = wait for the SDK, like the official build
  var started = false;

  function patchLinks() {
    var c = window.$environment && window.$environment.packageConfig;
    if (!c) return;
    if (!c.iosLink && IOS) c.iosLink = IOS;
    if (!c.androidLink && AND) c.androidLink = AND;
  }
  patchLinks();

  // Keep any stub the review harness installed before us.
  var prevStart = typeof window.gameStart === "function" ? window.gameStart : null;
  var prevClose = typeof window.gameClose === "function" ? window.gameClose : null;

  function resume() {
    if (started) return;
    started = true;
    window.dispatchEvent(new Event("luna:unsafe:resume"));
  }

  window.gameStart = function () {
    resume();
    if (prevStart) { try { prevStart.apply(this, arguments); } catch (e) {} }
  };
  window.gameClose = function () {
    window.dispatchEvent(new Event("luna:pause"));
    if (prevClose) { try { prevClose.apply(this, arguments); } catch (e) {} }
  };

  window.addEventListener("luna:started", function () {
    if (typeof window.gameReady === "function") { try { window.gameReady(); } catch (e) {} }
  });
  window.addEventListener("luna:ended", function () {
    if (typeof window.gameEnd === "function") { try { window.gameEnd(); } catch (e) {} }
  });

  window.addEventListener("luna:build", function () {
    patchLinks();
    // Hold the game until the SDK calls gameStart(), same as the official export.
    window.dispatchEvent(new Event("luna:unsafe:pause"));
    if (AUTOSTART_MS > 0) setTimeout(resume, AUTOSTART_MS);

    Bridge.ready(function () {
      var origInstall = Luna.Unity.Playable.InstallFullGame;
      Luna.Unity.Playable.InstallFullGame = function () {
        try { window.pi && window.pi.logCta(); } catch (e) {}
        if (typeof window.install === "function") { window.install(); return; }
        return origInstall.apply(this, arguments); // local/browser fallback
      };
    });
  });
})();
</script>
`;

export const MRAID_TAG = '<script src="mraid.js"></script>';
const DEBUG_WARN_CALL = "console.warn(Object.defineProperties(new Error,";
const REMOTE_DEBUG_MARKER = "insertYourRemoteDebuggingTokenHere";

/**
 * Remove Luna's devtools-probe `console.warn(new Error(...))`.
 * Not a real exception, but review tools (Playturbo/Mindworks) scan the console and flag any
 * Error object with a stack trace as a code exception.
 */
export function stripLunaDebugError(html) {
  const i = html.indexOf(DEBUG_WARN_CALL);
  if (i < 0) return { html, stripped: false };
  let j = i + "console.warn".length;
  let depth = 0;
  for (; j < html.length; j++) {             // walk to the matching ')'
    const ch = html[j];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= html.length) return { html, stripped: false };
  return { html: html.slice(0, i) + "void 0" + html.slice(j + 1), stripped: true };
}

/**
 * Remove Luna's remote-debugging block, which monkey-patches every console method to forward to
 * console.re. Dormant (empty token) but still trips review rule "Do not override global console
 * method". Luna's native `mintegral` target omits it - the generic `unityads` export does not.
 */
export function stripRemoteDebugConsoleOverride(html) {
  const i = html.indexOf(REMOTE_DEBUG_MARKER);
  if (i < 0) return { html, stripped: false };
  const start = html.lastIndexOf("<script>", i);
  const endTag = html.indexOf("</script>", i);
  if (start < 0 || endTag < 0) return { html, stripped: false };
  const end = endTag + "</script>".length;
  return { html: html.slice(0, start) + html.slice(end), stripped: true };
}

export function inject(html, shim, ios, android, addMraidTag, startMs = 1500) {
  // split/join = replace-all with no `$` pattern surprises in store URLs.
  shim = shim.split("__IOS__").join(ios)
             .split("__AND__").join(android)
             .split("__START_MS__").join(String(startMs));
  const idx = html.lastIndexOf("</body>");
  if (idx < 0) throw new Error("No </body> found - not a Luna single-file export?");
  let out = html.slice(0, idx) + shim + html.slice(idx);
  if (addMraidTag && !out.includes("mraid.js")) {
    const h = out.indexOf("</head>");
    if (h >= 0) out = out.slice(0, h) + MRAID_TAG + out.slice(h);
  }
  return out;
}

/**
 * Luna bakes luna.json `packages.default.orientation` into packageConfig. Anything but
 * "unspecified" locks the playable and Mintegral rejects it (Article 10).
 */
export function detectLockedOrientation(html) {
  const m = /orientation:"(portrait|landscape)"/.exec(html);
  return m ? m[1] : "";
}

export function detectLinks(html) {
  const ios = /iosLink:"([^"]*)"/.exec(html);
  const android = /androidLink:"([^"]*)"/.exec(html);
  return { ios: ios ? ios[1] : "", android: android ? android[1] : "" };
}

export function outputBaseName(fileName) {
  return fileName.replace(/\.[^./\\]*$/, "").split(/[\\/]/).pop().replace(/ /g, "_");
}

/**
 * Whole pipeline, same order and messages as the Python script.
 * @returns {{ logs: string[], warnings: string[], outputs: {network, fileName, html}[] }}
 *          Mintegral output is the raw index.html - the caller zips it.
 */
export function wrapPlayable(input, opts = {}) {
  const {
    fileName = "playable.html",
    ios: iosArg = "",
    android: androidArg = "",
    networks = ["applovin", "mintegral"],
    keepDebugError = false,
    keepRemoteDebug = false,
    startMs = 0,
  } = opts;

  const logs = [];
  const warnings = [];
  let html = input;

  if (!keepDebugError) {
    const r = stripLunaDebugError(html);
    html = r.html;
    logs.push(`Luna [DEBUGGING] console Error: ${r.stripped ? "removed" : "NOT FOUND"}`);
  }
  if (!keepRemoteDebug) {
    const r = stripRemoteDebugConsoleOverride(html);
    html = r.html;
    logs.push(`Luna remote-debug console override: ${r.stripped ? "removed" : "NOT FOUND"}`);
  }

  const baked = detectLinks(html);
  const ios = iosArg || baked.ios;
  const android = androidArg || baked.android;
  if (!ios) warnings.push("iosLink is empty - CTA on iOS traffic will open nothing.");

  const name = outputBaseName(fileName);
  const outputs = [];

  if (networks.includes("applovin")) {
    outputs.push({
      network: "applovin",
      fileName: `${name}_applovin.html`,
      html: inject(html, APPLOVIN_SHIM, ios, android, true),
    });
  }

  if (networks.includes("mintegral")) {
    const locked = detectLockedOrientation(html);
    if (locked) {
      warnings.push(`build is locked to '${locked}' (luna.json packages.default.orientation). ` +
                    `Mintegral rejects it - set "unspecified" and rebuild.`);
    }
    outputs.push({
      network: "mintegral",
      fileName: `${name}_mintegral.zip`,
      html: inject(html, MINTEGRAL_SHIM, ios, android, false, startMs),
    });
  }

  return { logs, warnings, outputs, links: { ios, android, baked } };
}
