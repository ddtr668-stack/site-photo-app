# 상규 도면뷰어 네이티브 엔진: LibreDWG(빠르게 고친 판) + sgdb(앱용 출력) + JNI
# libredwg 폴더는 빌드 때 받아서 libredwg.patch를 적용한다 (.github/workflows/build.yml)
cmake_minimum_required(VERSION 3.18)
project(sgdbnative C)

set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LIBREDWG_LIBONLY ON CACHE BOOL "" FORCE)
set(LIBREDWG_DISABLE_JSON ON CACHE BOOL "" FORCE)
set(LIBREDWG_DISABLE_WRITE OFF CACHE BOOL "" FORCE) # DXF 읽기와 R2007 해독에 필요
set(DISABLE_WERROR ON CACHE BOOL "" FORCE)
set(ENABLE_LTO OFF CACHE BOOL "" FORCE)
set(CMAKE_DISABLE_FIND_PACKAGE_Iconv ON) # 코드페이지는 LibreDWG 내장 표로 변환
add_subdirectory(libredwg)

add_library(sgdb SHARED sgdb.c sgdb_jni.c)
target_include_directories(sgdb PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/libredwg/include
  ${CMAKE_CURRENT_SOURCE_DIR}/libredwg/src
  ${CMAKE_CURRENT_BINARY_DIR}/libredwg/src)
target_compile_options(sgdb PRIVATE -O2)
target_link_libraries(sgdb redwg m)
if(ANDROID)
  target_link_libraries(sgdb log)
endif()
