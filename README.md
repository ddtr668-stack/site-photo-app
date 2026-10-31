# 현장 사진대지 (Android)

현장별로 사진을 찍고 공종·위치·공정·내용을 적어 A4 사진대지 PDF로 저장·공유하는 개인용 앱.

- 화면은 `web/index.html`(claude.ai 페이지와 같은 React 앱). `tools/build_app_html.py`가 앱용 `app/src/main/assets/index.html`을 만든다.
- 현장·사진은 폰 안(앱 저장소, IndexedDB)에 저장된다. 앱을 지우면 함께 지워진다.
- PDF는 다운로드/현장사진대지 폴더에 저장하거나 카톡 등으로 공유.
- `main`에 push하면 GitHub Actions가 서명된 APK를 빌드해 Releases에 올린다.
