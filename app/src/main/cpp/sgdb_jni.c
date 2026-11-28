/* JNI: Engine.convert(in, out, dxf) → long[6] {결과, 읽기오류, 객체수, 블록수, 바이트, ms} */
#include <jni.h>
#include <time.h>

int sgdb_convert (const char *in, const char *out, int is_dxf,
                  unsigned long *stats, int *dwg_err);

JNIEXPORT jlongArray JNICALL
Java_com_ddtr_dwgviewer_Engine_convert (JNIEnv *env, jclass cls, jstring jin,
                                        jstring jout, jboolean dxf)
{
  const char *in = (*env)->GetStringUTFChars (env, jin, 0);
  const char *out = (*env)->GetStringUTFChars (env, jout, 0);
  unsigned long st[3] = { 0, 0, 0 };
  int derr = 0, r;
  struct timespec t0, t1;
  jlong v[6];
  jlongArray a;
  clock_gettime (CLOCK_MONOTONIC, &t0);
  r = sgdb_convert (in, out, dxf ? 1 : 0, st, &derr);
  clock_gettime (CLOCK_MONOTONIC, &t1);
  (*env)->ReleaseStringUTFChars (env, jin, in);
  (*env)->ReleaseStringUTFChars (env, jout, out);
  v[0] = r;
  v[1] = derr;
  v[2] = (jlong)st[0];
  v[3] = (jlong)st[1];
  v[4] = (jlong)st[2];
  v[5] = (jlong)((t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_nsec - t0.tv_nsec) / 1000000);
  a = (*env)->NewLongArray (env, 6);
  if (a)
    (*env)->SetLongArrayRegion (env, a, 0, 6, v);
  return a;
}
