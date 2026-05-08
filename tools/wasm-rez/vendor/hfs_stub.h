/*
 * Stub hfs.h for the WASM/native spike build of Rez.
 *
 * Retro68's ResourceFile.cc only invokes hfs_* in Format::diskimage. The spike
 * never selects diskimage; we always go applesingle/macbin. So we provide
 * empty signatures sufficient to satisfy the compiler and linker.
 */
#ifndef SPIKE_HFS_STUB_H
#define SPIKE_HFS_STUB_H

#include <stddef.h>

#define HFS_MODE_RDWR 2

typedef struct hfsvol hfsvol;
typedef struct hfsfile hfsfile;

#ifdef __cplusplus
extern "C" {
#endif

static inline int hfs_format(const char *p, int a, int b,
                              const char *name, int c, void *d) { (void)p;(void)a;(void)b;(void)name;(void)c;(void)d; return -1; }
static inline hfsvol *hfs_mount(const char *p, int part, int mode) { (void)p;(void)part;(void)mode; return 0; }
static inline hfsfile *hfs_create(hfsvol *v, const char *n, const char *t, const char *c) { (void)v;(void)n;(void)t;(void)c; return 0; }
static inline int hfs_setfork(hfsfile *f, int fork) { (void)f;(void)fork; return -1; }
static inline long hfs_write(hfsfile *f, const void *buf, size_t n) { (void)f;(void)buf;(void)n; return -1; }
static inline int hfs_close(hfsfile *f) { (void)f; return -1; }
static inline int hfs_umount(hfsvol *v) { (void)v; return -1; }

#ifdef __cplusplus
}
#endif

#endif
