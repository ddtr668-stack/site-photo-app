# 상규 도면뷰어 (Android)

DWG·DXF 도면을 폰에서 보고, 거리·면적을 재고, PDF나 사진으로 저장·공유하는 개인용 앱.

- 화면은 `web/` 폴더의 HTML 앱(그대로 APK의 assets에 들어감). 도면 해석은 LibreDWG를 WebAssembly로 만든 `@mlightcad/libredwg-web`(GPL-3.0)을 쓴다.
- 카톡·파일관리자에서 DWG/DXF 파일을 "다른 앱으로 열기 → 상규 도면뷰어"로 열 수 있다.
- 최근 연 도면 15개는 폰 안(앱 저장소)에 보관된다. 앱을 지우면 함께 지워진다.
- PDF·PNG는 다운로드/상규도면뷰어 폴더에 저장하거나 카톡 등으로 공유.
- `main`에 push하면 GitHub Actions가 서명된 APK를 빌드해 Releases에 올린다.

## 알려진 한계
- LibreDWG가 읽지 못하는 일부 DWG(특히 R12 이전, 일부 손상 파일)는 열리지 않는다.
- 캐드 전용 SHX 글꼴 대신 폰 글꼴로 그리므로 글자 폭·위치가 조금 다를 수 있다.
- 모형 공간(Model)만 보여준다. 배치(Layout/종이 공간)는 아직 없다.
- 외부 참조(XREF)·이미지·3D 솔리드는 그리지 않는다.
