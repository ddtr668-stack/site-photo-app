"""web/index.html (claude.ai 페이지와 같은 화면) → 앱용 app/src/main/assets/index.html.

CDN 스크립트를 앱에 넣어 둔 파일로 바꾸고, 페이지 뼈대(doctype/head)를 붙인다.
"""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = (root / "web" / "index.html").read_text(encoding="utf-8")

swap = {
    "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js": "react.js",
    "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js": "react-dom.js",
    "https://unpkg.com/htm@3.1.1/dist/htm.umd.js": "htm.js",
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js": "jspdf.js",
}
for a, b in swap.items():
    assert a in src, a
    src = src.replace(a, b)

page = (
    "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
    "<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}"
    "[hidden]{display:none!important}</style></head><body>\n"
    + src
    + "\n</body></html>\n"
)
(root / "app" / "src" / "main" / "assets" / "index.html").write_text(page, encoding="utf-8")
print("ok", len(page))
