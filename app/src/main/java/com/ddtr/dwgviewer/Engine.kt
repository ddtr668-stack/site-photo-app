package com.ddtr.dwgviewer

/** 네이티브 도면 엔진 (libsgdb.so). 엔진 프로세스(:engine) 안에서만 쓴다. */
object Engine {
    /** 라이브러리를 불러왔는지 (arm64가 아닌 기기 등에서는 실패 → 예전 엔진으로) */
    val loaded: Boolean = try {
        System.loadLibrary("sgdb"); true
    } catch (t: Throwable) { false }

    /** 결과 long[6]: 0 성공/1 읽기 실패/2 쓰기 실패, 읽기 오류값, 객체 수, 블록 수, 바이트, ms */
    @JvmStatic
    external fun convert(inPath: String, outPath: String, dxf: Boolean): LongArray
}
