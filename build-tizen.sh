#!/usr/bin/env bash
# Build a standalone Samsung Tizen TV app (.wgt) from Retlix.
# Usage: ./build-tizen.sh [SERVER_IP]
set -euo pipefail
cd "$(dirname "$0")"

IP="${1:-$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')}"
echo "📺 Building Retlix Tizen app (backend: http://$IP:3000)"

# 1) Build frontend with relative paths
node -e "
const fs = require('fs');
let c = fs.readFileSync('vite.config.js','utf8');
if (!c.includes(\"base: './'\")) {
  c = c.replace('build: {', \"base: './',\\n  build: {\");
  fs.writeFileSync('vite.config.js', c);
}"
npm run build 2>&1 | tail -3
node -e "
const fs = require('fs');
let c = fs.readFileSync('vite.config.js','utf8');
c = c.replace(\"base: './',\\n  \", '');
fs.writeFileSync('vite.config.js', c);"

# 2) Prepare tizen-build
OUT="tizen-build"
rm -rf "$OUT"
mkdir -p "$OUT/assets"
cp dist/assets/* "$OUT/assets/"
cp tizen/config.xml "$OUT/"
cp tizen/icon.png "$OUT/"
cp tizen/banner.png "$OUT/"

# 3) Post-process CSS: inline variables + fix gap for Chrome 47
CSS_SRC=$(ls dist/assets/index-*.css)
CSS_NAME=$(basename "$CSS_SRC")
node -e "
const fs = require('fs');
let css = fs.readFileSync('$CSS_SRC', 'utf8');
const vars = {
  '--red': '#e50914', '--red-hover': '#f6121d',
  '--bg': '#141414', '--bg-2': '#181818',
  '--text': '#fff', '--muted': '#b3b3b3',
  '--card-radius': '6px', '--nav-h': '68px'
};
for (const [k, v] of Object.entries(vars)) {
  const esc = k.replace(/[-]/g, '\\\\-');
  css = css.replace(new RegExp('var\\\\(' + esc + '\\\\)', 'g'), v);
}
css = css.replace(/:root\{[^}]*\}/, '');
// Remove @supports blocks — Chrome 47 doesn't support them properly
css = css.replace(/@supports\s*\([^)]*\)\s*\{[^}]*\}/g, '');
// Remove flattened overrides that undo the padding-top fallback
css = css.replace(/\.card\{height:auto;padding-top:0\}/g, '');
css = css.replace(/\.card\.poster\{padding-top:0\}/g, '');
css = css.replace(/\.modal-hero\{height:auto;padding-top:0\}/g, '');
// Replace min(Xpx, Y%) with Y%;max-width:Xpx (Chrome 47 doesn't support min())
css = css.replace(/width:\s*min\((\d+px),\s*(\d+%?)\)/g, 'width:\$2;max-width:\$1');
// Replace clamp(min, preferred, max) with just the preferred value as fallback
css = css.replace(/font-size:\s*clamp\([^,]+,\s*([^,]+),\s*[^)]+\)/g, 'font-size:\$1');
// Card children need absolute positioning inside the padding-top box (non-TV fallback)
css += '\\n.card img,.card-fallback,.card-playhint,.card-hovercap{position:absolute;top:0;left:0;width:100%;height:100%}';
css += '\\n.nav-links>*+*{margin-left:20px}.nav-right>*+*{margin-left:18px}.hero-actions>*+*{margin-left:12px}.hero-meta>*+*{margin-left:12px}.pl-controls>*+*{margin-left:14px}.pl-center>*+*{margin-left:34px}.modal-meta>*+*{margin-left:14px}.chips>*+*{margin-left:8px}.toolbar>*+*{margin-left:10px}.loader>*+*{margin-left:14px}.page-head>*+*{margin-left:16px}.sync-counts>*+*{margin-left:26px}.pl-vol>*+*{margin-left:4px}.pl-popover>*+*{margin-left:30px}.search-bar>*+*{margin-left:12px}.pl-ep-head>*+*{margin-left:14px}.kbd-actions>*+*{margin-left:8px}.tv-toggle>*+*{margin-left:12px}.row-track>*+*{margin-left:8px}.cast-track>*+*{margin-left:14px}.nav>*+*{margin-left:26px}';
fs.writeFileSync('$OUT/assets/$CSS_NAME', css);
console.log('CSS: variables inlined + gap polyfilled');
"

# 4) Get legacy JS filenames
POLYFILL=$(basename "$(ls dist/assets/polyfills-legacy-*.js)")
LEGACY=$(basename "$(ls dist/assets/index-legacy-*.js)")

# 5) Create standalone Tizen index.html
cat > "$OUT/index.html" << HTMLEOF
<!DOCTYPE html>
<html lang="es" class="tv">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="theme-color" content="#141414"/>
  <title>Retlix</title>
  <script type="text/javascript" src="\$WEBAPIS/webapis/webapis.js"></script>
  <link rel="stylesheet" href="./assets/$CSS_NAME">
  <script>
    try{if(!localStorage.getItem("retlix-server"))localStorage.setItem("retlix-server","http://$IP:3000")}catch(e){}
    try{localStorage.setItem("retlix_tv","1")}catch(e){}
    // Interface language: saved preference > TV/browser language > Spanish fallback.
    try{
      var rl=localStorage.getItem("retlix-lang");
      if(!rl){var nl=(navigator.language||"es").slice(0,2).toLowerCase();rl=(nl==="it"||nl==="en"||nl==="es")?nl:"es";}
      document.documentElement.lang=rl;
      window.__retlixLang=rl;
    }catch(e){window.__retlixLang="es";}
    // Pre-configure Xtream provider for direct streaming (no server needed)
    // Edit the line below with your own credentials before building:
    // try{if(!localStorage.getItem("retflix-provider"))localStorage.setItem("retflix-provider",JSON.stringify({url:"http://your-provider.com",username:"your_user",password:"your_pass"}))}catch(e){}
  </script>
</head>
<body>
  <!-- Instant splash — visible before JS loads -->
  <div id="splash" style="position:fixed;top:0;left:0;right:0;bottom:0;background:#000;display:-webkit-flex;display:flex;-webkit-flex-direction:column;flex-direction:column;-webkit-align-items:center;align-items:center;-webkit-justify-content:center;justify-content:center;z-index:99999">
    <div style="color:#e50914;font-size:96px;font-weight:900;letter-spacing:8px;-webkit-animation:spl 1.5s ease forwards;animation:spl 1.5s ease forwards">RETFLIX</div>
    <div style="width:320px;height:6px;background:#333;border-radius:6px;overflow:hidden;margin-top:48px">
      <div style="height:100%;background:#e50914;border-radius:6px;-webkit-animation:splbar 4s ease-in-out forwards;animation:splbar 4s ease-in-out forwards"></div>
    </div>
    <div id="splash-msg" style="color:#888;font-size:28px;margin-top:24px">Cargando…</div>
  </div>
  <style>
    @-webkit-keyframes spl{0%{opacity:0;-webkit-transform:scale(.6)}30%{opacity:1;-webkit-transform:scale(1.05)}50%{-webkit-transform:scale(1)}100%{opacity:1;-webkit-transform:scale(1)}}
    @keyframes spl{0%{opacity:0;transform:scale(.6)}30%{opacity:1;transform:scale(1.05)}50%{transform:scale(1)}100%{opacity:1;transform:scale(1)}}
    @-webkit-keyframes splbar{0%{width:0}50%{width:60%}100%{width:100%}}
    @keyframes splbar{0%{width:0}50%{width:60%}100%{width:100%}}
  </style>
  <div id="root"></div>
  <script>
    // Register Samsung TV remote control keys
    document.addEventListener("DOMContentLoaded", function() {
      try {
        var sm=document.getElementById("splash-msg");
        var sl=window.__retlixLang||"es";
        if(sm) sm.textContent=sl==="it"?"Caricamento…":(sl==="en"?"Loading…":"Cargando…");
      } catch(e) {}
      try {
        if (window.tizen && window.tizen.tvinputdevice) {
          var keys = ["MediaPlay","MediaPause","MediaPlayPause","MediaStop",
                       "MediaRewind","MediaFastForward","MediaTrackPrevious","MediaTrackNext",
                       "ColorF0Red","ColorF1Green","ColorF2Yellow","ColorF3Blue",
                       "ChannelUp","ChannelDown","ChannelList","PreviousChannel",
                       "0","1","2","3","4","5","6","7","8","9"];
          for (var i = 0; i < keys.length; i++) {
            try { tizen.tvinputdevice.registerKey(keys[i]); } catch(e) {}
          }
        }
      } catch(e) { console.log("TV keys registration:", e); }

      // Samsung TV uses keyCode, not e.key — map media keys to navigation codes
      document.addEventListener("keydown", function(e) {
        var code = e.keyCode || e.which;
        // Media keys → space (play/pause) or arrows (rew/ff)
        var mediaMap = {415: 32, 19: 32, 10252: 32, 412: 37, 417: 39, 413: 27};
        if (mediaMap[code]) {
          e.preventDefault();
          e.stopPropagation();
          var evt = document.createEvent("KeyboardEvent");
          if (evt.initKeyboardEvent) {
            evt.initKeyboardEvent("keydown", true, true, window, "", 0, false, false, false, false);
          }
          Object.defineProperty(evt, "keyCode", {get: function(){return mediaMap[code];}});
          document.activeElement.dispatchEvent(evt);
        }
        // Back/Return button (Samsung = 10009) — handled by React app (useTv.js)
        // Only preventDefault to stop the Tizen app from closing
        if (code === 10009) {
          e.preventDefault();
        }
      }, true);
    });
  </script>
  <script src="./assets/$POLYFILL"></script>
  <script>System.import("./assets/$LEGACY")</script>
</body>
</html>
HTMLEOF

echo "✅ Build complete: $OUT/"
