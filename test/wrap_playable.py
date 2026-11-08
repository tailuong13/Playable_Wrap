#!/usr/bin/env python3
"""Wrap a Luna Playground `unityads` single-file export for AppLovin / Mintegral.

Usage:
    python3 wrap_playable.py <input.html> -o <outdir> \
        [--ios https://apps.apple.com/app/id...] \
        [--android https://play.google.com/store/apps/details?id=...] \
        [--networks applovin,mintegral]

Output:
    <outdir>/<name>_applovin.html
    <outdir>/<name>_mintegral.zip   (index.html at zip root)
"""

import argparse
import os
import re
import sys
import zipfile

APPLOVIN_SHIM = """
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
"""

MINTEGRAL_SHIM = """
<script>/* --- Mintegral (Mindworks / Playturbo) wrapper --- */
/* Mirrors Luna's own `mintegral` target wiring.
   SDK -> game : window.gameStart(), window.gameClose()   (we define them)
   game -> SDK : gameReady(), gameEnd(), install()        (the SDK defines them) */
(function () {
  // pi.logEvent calls pi.injectAdData(), which reads mraid.getMraidAdData() - throws on every
  // tracked event since Mintegral's harness never injects `mraid` (unlike AppLovin's).
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
"""

MRAID_TAG = '<script src="mraid.js"></script>'


DEBUG_WARN_CALL = "console.warn(Object.defineProperties(new Error,"


def strip_luna_debug_error(html):
    """Remove Luna's devtools-probe `console.warn(new Error(...))`.

    It is not a real exception, but review tools (Playturbo/Mindworks) scan the
    console and flag any Error object with a stack trace as a code exception.
    """
    i = html.find(DEBUG_WARN_CALL)
    if i < 0:
        return html, False
    j = i + len("console.warn")
    depth = 0
    while j < len(html):                     # walk to the matching ')'
        if html[j] == "(":
            depth += 1
        elif html[j] == ")":
            depth -= 1
            if depth == 0:
                break
        j += 1
    else:
        return html, False
    return html[:i] + "void 0" + html[j + 1:], True


REMOTE_DEBUG_MARKER = "insertYourRemoteDebuggingTokenHere"


def strip_remote_debug_console_override(html):
    """Remove Luna's remote-debugging block, which monkey-patches every
    console.{debug,trace,info,log,warn,error} method to forward to console.re.

    Dormant (the token is empty) but the override itself still trips review
    rule "Do not override global console method". Luna's native `mintegral`
    export target already omits this block entirely - the generic `unityads`
    export we wrap does not, so strip it here.
    """
    i = html.find(REMOTE_DEBUG_MARKER)
    if i < 0:
        return html, False
    start = html.rfind("<script>", 0, i)
    end = html.find("</script>", i) + len("</script>")
    if start < 0 or end < len("</script>"):
        return html, False
    return html[:start] + html[end:], True


def inject(html, shim, ios, android, add_mraid_tag, start_ms=1500):
    shim = (shim.replace("__IOS__", ios)
                .replace("__AND__", android)
                .replace("__START_MS__", str(start_ms)))
    idx = html.rfind("</body>")
    if idx < 0:
        raise SystemExit("No </body> found - not a Luna single-file export?")
    out = html[:idx] + shim + html[idx:]
    if add_mraid_tag and "mraid.js" not in out:
        out = out.replace("</head>", MRAID_TAG + "</head>", 1)
    return out


def detect_locked_orientation(html):
    """Luna bakes luna.json `packages.default.orientation` into packageConfig.

    Anything but "unspecified" locks the playable to one orientation and Mintegral rejects it:
    "Can't be adapted to both landscape and portrait mode" (Article 10).
    See Docs/DEV_TRACK/CF/Bugs/26-10-12_mintegral-landscape-portrait.md.
    """
    m = re.search(r'orientation:"(portrait|landscape)"', html)
    return m.group(1) if m else ""


def detect_links(html):
    ios = re.search(r'iosLink:"([^"]*)"', html)
    android = re.search(r'androidLink:"([^"]*)"', html)
    return (ios.group(1) if ios else ""), (android.group(1) if android else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--outdir", default=".")
    ap.add_argument("--ios", default="")
    ap.add_argument("--android", default="")
    ap.add_argument("--networks", default="applovin,mintegral")
    ap.add_argument("--keep-debug-error", action="store_true",
                    help="keep Luna's devtools-probe console Error (review tools flag it)")
    ap.add_argument("--keep-remote-debug", action="store_true",
                    help="keep Luna's remote-debugging console-method override (review tools flag it)")
    ap.add_argument("--start-ms", type=int, default=0,
                    help="Mintegral: auto-resume after N ms if the SDK never calls gameStart() "
                         "(0 = wait forever, matches Luna's official export)")
    a = ap.parse_args()

    html = open(a.input, encoding="utf-8", errors="replace").read()
    if not a.keep_debug_error:
        html, stripped = strip_luna_debug_error(html)
        print("Luna [DEBUGGING] console Error: %s" % ("removed" if stripped else "NOT FOUND"))
    if not a.keep_remote_debug:
        html, stripped = strip_remote_debug_console_override(html)
        print("Luna remote-debug console override: %s" % ("removed" if stripped else "NOT FOUND"))
    ios_b, and_b = detect_links(html)
    ios, android = a.ios or ios_b, a.android or and_b
    if not ios:
        print("WARN: iosLink is empty - CTA on iOS traffic will open nothing.", file=sys.stderr)

    os.makedirs(a.outdir, exist_ok=True)
    name = os.path.splitext(os.path.basename(a.input))[0].replace(" ", "_")
    nets = [n.strip() for n in a.networks.split(",") if n.strip()]

    if "applovin" in nets:
        out = os.path.join(a.outdir, name + "_applovin.html")
        data = inject(html, APPLOVIN_SHIM, ios, android, add_mraid_tag=True)
        open(out, "w", encoding="utf-8").write(data)
        print("%s  %.2f MB" % (out, len(data.encode()) / 1048576))

    if "mintegral" in nets:
        locked = detect_locked_orientation(html)
        if locked:
            print("WARN: build is locked to '%s' (luna.json packages.default.orientation). "
                  "Mintegral rejects it - set \"unspecified\" and rebuild." % locked, file=sys.stderr)
        out = os.path.join(a.outdir, name + "_mintegral.zip")
        data = inject(html, MINTEGRAL_SHIM, ios, android, add_mraid_tag=False,
                      start_ms=a.start_ms)
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            z.writestr("index.html", data)
        print("%s  %.2f MB (raw %.2f MB)"
              % (out, os.path.getsize(out) / 1048576, len(data.encode()) / 1048576))


if __name__ == "__main__":
    main()
