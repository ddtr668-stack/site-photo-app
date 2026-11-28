/*
 * sgdb.c — 상규 도면뷰어 네이티브 엔진
 * LibreDWG로 DWG/DXF를 읽어, 앱(worker.js build())이 쓰는 모양 그대로
 * 간단한 바이너리(SGDB)로 내보낸다. 모형 공간 + 실제로 쓰이는 블록만 담는다.
 *
 * 값 표기(작은 엔디언):
 *   0 null, 1 false, 2 true, 3 f64, 4 i32, 5 문자열(u32 길이+UTF-8),
 *   6 배열 시작(8로 끝), 7 객체 시작(u16 키 번호 + 값 …, 0xFFFF로 끝),
 *   9 점2 {x,y}, 10 점3 {x,y,z}, 11 f64 배열(u32 개수+값), 12 문자열 참조(u32), 13 새 공용 문자열
 * 파일 머리: "SGDB" u32 판번호, u32 키 수, (u16 길이 + 이름) …
 *
 * GPL-3.0-or-later (LibreDWG와 같음)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "dwg.h"
#include "bits.h"

char *bit_TV_to_utf8 (const char *restrict src, const BITCODE_RS codepage);

extern int dwg_skip_eed;

#define SGDB_VERSION 1

/* ---------- 키 이름 표 ---------- */
#define KEYS(X)                                                               \
  X (header) X (tables) X (entries) X (LAYER) X (LTYPE) X (STYLE)            \
  X (BLOCK_RECORD) X (entities) X (type) X (layer) X (color) X (colorIndex)  \
  X (lineType) X (lineTypeScale) X (isVisible) X (name) X (handle)           \
  X (basePoint) X (off) X (frozen) X (pattern) X (elementLength)             \
  X (widthFactor) X (LTSCALE) X (DIMSCALE) X (DIMASZ) X (INSUNITS)           \
  X (startPoint) X (endPoint) X (extrusionDirection) X (center) X (radius)   \
  X (startAngle) X (endAngle) X (majorAxisEndPoint) X (axisRatio) X (flag)   \
  X (constantWidth) X (vertices) X (bulge) X (startWidth) X (endWidth)       \
  X (degree) X (knots) X (weights) X (controlPoints) X (fitPoints)           \
  X (corner1) X (corner2) X (corner3) X (corner4) X (position) X (uPixel)    \
  X (vPixel) X (imageSize) X (clippingBoundaryType)                          \
  X (clippingBoundaryPath) X (text) X (textHeight) X (rotation) X (xScale)   \
  X (yScale) X (obliqueAngle) X (styleName) X (generationFlag) X (halign)    \
  X (valign) X (flags) X (insertionPoint) X (direction)                      \
  X (attachmentPoint) X (rectWidth) X (lineSpacing) X (columnCount)          \
  X (rowCount) X (columnSpacing) X (rowSpacing) X (attribs)                  \
  X (blockRecordHandle) X (isArrowheadEnabled) X (arrowheadSize)             \
  X (contentScale) X (leaderLineColor) X (leaderSections) X (leaderLines)    \
  X (lastLeaderLinePoint) X (doglegEnabled) X (doglegVector)                 \
  X (doglegLength) X (hasMText) X (textContent) X (textAnchor) X (textColor) \
  X (textAttachmentPoint) X (textDirection) X (textRotation) X (textWidth)   \
  X (textLineSpacingFactor) X (hasBlock) X (blockContent)                    \
  X (blockContentId) X (transformationMatrix) X (numberOfLines) X (vertex)   \
  X (miterDirection) X (lines) X (segmentParams) X (boundaryPaths)           \
  X (hasBulge) X (edges) X (start) X (end) X (isCCW) X (lengthOfMinorAxis)   \
  X (fitDatum) X (weight) X (solidFill) X (patternName) X (gradientFlag)     \
  X (gradientColors) X (rgb) X (definitionLines) X (angle) X (base)          \
  X (offset) X (dashLengths) X (firstPoint) X (unitDirection) X (x) X (y)    \
  X (polyfaceIndex0) X (polyfaceIndex1) X (polyfaceIndex2)                   \
  X (polyfaceIndex3) X (stats)

#define KEY_ENUM(n) K_##n,
enum { KEYS (KEY_ENUM) K__COUNT };
#define KEY_NAME(n) #n,
static const char *key_names[] = { KEYS (KEY_NAME) };

/* ---------- 출력 버퍼 (가득 차면 파일로 내보냄) ---------- */
typedef struct
{
  unsigned char *p;
  size_t n, cap;
  FILE *fp;
  size_t total;
  int err;
} W;

static void
wflush (W *w)
{
  if (w->n && w->fp)
    {
      if (fwrite (w->p, 1, w->n, w->fp) != w->n)
        w->err = 1;
    }
  w->total += w->n;
  w->n = 0;
}
static inline void
wneed (W *w, size_t k)
{
  if (w->n + k > w->cap)
    {
      wflush (w);
      if (k > w->cap)
        {
          w->cap = k * 2;
          w->p = (unsigned char *)realloc (w->p, w->cap);
        }
    }
}
static inline void
wraw (W *w, const void *s, size_t k)
{
  wneed (w, k);
  memcpy (w->p + w->n, s, k);
  w->n += k;
}
static inline void
w8 (W *w, unsigned v)
{
  wneed (w, 1);
  w->p[w->n++] = (unsigned char)v;
}
static inline void
wu16 (W *w, uint16_t v)
{
  wraw (w, &v, 2);
}
static inline void
wu32 (W *w, uint32_t v)
{
  wraw (w, &v, 4);
}

/* 값 */
static inline void
v_null (W *w)
{
  w8 (w, 0);
}
static inline void
v_bool (W *w, int b)
{
  w8 (w, b ? 2 : 1);
}
static inline void
v_f64 (W *w, double d)
{
  w8 (w, 3);
  wraw (w, &d, 8);
}
static inline void
v_i32 (W *w, int32_t i)
{
  w8 (w, 4);
  wraw (w, &i, 4);
}
static inline void
v_str (W *w, const char *s)
{
  if (!s)
    {
      v_null (w);
      return;
    }
  {
    uint32_t n = (uint32_t)strlen (s);
    w8 (w, 5);
    wu32 (w, n);
    wraw (w, s, n);
  }
}
static inline void
v_pt2 (W *w, double x, double y)
{
  double a[2] = { x, y };
  w8 (w, 9);
  wraw (w, a, 16);
}
static inline void
v_pt3 (W *w, double x, double y, double z)
{
  double a[3] = { x, y, z };
  w8 (w, 10);
  wraw (w, a, 24);
}
static inline void
v_f64arr (W *w, const double *d, uint32_t n)
{
  w8 (w, 11);
  wu32 (w, d ? n : 0);
  if (d && n)
    wraw (w, d, (size_t)n * 8);
}
#define OBJ() w8 (w, 7)
#define ENDOBJ() wu16 (w, 0xFFFF)
#define ARR() w8 (w, 6)
#define ENDARR() w8 (w, 8)
#define K(name) wu16 (w, K_##name)

/* ---------- 공용 문자열 (층 이름, 블록 이름 …) ---------- */
typedef struct
{
  char *s;
  uint32_t id;
} SEnt;
typedef struct
{
  SEnt *t;
  uint32_t cap, n, next_id;
} STab;

static uint32_t
shash (const char *s)
{
  uint32_t h = 2166136261u;
  while (*s)
    {
      h ^= (unsigned char)*s++;
      h *= 16777619u;
    }
  return h;
}
static void
stab_grow (STab *st)
{
  uint32_t ncap = st->cap ? st->cap * 2 : 1024, i;
  SEnt *nt = (SEnt *)calloc (ncap, sizeof (SEnt));
  for (i = 0; i < st->cap; i++)
    if (st->t[i].s)
      {
        uint32_t j = shash (st->t[i].s) & (ncap - 1);
        while (nt[j].s)
          j = (j + 1) & (ncap - 1);
        nt[j] = st->t[i];
      }
  free (st->t);
  st->t = nt;
  st->cap = ncap;
}
/* 이름 값: 처음이면 13(새 문자열), 아니면 12(참조) */
static void
v_name (W *w, STab *st, const char *s)
{
  uint32_t j;
  if (!s)
    s = "";
  if ((st->n + 1) * 2 > st->cap)
    stab_grow (st);
  j = shash (s) & (st->cap - 1);
  while (st->t[j].s)
    {
      if (!strcmp (st->t[j].s, s))
        {
          w8 (w, 12);
          wu32 (w, st->t[j].id);
          return;
        }
      j = (j + 1) & (st->cap - 1);
    }
  st->t[j].s = strdup (s);
  st->t[j].id = st->next_id++;
  st->n++;
  {
    uint32_t n = (uint32_t)strlen (s);
    w8 (w, 13);
    wu32 (w, n);
    wraw (w, s, n);
  }
}

/* ---------- 문맥 ---------- */
typedef struct
{
  Dwg_Data *dwg;
  W *w;
  STab names;
  char **objname;      /* 객체 번호 → UTF-8 이름 (캐시) */
  unsigned char *need; /* 객체 번호 → 블록 필요 표시 (1 대기, 2 보냄) */
  BITCODE_BL *queue;
  BITCODE_BL qh, qt;
  int is_tu;
  /* 통계 */
  unsigned long nent, nblk;
} Ctx;

static char *
u8dup (Ctx *c, const char *s)
{
  if (!s)
    return NULL;
  if (c->is_tu)
    return bit_convert_TU ((BITCODE_TU)s);
  {
    /* R2004 이하: 도면 코드페이지(예: 한글 CP949) → UTF-8 */
    char *u = bit_TV_to_utf8 (s, c->dwg->header.codepage);
    if (u && u != s)
      return u;
    return strdup (s);
  }
}

/* 문자열 값(글자 내용) */
static void
v_text (Ctx *c, const char *s)
{
  W *w = c->w;
  if (!s)
    {
      v_null (w);
      return;
    }
  if (c->is_tu)
    {
      char *u = bit_convert_TU ((BITCODE_TU)s);
      v_str (w, u ? u : "");
      free (u);
    }
  else
    {
      char *u = bit_TV_to_utf8 (s, c->dwg->header.codepage);
      v_str (w, u ? u : s);
      if (u && u != s)
        free (u);
    }
}

static Dwg_Object *
refobj (Ctx *c, BITCODE_H ref)
{
  if (!ref)
    return NULL;
  if (ref->obj)
    return ref->obj;
  if (!ref->absolute_ref)
    return NULL;
  return dwg_resolve_handle_silent (c->dwg, ref->absolute_ref);
}

/* 표 객체(층·선종류·글꼴·블록)의 이름 */
static const char *
tblname (Ctx *c, Dwg_Object *o)
{
  if (!o || !o->tio.object)
    return NULL;
  if (c->objname[o->index])
    return c->objname[o->index];
  {
    const char *raw = NULL;
    switch (o->fixedtype)
      {
      case DWG_TYPE_LAYER:
        raw = o->tio.object->tio.LAYER->name;
        break;
      case DWG_TYPE_LTYPE:
        raw = o->tio.object->tio.LTYPE->name;
        break;
      case DWG_TYPE_STYLE:
        raw = o->tio.object->tio.STYLE->name;
        break;
      case DWG_TYPE_BLOCK_HEADER:
        {
          /* 이름 없는 블록(*U, *D …)은 번호가 BLOCK 객체 쪽에 있다 */
          Dwg_Object_BLOCK_HEADER *bh = o->tio.object->tio.BLOCK_HEADER;
          Dwg_Object *be = refobj (c, bh->block_entity);
          raw = bh->name;
          if (be && be->fixedtype == DWG_TYPE_BLOCK && be->tio.entity
              && be->tio.entity->tio.BLOCK->name
              && (!raw || !*raw || raw[0] == '*' || c->is_tu))
            raw = be->tio.entity->tio.BLOCK->name;
        }
        break;
      case DWG_TYPE_DIMSTYLE:
        raw = o->tio.object->tio.DIMSTYLE->name;
        break;
      default:
        return NULL;
      }
    c->objname[o->index] = raw ? u8dup (c, raw) : strdup ("");
    return c->objname[o->index];
  }
}

static void
v_handle (W *w, STab *st, Dwg_Object *o)
{
  char buf[32];
  snprintf (buf, sizeof buf, "%llX", (unsigned long long)o->handle.value);
  v_name (w, st, buf);
}

/* 블록이 필요하다고 표시하고 대기열에 넣기 */
static void
want_block (Ctx *c, Dwg_Object *b)
{
  if (!b || b->fixedtype != DWG_TYPE_BLOCK_HEADER)
    return;
  if (c->need[b->index])
    return;
  c->need[b->index] = 1;
  c->queue[c->qt++] = b->index;
}

/* MLEADER 색 → 앱이 쓰는 원시값 */
static uint32_t
mleader_raw (const Dwg_Color *col)
{
  unsigned m = col->method ? (unsigned)col->method : ((col->rgb >> 24) & 0xff);
  if (m == 0xc2)
    return 0xc2000000u | (col->rgb & 0xffffff);
  if (m == 0xc3)
    return 0xc3000000u | (col->index & 0xff);
  if (m == 0xc1)
    return 0xc1000000u;
  if (col->index >= 1 && col->index <= 255)
    return 0xc3000000u | (unsigned)col->index;
  if (col->index == 0)
    return 0xc1000000u;
  return 0xc0000000u;
}

static void
common (Ctx *c, Dwg_Object *o, const char *type)
{
  W *w = c->w;
  Dwg_Object_Entity *ent = o->tio.entity;
  Dwg_Object *lo;
  K (type);
  v_name (w, &c->names, type);
  lo = refobj (c, ent->layer);
  K (layer);
  v_name (w, &c->names, lo ? tblname (c, lo) : "0");
  K (colorIndex);
  v_i32 (w, ent->color.index);
  {
    unsigned m = ent->color.method ? (unsigned)ent->color.method
                                   : ((ent->color.rgb >> 24) & 0xff);
    if (m == 0xc2)
      {
        K (color);
        v_i32 (w, (int32_t)(ent->color.rgb & 0xffffff));
      }
  }
  {
    const char *lt = "";
    if (c->dwg->header.from_version >= R_2000)
      {
        switch (ent->ltype_flags)
          {
          case 1:
            lt = "ByBlock";
            break;
          case 2:
            lt = "Continuous";
            break;
          case 3:
            {
              Dwg_Object *t = refobj (c, ent->ltype);
              const char *n = t ? tblname (c, t) : NULL;
              lt = n ? n : "";
            }
            break;
          default:
            lt = "";
          }
      }
    else if (!ent->isbylayerlt)
      {
        Dwg_Object *t = refobj (c, ent->ltype);
        const char *n = t ? tblname (c, t) : NULL;
        lt = n ? n : "";
      }
    K (lineType);
    v_name (w, &c->names, lt);
  }
  if (ent->ltype_scale != 1.0)
    {
      K (lineTypeScale);
      v_f64 (w, ent->ltype_scale);
    }
  if (ent->invisible & 1)
    {
      K (isVisible);
      v_bool (w, 0);
    }
}

#define EXT(e)                                                                \
  K (extrusionDirection);                                                     \
  v_pt3 (w, (e).x, (e).y, (e).z)

static void emit_entity (Ctx *c, Dwg_Object *o);

static void
text_base (Ctx *c, const char *text_value, double insx, double insy, double alx, double aly,
           double height, double rot, double wf, double obl, BITCODE_H style,
           int gen, int ha, int va, BITCODE_BE ext)
{
  W *w = c->w;
  K (text);
  v_text (c, text_value);
  K (startPoint);
  v_pt2 (w, insx, insy);
  K (endPoint);
  v_pt2 (w, alx, aly);
  K (textHeight);
  v_f64 (w, height);
  K (rotation);
  v_f64 (w, rot);
  K (xScale);
  v_f64 (w, wf);
  K (obliqueAngle);
  v_f64 (w, obl);
  {
    Dwg_Object *so = refobj (c, style);
    const char *sn = so ? tblname (c, so) : NULL;
    if (sn)
      {
        K (styleName);
        v_name (w, &c->names, sn);
      }
  }
  K (generationFlag);
  v_i32 (w, gen);
  K (halign);
  v_i32 (w, ha);
  K (valign);
  v_i32 (w, va);
  EXT (ext);
}

static void
emit_hatch (Ctx *c, Dwg_Entity_HATCH *h)
{
  W *w = c->w;
  BITCODE_BL i, j;
  EXT (h->extrusion);
  K (patternName);
  v_text (c, h->name);
  K (solidFill);
  v_i32 (w, h->is_solid_fill ? 1 : 0);
  K (boundaryPaths);
  ARR ();
  for (i = 0; i < h->num_paths && h->paths; i++)
    {
      Dwg_HATCH_Path *p = &h->paths[i];
      if (!p->num_segs_or_paths)
        continue;
      OBJ ();
      K (flag);
      v_i32 (w, (int32_t)p->flag);
      if (p->flag & 2)
        {
          K (hasBulge);
          v_bool (w, p->bulges_present);
          K (vertices);
          ARR ();
          for (j = 0; j < p->num_segs_or_paths && p->polyline_paths; j++)
            {
              OBJ ();
              K (x);
              v_f64 (w, p->polyline_paths[j].point.x);
              K (y);
              v_f64 (w, p->polyline_paths[j].point.y);
              K (bulge);
              v_f64 (w, p->polyline_paths[j].bulge);
              ENDOBJ ();
            }
          ENDARR ();
        }
      else
        {
          K (edges);
          ARR ();
          for (j = 0; j < p->num_segs_or_paths && p->segs; j++)
            {
              Dwg_HATCH_PathSeg *s = &p->segs[j];
              switch (s->curve_type)
                {
                case 1:
                  OBJ ();
                  K (type);
                  v_i32 (w, 1);
                  K (start);
                  v_pt2 (w, s->first_endpoint.x, s->first_endpoint.y);
                  K (end);
                  v_pt2 (w, s->second_endpoint.x, s->second_endpoint.y);
                  ENDOBJ ();
                  break;
                case 2:
                  OBJ ();
                  K (type);
                  v_i32 (w, 2);
                  K (center);
                  v_pt2 (w, s->center.x, s->center.y);
                  K (radius);
                  v_f64 (w, s->radius);
                  K (startAngle);
                  v_f64 (w, s->start_angle);
                  K (endAngle);
                  v_f64 (w, s->end_angle);
                  K (isCCW);
                  v_bool (w, s->is_ccw);
                  ENDOBJ ();
                  break;
                case 3:
                  OBJ ();
                  K (type);
                  v_i32 (w, 3);
                  K (center);
                  v_pt2 (w, s->center.x, s->center.y);
                  K (end);
                  v_pt2 (w, s->endpoint.x, s->endpoint.y);
                  K (lengthOfMinorAxis);
                  v_f64 (w, s->minor_major_ratio);
                  K (startAngle);
                  v_f64 (w, s->start_angle);
                  K (endAngle);
                  v_f64 (w, s->end_angle);
                  K (isCCW);
                  v_bool (w, s->is_ccw);
                  ENDOBJ ();
                  break;
                case 4:
                  {
                    BITCODE_BL k;
                    OBJ ();
                    K (type);
                    v_i32 (w, 4);
                    K (degree);
                    v_i32 (w, (int32_t)s->degree);
                    K (knots);
                    v_f64arr (w, s->knots, s->num_knots);
                    K (controlPoints);
                    ARR ();
                    for (k = 0; k < s->num_control_points && s->control_points;
                         k++)
                      {
                        OBJ ();
                        K (x);
                        v_f64 (w, s->control_points[k].point.x);
                        K (y);
                        v_f64 (w, s->control_points[k].point.y);
                        if (s->is_rational)
                          {
                            K (weight);
                            v_f64 (w, s->control_points[k].weight);
                          }
                        ENDOBJ ();
                      }
                    ENDARR ();
                    K (fitDatum);
                    ARR ();
                    for (k = 0; k < s->num_fitpts && s->fitpts; k++)
                      v_pt2 (w, s->fitpts[k].x, s->fitpts[k].y);
                    ENDARR ();
                    ENDOBJ ();
                  }
                  break;
                default:
                  break;
                }
            }
          ENDARR ();
        }
      ENDOBJ ();
    }
  ENDARR ();
  K (definitionLines);
  ARR ();
  for (i = 0; i < h->num_deflines && h->deflines; i++)
    {
      Dwg_HATCH_DefLine *d = &h->deflines[i];
      OBJ ();
      K (angle);
      v_f64 (w, d->angle);
      K (base);
      v_pt2 (w, d->pt0.x, d->pt0.y);
      K (offset);
      v_pt2 (w, d->offset.x, d->offset.y);
      K (dashLengths);
      v_f64arr (w, d->dashes, d->num_dashes);
      ENDOBJ ();
    }
  ENDARR ();
  if (h->is_gradient_fill > 0)
    {
      K (gradientFlag);
      v_i32 (w, 1);
      K (gradientColors);
      ARR ();
      for (i = 0; i < h->num_colors && h->colors; i++)
        {
          OBJ ();
          K (rgb);
          v_i32 (w, (int32_t)(h->colors[i].color.rgb & 0xffffff));
          ENDOBJ ();
        }
      ENDARR ();
    }
}

static void
emit_mleader (Ctx *c, Dwg_Entity_MULTILEADER *m)
{
  W *w = c->w;
  Dwg_MLEADER_AnnotContext *x = &m->ctx;
  BITCODE_BL i, j, k;
  K (arrowheadSize);
  v_f64 (w, m->arrow_size ? m->arrow_size : x->arrow_size);
  K (contentScale);
  v_f64 (w, m->scale_factor ? m->scale_factor : x->scale_factor);
  K (leaderLineColor);
  v_f64 (w, (double)mleader_raw (&m->line_color));
  K (doglegEnabled);
  v_bool (w, m->has_dogleg);
  K (textHeight);
  v_f64 (w, x->text_height);
  K (leaderSections);
  ARR ();
  for (i = 0; i < x->num_leaders && x->leaders; i++)
    {
      Dwg_LEADER_Node *n = &x->leaders[i];
      OBJ ();
      if (n->has_lastleaderlinepoint)
        {
          K (lastLeaderLinePoint);
          v_pt2 (w, n->lastleaderlinepoint.x, n->lastleaderlinepoint.y);
        }
      if (n->has_dogleg)
        {
          K (doglegVector);
          v_pt2 (w, n->dogleg_vector.x, n->dogleg_vector.y);
        }
      K (doglegLength);
      v_f64 (w, n->dogleg_length);
      K (leaderLines);
      ARR ();
      for (j = 0; j < n->num_lines && n->lines; j++)
        {
          Dwg_LEADER_Line *l = &n->lines[j];
          OBJ ();
          K (vertices);
          ARR ();
          for (k = 0; k < l->num_points && l->points; k++)
            v_pt2 (w, l->points[k].x, l->points[k].y);
          ENDARR ();
          ENDOBJ ();
        }
      ENDARR ();
      ENDOBJ ();
    }
  ENDARR ();
  K (hasMText);
  v_bool (w, x->has_content_txt);
  K (hasBlock);
  v_bool (w, x->has_content_blk);
  {
    int ap = m->justification;
    if (x->has_content_txt)
      {
        Dwg_MLEADER_Content_MText *t = &x->content.txt;
        if (t->alignment)
          ap = t->alignment;
        K (textContent);
        v_text (c, t->default_text);
        K (textAnchor);
        v_pt2 (w, t->location.x, t->location.y);
        K (textDirection);
        v_pt2 (w, t->direction.x, t->direction.y);
        K (textRotation);
        v_f64 (w, t->rotation);
        K (textWidth);
        v_f64 (w, t->width);
        K (textLineSpacingFactor);
        v_f64 (w, t->line_spacing_factor);
      }
    K (textAttachmentPoint);
    v_i32 (w, ap);
  }
  K (textColor);
  v_f64 (w, (double)mleader_raw (&m->text_color));
  if (x->has_content_blk)
    {
      Dwg_MLEADER_Content_Block *b = &x->content.blk;
      Dwg_Object *bo = refobj (c, b->block_table);
      K (blockContent);
      OBJ ();
      if (bo)
        {
          K (blockContentId);
          v_handle (w, &c->names, bo);
          want_block (c, bo);
        }
      if (b->transform)
        {
          K (transformationMatrix);
          v_f64arr (w, b->transform, 16);
        }
      ENDOBJ ();
    }
}

static void
emit_attribs (Ctx *c, Dwg_Object *o)
{
  W *w = c->w;
  Dwg_Object *a;
  K (attribs);
  ARR ();
  for (a = get_first_owned_subentity (o); a;
       a = get_next_owned_subentity (o, a))
    {
      if (a->fixedtype == DWG_TYPE_ATTRIB)
        emit_entity (c, a);
      else if (a->fixedtype == DWG_TYPE_SEQEND)
        break;
    }
  ENDARR ();
}

static void
emit_entity (Ctx *c, Dwg_Object *o)
{
  W *w = c->w;
  Dwg_Object_Entity *ent;
  if (!o || o->supertype != DWG_SUPERTYPE_ENTITY || !o->tio.entity)
    return;
  ent = o->tio.entity;
  switch (o->fixedtype)
    {
    case DWG_TYPE_LINE:
      {
        Dwg_Entity_LINE *e = ent->tio.LINE;
        OBJ ();
        common (c, o, "LINE");
        K (startPoint);
        v_pt2 (w, e->start.x, e->start.y);
        K (endPoint);
        v_pt2 (w, e->end.x, e->end.y);
        EXT (e->extrusion);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_XLINE:
    case DWG_TYPE_RAY:
      {
        Dwg_Entity_XLINE *e = ent->tio.XLINE;
        OBJ ();
        common (c, o, o->fixedtype == DWG_TYPE_XLINE ? "XLINE" : "RAY");
        K (firstPoint);
        v_pt2 (w, e->point.x, e->point.y);
        K (unitDirection);
        v_pt2 (w, e->vector.x, e->vector.y);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_CIRCLE:
      {
        Dwg_Entity_CIRCLE *e = ent->tio.CIRCLE;
        OBJ ();
        common (c, o, "CIRCLE");
        K (center);
        v_pt2 (w, e->center.x, e->center.y);
        K (radius);
        v_f64 (w, e->radius);
        EXT (e->extrusion);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_ARC:
      {
        Dwg_Entity_ARC *e = ent->tio.ARC;
        OBJ ();
        common (c, o, "ARC");
        K (center);
        v_pt2 (w, e->center.x, e->center.y);
        K (radius);
        v_f64 (w, e->radius);
        K (startAngle);
        v_f64 (w, e->start_angle);
        K (endAngle);
        v_f64 (w, e->end_angle);
        EXT (e->extrusion);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_ELLIPSE:
      {
        Dwg_Entity_ELLIPSE *e = ent->tio.ELLIPSE;
        OBJ ();
        common (c, o, "ELLIPSE");
        K (center);
        v_pt2 (w, e->center.x, e->center.y);
        K (majorAxisEndPoint);
        v_pt2 (w, e->sm_axis.x, e->sm_axis.y);
        EXT (e->extrusion);
        K (axisRatio);
        v_f64 (w, e->axis_ratio);
        K (startAngle);
        v_f64 (w, e->start_angle);
        K (endAngle);
        v_f64 (w, e->end_angle);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_LWPOLYLINE:
      {
        Dwg_Entity_LWPOLYLINE *e = ent->tio.LWPOLYLINE;
        BITCODE_BL i;
        OBJ ();
        common (c, o, "LWPOLYLINE");
        K (flag);
        v_i32 (w, e->flag);
        if (e->const_width != 0.0)
          {
            K (constantWidth);
            v_f64 (w, e->const_width);
          }
        EXT (e->extrusion);
        K (vertices);
        ARR ();
        for (i = 0; i < e->num_points && e->points; i++)
          {
            OBJ ();
            K (x);
            v_f64 (w, e->points[i].x);
            K (y);
            v_f64 (w, e->points[i].y);
            if (e->bulges && i < e->num_bulges && e->bulges[i] != 0.0)
              {
                K (bulge);
                v_f64 (w, e->bulges[i]);
              }
            ENDOBJ ();
          }
        ENDARR ();
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_POLYLINE_2D:
      {
        Dwg_Entity_POLYLINE_2D *e = ent->tio.POLYLINE_2D;
        Dwg_Object *v;
        OBJ ();
        common (c, o, "POLYLINE2D");
        K (flag);
        v_i32 (w, e->flag);
        K (startWidth);
        v_f64 (w, e->start_width);
        K (endWidth);
        v_f64 (w, e->end_width);
        EXT (e->extrusion);
        K (vertices);
        ARR ();
        for (v = get_first_owned_subentity (o); v;
             v = get_next_owned_subentity (o, v))
          {
            if (v->fixedtype == DWG_TYPE_SEQEND)
              break;
            if (v->fixedtype != DWG_TYPE_VERTEX_2D || !v->tio.entity)
              continue;
            {
              Dwg_Entity_VERTEX_2D *p = v->tio.entity->tio.VERTEX_2D;
              OBJ ();
              K (x);
              v_f64 (w, p->point.x);
              K (y);
              v_f64 (w, p->point.y);
              if (p->bulge != 0.0)
                {
                  K (bulge);
                  v_f64 (w, p->bulge);
                }
              K (flag);
              v_i32 (w, p->flag);
              ENDOBJ ();
            }
          }
        ENDARR ();
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_POLYLINE_3D:
      {
        Dwg_Entity_POLYLINE_3D *e = ent->tio.POLYLINE_3D;
        Dwg_Object *v;
        OBJ ();
        common (c, o, "POLYLINE3D");
        K (flag);
        v_i32 (w, e->flag);
        K (vertices);
        ARR ();
        for (v = get_first_owned_subentity (o); v;
             v = get_next_owned_subentity (o, v))
          {
            if (v->fixedtype == DWG_TYPE_SEQEND)
              break;
            if (v->fixedtype != DWG_TYPE_VERTEX_3D || !v->tio.entity)
              continue;
            {
              Dwg_Entity_VERTEX_3D *p = v->tio.entity->tio.VERTEX_3D;
              OBJ ();
              K (x);
              v_f64 (w, p->point.x);
              K (y);
              v_f64 (w, p->point.y);
              K (flag);
              v_i32 (w, p->flag);
              ENDOBJ ();
            }
          }
        ENDARR ();
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_SPLINE:
      {
        Dwg_Entity_SPLINE *e = ent->tio.SPLINE;
        BITCODE_BL i;
        OBJ ();
        common (c, o, "SPLINE");
        K (flag);
        v_i32 (w, (int32_t)e->splineflags);
        K (degree);
        v_i32 (w, e->degree);
        K (knots);
        v_f64arr (w, e->knots, e->num_knots);
        if (e->weighted && e->ctrl_pts)
          {
            K (weights);
            w8 (w, 11);
            wu32 (w, e->num_ctrl_pts);
            for (i = 0; i < e->num_ctrl_pts; i++)
              wraw (w, &e->ctrl_pts[i].w, 8);
          }
        K (controlPoints);
        ARR ();
        for (i = 0; i < e->num_ctrl_pts && e->ctrl_pts; i++)
          v_pt2 (w, e->ctrl_pts[i].x, e->ctrl_pts[i].y);
        ENDARR ();
        K (fitPoints);
        ARR ();
        for (i = 0; i < e->num_fit_pts && e->fit_pts; i++)
          v_pt2 (w, e->fit_pts[i].x, e->fit_pts[i].y);
        ENDARR ();
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_SOLID:
    case DWG_TYPE_TRACE:
      {
        Dwg_Entity_SOLID *e = ent->tio.SOLID;
        OBJ ();
        common (c, o, o->fixedtype == DWG_TYPE_SOLID ? "SOLID" : "TRACE");
        K (corner1);
        v_pt2 (w, e->corner1.x, e->corner1.y);
        K (corner2);
        v_pt2 (w, e->corner2.x, e->corner2.y);
        K (corner3);
        v_pt2 (w, e->corner3.x, e->corner3.y);
        K (corner4);
        v_pt2 (w, e->corner4.x, e->corner4.y);
        EXT (e->extrusion);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE__3DFACE:
      {
        Dwg_Entity__3DFACE *e = ent->tio._3DFACE;
        OBJ ();
        common (c, o, "3DFACE");
        K (corner1);
        v_pt2 (w, e->corner1.x, e->corner1.y);
        K (corner2);
        v_pt2 (w, e->corner2.x, e->corner2.y);
        K (corner3);
        v_pt2 (w, e->corner3.x, e->corner3.y);
        K (corner4);
        v_pt2 (w, e->corner4.x, e->corner4.y);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_WIPEOUT:
      {
        Dwg_Entity_WIPEOUT *e = ent->tio.WIPEOUT;
        BITCODE_BL i;
        OBJ ();
        common (c, o, "WIPEOUT");
        K (position);
        v_pt2 (w, e->pt0.x, e->pt0.y);
        K (uPixel);
        v_pt2 (w, e->uvec.x, e->uvec.y);
        K (vPixel);
        v_pt2 (w, e->vvec.x, e->vvec.y);
        K (imageSize);
        v_pt2 (w, e->image_size.x, e->image_size.y);
        K (clippingBoundaryType);
        v_i32 (w, e->clip_boundary_type);
        K (clippingBoundaryPath);
        ARR ();
        for (i = 0; i < e->num_clip_verts && e->clip_verts; i++)
          v_pt2 (w, e->clip_verts[i].x, e->clip_verts[i].y);
        ENDARR ();
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_TEXT:
      {
        Dwg_Entity_TEXT *e = ent->tio.TEXT;
        OBJ ();
        common (c, o, "TEXT");
        text_base (c, e->text_value, e->ins_pt.x, e->ins_pt.y, e->alignment_pt.x, e->alignment_pt.y, e->height,
                   e->rotation, e->width_factor, e->oblique_angle, e->style,
                   e->generation, e->horiz_alignment, e->vert_alignment,
                   e->extrusion);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_ATTRIB:
      {
        Dwg_Entity_ATTRIB *e = ent->tio.ATTRIB;
        OBJ ();
        common (c, o, "ATTRIB");
        K (flags);
        v_i32 (w, e->flags);
        K (text);
        OBJ ();
        text_base (c, e->text_value, e->ins_pt.x, e->ins_pt.y, e->alignment_pt.x, e->alignment_pt.y, e->height,
                   e->rotation, e->width_factor, e->oblique_angle, e->style,
                   e->generation, e->horiz_alignment, e->vert_alignment,
                   e->extrusion);
        ENDOBJ ();
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_MTEXT:
      {
        Dwg_Entity_MTEXT *e = ent->tio.MTEXT;
        OBJ ();
        common (c, o, "MTEXT");
        K (insertionPoint);
        v_pt2 (w, e->ins_pt.x, e->ins_pt.y);
        K (textHeight);
        v_f64 (w, e->text_height);
        K (rectWidth);
        v_f64 (w, e->rect_width);
        K (attachmentPoint);
        v_i32 (w, e->attachment);
        K (text);
        v_text (c, e->text);
        {
          Dwg_Object *so = refobj (c, e->style);
          const char *sn = so ? tblname (c, so) : NULL;
          if (sn)
            {
              K (styleName);
              v_name (w, &c->names, sn);
            }
        }
        EXT (e->extrusion);
        K (direction);
        v_pt2 (w, e->x_axis_dir.x, e->x_axis_dir.y);
        K (lineSpacing);
        v_f64 (w, e->linespace_factor);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_INSERT:
    case DWG_TYPE_MINSERT:
      {
        int is_m = o->fixedtype == DWG_TYPE_MINSERT;
        Dwg_Entity_INSERT *e = ent->tio.INSERT;
        Dwg_Entity_MINSERT *m = ent->tio.MINSERT;
        Dwg_Object *bo
            = refobj (c, is_m ? m->block_header : e->block_header);
        const char *bn = bo ? tblname (c, bo) : NULL;
        OBJ ();
        common (c, o, "INSERT");
        K (name);
        if (bn)
          v_name (w, &c->names, bn);
        else
          v_text (c, is_m ? NULL : e->block_name);
        want_block (c, bo);
        if (is_m)
          {
            K (insertionPoint);
            v_pt2 (w, m->ins_pt.x, m->ins_pt.y);
            K (xScale);
            v_f64 (w, m->scale.x);
            K (yScale);
            v_f64 (w, m->scale.y);
            K (rotation);
            v_f64 (w, m->rotation);
            K (columnCount);
            v_i32 (w, m->num_cols ? m->num_cols : 1);
            K (rowCount);
            v_i32 (w, m->num_rows ? m->num_rows : 1);
            K (columnSpacing);
            v_f64 (w, m->col_spacing);
            K (rowSpacing);
            v_f64 (w, m->row_spacing);
            EXT (m->extrusion);
          }
        else
          {
            K (insertionPoint);
            v_pt2 (w, e->ins_pt.x, e->ins_pt.y);
            K (xScale);
            v_f64 (w, e->scale.x);
            K (yScale);
            v_f64 (w, e->scale.y);
            K (rotation);
            v_f64 (w, e->rotation);
            if (e->num_cols > 1 || e->num_rows > 1)
              {
                K (columnCount);
                v_i32 (w, e->num_cols ? e->num_cols : 1);
                K (rowCount);
                v_i32 (w, e->num_rows ? e->num_rows : 1);
                K (columnSpacing);
                v_f64 (w, e->col_spacing);
                K (rowSpacing);
                v_f64 (w, e->row_spacing);
              }
            EXT (e->extrusion);
          }
        if (is_m ? m->has_attribs : e->has_attribs)
          emit_attribs (c, o);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_DIMENSION_ORDINATE:
    case DWG_TYPE_DIMENSION_LINEAR:
    case DWG_TYPE_DIMENSION_ALIGNED:
    case DWG_TYPE_DIMENSION_ANG3PT:
    case DWG_TYPE_DIMENSION_ANG2LN:
    case DWG_TYPE_DIMENSION_RADIUS:
    case DWG_TYPE_DIMENSION_DIAMETER:
    case DWG_TYPE_ARC_DIMENSION:
    case DWG_TYPE_LARGE_RADIAL_DIMENSION:
      {
        Dwg_DIMENSION_common *e = ent->tio.DIMENSION_common;
        Dwg_Object *bo = refobj (c, e->block);
        const char *bn = bo ? tblname (c, bo) : NULL;
        OBJ ();
        common (c, o, "DIMENSION");
        if (bn)
          {
            K (name);
            v_name (w, &c->names, bn);
          }
        want_block (c, bo);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_TABLE:
      {
        Dwg_Entity_TABLE *e = ent->tio.TABLE;
        Dwg_Object *bo = refobj (c, e->block_header);
        OBJ ();
        common (c, o, "ACAD_TABLE");
        if (bo)
          {
            K (blockRecordHandle);
            v_handle (w, &c->names, bo);
          }
        want_block (c, bo);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_LEADER:
      {
        Dwg_Entity_LEADER *e = ent->tio.LEADER;
        BITCODE_BL i;
        OBJ ();
        common (c, o, "LEADER");
        K (vertices);
        ARR ();
        for (i = 0; i < e->num_points && e->points; i++)
          v_pt2 (w, e->points[i].x, e->points[i].y);
        ENDARR ();
        K (isArrowheadEnabled);
        v_bool (w, e->arrowhead_on > 0);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_MULTILEADER:
      {
        OBJ ();
        common (c, o, "MULTILEADER");
        emit_mleader (c, ent->tio.MULTILEADER);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_MLINE:
      {
        Dwg_Entity_MLINE *e = ent->tio.MLINE;
        BITCODE_BL i, j;
        OBJ ();
        common (c, o, "MLINE");
        K (flags);
        v_i32 (w, e->flags);
        K (numberOfLines);
        v_i32 (w, e->num_lines);
        K (vertices);
        ARR ();
        for (i = 0; i < e->num_verts && e->verts; i++)
          {
            Dwg_MLINE_vertex *v = &e->verts[i];
            OBJ ();
            K (vertex);
            v_pt2 (w, v->vertex.x, v->vertex.y);
            K (miterDirection);
            v_pt2 (w, v->miter_direction.x, v->miter_direction.y);
            K (lines);
            ARR ();
            for (j = 0; j < v->num_lines && v->lines; j++)
              {
                OBJ ();
                K (segmentParams);
                v_f64arr (w, v->lines[j].segparms, v->lines[j].num_segparms);
                ENDOBJ ();
              }
            ENDARR ();
            ENDOBJ ();
          }
        ENDARR ();
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_HATCH:
      {
        OBJ ();
        common (c, o, "HATCH");
        emit_hatch (c, ent->tio.HATCH);
        ENDOBJ ();
      }
      break;
    case DWG_TYPE_POINT:
      {
        Dwg_Entity_POINT *e = ent->tio.POINT;
        OBJ ();
        common (c, o, "POINT");
        K (position);
        v_pt2 (w, e->x, e->y);
        ENDOBJ ();
      }
      break;
    default:
      return; /* 그리지 않는 객체 */
    }
  c->nent++;
}

/* 블록(또는 모형 공간)의 객체들 */
static void
emit_block_entities (Ctx *c, Dwg_Object *hdr)
{
  W *w = c->w;
  Dwg_Object *o;
  int any = 0;
  K (entities);
  ARR ();
  for (o = get_first_owned_entity (hdr); o; o = get_next_owned_entity (hdr, o))
    {
      any = 1;
      if (o->fixedtype == DWG_TYPE_ATTDEF || o->fixedtype == DWG_TYPE_BLOCK
          || o->fixedtype == DWG_TYPE_ENDBLK)
        continue;
      emit_entity (c, o);
    }
  if (!any)
    {
      /* 목록이 비면: 이 블록을 주인으로 가진 객체를 직접 찾는다 */
      BITCODE_BL i;
      for (i = 0; i < c->dwg->num_objects; i++)
        {
          Dwg_Object *e = &c->dwg->object[i];
          if (e->supertype != DWG_SUPERTYPE_ENTITY || !e->tio.entity
              || !e->tio.entity->ownerhandle)
            continue;
          if (e->tio.entity->ownerhandle->absolute_ref != hdr->handle.value)
            continue;
          if (e->fixedtype == DWG_TYPE_ATTDEF || e->fixedtype == DWG_TYPE_BLOCK
              || e->fixedtype == DWG_TYPE_ENDBLK
              || e->fixedtype == DWG_TYPE_ATTRIB
              || e->fixedtype == DWG_TYPE_VERTEX_2D
              || e->fixedtype == DWG_TYPE_VERTEX_3D
              || e->fixedtype == DWG_TYPE_SEQEND)
            continue;
          emit_entity (c, e);
        }
    }
  ENDARR ();
}

static void
emit_block_record (Ctx *c, Dwg_Object *hdr, const char *force_name)
{
  W *w = c->w;
  Dwg_Object_BLOCK_HEADER *b = hdr->tio.object->tio.BLOCK_HEADER;
  OBJ ();
  K (name);
  v_name (w, &c->names, force_name ? force_name : tblname (c, hdr));
  K (handle);
  v_handle (w, &c->names, hdr);
  K (basePoint);
  v_pt2 (w, b->base_pt.x, b->base_pt.y);
  emit_block_entities (c, hdr);
  ENDOBJ ();
  c->nblk++;
}

/* 결과: 0 성공. 실패 시 음수 */
int
sgdb_write (Dwg_Data *dwg, FILE *fp, unsigned long *stats)
{
  W wb = { 0 };
  W *w = &wb;
  Ctx c;
  BITCODE_BL i;
  Dwg_Object *ms;
  memset (&c, 0, sizeof c);
  c.dwg = dwg;
  c.w = w;
  c.is_tu = IS_FROM_TU_DWG (dwg) ? 1 : 0;
  c.objname = (char **)calloc (dwg->num_objects + 1, sizeof (char *));
  c.need = (unsigned char *)calloc (dwg->num_objects + 1, 1);
  c.queue = (BITCODE_BL *)calloc (dwg->num_objects + 1, sizeof (BITCODE_BL));
  w->cap = 8u << 20;
  w->p = (unsigned char *)malloc (w->cap);
  w->fp = fp;
  if (!c.objname || !c.need || !c.queue || !w->p)
    return -2;

  /* 머리 */
  wraw (w, "SGDB", 4);
  wu32 (w, SGDB_VERSION);
  wu32 (w, K__COUNT);
  for (i = 0; i < K__COUNT; i++)
    {
      uint16_t n = (uint16_t)strlen (key_names[i]);
      wu16 (w, n);
      wraw (w, key_names[i], n);
    }

  OBJ ();
  K (header);
  OBJ ();
  K (LTSCALE);
  v_f64 (w, dwg->header_vars.LTSCALE);
  K (DIMSCALE);
  v_f64 (w, dwg->header_vars.DIMSCALE);
  K (DIMASZ);
  v_f64 (w, dwg->header_vars.DIMASZ);
  K (INSUNITS);
  v_i32 (w, dwg->header_vars.INSUNITS);
  ENDOBJ ();

  K (tables);
  OBJ ();
  /* 층 */
  K (LAYER);
  OBJ ();
  K (entries);
  ARR ();
  for (i = 0; i < dwg->num_objects; i++)
    {
      Dwg_Object *o = &dwg->object[i];
      Dwg_Object_LAYER *l;
      if (o->fixedtype != DWG_TYPE_LAYER || !o->tio.object)
        continue;
      l = o->tio.object->tio.LAYER;
      OBJ ();
      K (name);
      v_name (w, &c.names, tblname (&c, o));
      {
        unsigned m = l->color.method ? (unsigned)l->color.method
                                     : ((l->color.rgb >> 24) & 0xff);
        int ci = 256;
        int rgb = 0xffffff;
        if (m == 0xc3)
          ci = l->color.rgb & 0xff;
        else if (m == 0xc2)
          rgb = (int)(l->color.rgb & 0xffffff);
        else if (l->color.index >= 1 && l->color.index <= 255)
          ci = l->color.index;
        else if (l->color.index <= -1 && l->color.index >= -255)
          ci = l->color.index; /* 음수 = 꺼짐 */
        K (colorIndex);
        v_i32 (w, ci);
        K (color);
        v_i32 (w, rgb);
      }
      K (off);
      v_bool (w, l->off);
      K (frozen);
      v_bool (w, l->frozen);
      {
        Dwg_Object *t = refobj (&c, l->ltype);
        const char *n = t ? tblname (&c, t) : NULL;
        K (lineType);
        v_name (w, &c.names, n ? n : "Continuous");
      }
      ENDOBJ ();
    }
  ENDARR ();
  ENDOBJ ();
  /* 선 종류 */
  K (LTYPE);
  OBJ ();
  K (entries);
  ARR ();
  for (i = 0; i < dwg->num_objects; i++)
    {
      Dwg_Object *o = &dwg->object[i];
      Dwg_Object_LTYPE *t;
      BITCODE_BL j;
      if (o->fixedtype != DWG_TYPE_LTYPE || !o->tio.object)
        continue;
      t = o->tio.object->tio.LTYPE;
      OBJ ();
      K (name);
      v_name (w, &c.names, tblname (&c, o));
      K (pattern);
      ARR ();
      for (j = 0; j < t->numdashes && t->dashes; j++)
        {
          OBJ ();
          K (elementLength);
          v_f64 (w, t->dashes[j].length);
          ENDOBJ ();
        }
      ENDARR ();
      ENDOBJ ();
    }
  ENDARR ();
  ENDOBJ ();
  /* 글꼴 */
  K (STYLE);
  OBJ ();
  K (entries);
  ARR ();
  for (i = 0; i < dwg->num_objects; i++)
    {
      Dwg_Object *o = &dwg->object[i];
      if (o->fixedtype != DWG_TYPE_STYLE || !o->tio.object)
        continue;
      OBJ ();
      K (name);
      v_name (w, &c.names, tblname (&c, o));
      K (widthFactor);
      v_f64 (w, o->tio.object->tio.STYLE->width_factor);
      ENDOBJ ();
    }
  ENDARR ();
  ENDOBJ ();
  /* 블록: 모형 공간 먼저, 그다음 쓰이는 블록만 */
  K (BLOCK_RECORD);
  OBJ ();
  K (entries);
  ARR ();
  ms = dwg_model_space_object (dwg);
  if (ms && ms->fixedtype == DWG_TYPE_BLOCK_HEADER)
    {
      c.need[ms->index] = 2;
      emit_block_record (&c, ms, "*Model_Space");
    }
  while (c.qh < c.qt)
    {
      Dwg_Object *b = &dwg->object[c.queue[c.qh++]];
      if (c.need[b->index] == 2)
        continue;
      c.need[b->index] = 2;
      emit_block_record (&c, b, NULL);
    }
  ENDARR ();
  ENDOBJ ();
  ENDOBJ (); /* tables */

  K (entities);
  ARR ();
  ENDARR ();
  K (stats);
  OBJ ();
  K (entities);
  v_f64 (w, (double)c.nent);
  K (BLOCK_RECORD);
  v_f64 (w, (double)c.nblk);
  ENDOBJ ();
  ENDOBJ ();
  wflush (w);

  if (stats)
    {
      stats[0] = c.nent;
      stats[1] = c.nblk;
      stats[2] = (unsigned long)w->total;
    }
  for (i = 0; i < dwg->num_objects; i++)
    free (c.objname[i]);
  free (c.objname);
  free (c.need);
  free (c.queue);
  for (i = 0; i < c.names.cap; i++)
    free (c.names.t[i].s);
  free (c.names.t);
  free (w->p);
  return w->err ? -3 : 0;
}

/* 파일 → 파일. 반환: 0 성공, 1 읽기 실패, 2 쓰기 실패, 3 빈 도면 */
int
sgdb_convert (const char *in, const char *out, int is_dxf, unsigned long *stats,
              int *dwg_err)
{
  Dwg_Data dwg;
  FILE *fp;
  int err, r;
  memset (&dwg, 0, sizeof dwg);
  dwg.opts = 0;
  dwg_skip_eed = 1;
  if (is_dxf)
    err = dxf_read_file (in, &dwg);
  else
    err = dwg_read_file (in, &dwg);
  if (dwg_err)
    *dwg_err = err;
  if (err >= DWG_ERR_CRITICAL || !dwg.num_objects)
    {
      dwg_free (&dwg);
      return 1;
    }
  fp = fopen (out, "wb");
  if (!fp)
    {
      dwg_free (&dwg);
      return 2;
    }
  setvbuf (fp, NULL, _IOFBF, 1 << 20);
  r = sgdb_write (&dwg, fp, stats);
  if (fclose (fp) != 0)
    r = -3;
  dwg_free (&dwg);
  return r ? 2 : 0;
}

#ifdef SGDB_MAIN
#include <time.h>
static double
now_ms (void)
{
  struct timespec t;
  clock_gettime (CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}
int
main (int argc, char **argv)
{
  unsigned long st[3] = { 0 };
  int derr = 0, r;
  double t0;
  if (argc < 3)
    {
      fprintf (stderr, "usage: sgdb in.dwg out.sgdb [dxf]\n");
      return 2;
    }
  t0 = now_ms ();
  r = sgdb_convert (argv[1], argv[2], argc > 3, st, &derr);
  printf ("r=%d dwgerr=%d entities=%lu blocks=%lu bytes=%lu ms=%.0f\n", r, derr,
          st[0], st[1], st[2], now_ms () - t0);
  return r;
}
#endif
