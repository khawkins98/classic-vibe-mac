/*
 * runner.c — m68k boot tracer for in-browser-built MacBinary II APPLs
 * (cv-mac #89).
 *
 * Loads a `.bin` produced by cv-mac's compileToBin, lays out CODE 0's
 * A5 world + CODE 1's code, points the m68k PC at the entry
 * trampoline, and runs the binary through the embedded Musashi CPU
 * emulator for a cycle budget.
 *
 * Toolbox stubs (added 2026-05-15): enough to get past
 * `Retro68Relocate` into `main()`. We're not emulating Mac OS — we're
 * faking just enough of the Resource Manager and Memory Manager that
 * libretrocrt's startup can complete and call user code. Every other
 * A-line trap is still no-op-and-skip.
 *
 * See README.md for what's covered vs not. The deal is: enough to see
 * WHERE the binary stops, not to actually run it to completion.
 *
 * Build:   make
 * Run:     ./m68k-run path/to/hello.bin [--trace] [--max=N] [--quiet]
 */

#define _POSIX_C_SOURCE 200809L
#include "musashi/m68k.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RAM_BYTES   (16 * 1024 * 1024)
#define A5_WORLD    0x00100000UL
#define SEG_BASE    0x00200000UL

/* Toolbox stub memory map (carved out of RAM). All within RAM_BYTES.
 *   MPT_BASE      master pointer table — 4 B per handle (8192 slots = 32 KB)
 *   HEAP_BASE     bump allocator backing store for NewHandle / NewPtr (192 KB)
 *   HEAP_TOP      one-past-end of the heap region */
#define MPT_BASE    0x00080000UL
#define MPT_SLOTS   8192
#define MPT_BYTES   (MPT_SLOTS * 4)
#define HEAP_BASE   0x00090000UL
#define HEAP_TOP    0x000c0000UL

static uint8_t *RAM;
static uint32_t a5_value;
static uint32_t pc_start;
static int g_trace = 0;
static int g_quiet = 0;
static long g_max_instr = 1000000;
static long g_instr_count = 0;
static long g_aline_count = 0;
static uint32_t g_last_pc = 0;

static inline uint32_t mem_read32_be(uint32_t a) {
    return ((uint32_t)RAM[a] << 24) | ((uint32_t)RAM[a+1] << 16)
         | ((uint32_t)RAM[a+2] << 8) | RAM[a+3];
}
static inline uint16_t mem_read16_be(uint32_t a) {
    return ((uint16_t)RAM[a] << 8) | RAM[a+1];
}
static inline void mem_write32_be(uint32_t a, uint32_t v) {
    RAM[a]=v>>24; RAM[a+1]=v>>16; RAM[a+2]=v>>8; RAM[a+3]=v;
}
static inline void mem_write16_be(uint32_t a, uint16_t v) {
    RAM[a]=v>>8; RAM[a+1]=v;
}
static inline int oor(uint32_t a, int n) { return a + n > RAM_BYTES; }

unsigned int m68k_read_memory_8 (unsigned int a) {
    if (oor(a,1)) { fprintf(stderr,"[oor] r8 @0x%08x pc=%08x\n",a,g_last_pc); exit(2); }
    return RAM[a];
}
unsigned int m68k_read_memory_16(unsigned int a) {
    if (oor(a,2)) { fprintf(stderr,"[oor] r16 @0x%08x pc=%08x\n",a,g_last_pc); exit(2); }
    return mem_read16_be(a);
}
unsigned int m68k_read_memory_32(unsigned int a) {
    if (oor(a,4)) { fprintf(stderr,"[oor] r32 @0x%08x pc=%08x\n",a,g_last_pc); exit(2); }
    return mem_read32_be(a);
}
unsigned int m68k_read_disassembler_8 (unsigned int a) { return m68k_read_memory_8(a); }
unsigned int m68k_read_disassembler_16(unsigned int a) { return m68k_read_memory_16(a); }
unsigned int m68k_read_disassembler_32(unsigned int a) { return m68k_read_memory_32(a); }

void m68k_write_memory_8 (unsigned int a, unsigned int v) {
    if (oor(a,1)) { fprintf(stderr,"[oor] w8 @0x%08x pc=%08x\n",a,g_last_pc); exit(2); }
    RAM[a]=v&0xff;
}
void m68k_write_memory_16(unsigned int a, unsigned int v) {
    if (oor(a,2)) { fprintf(stderr,"[oor] w16 @0x%08x pc=%08x\n",a,g_last_pc); exit(2); }
    mem_write16_be(a,v);
}
void m68k_write_memory_32(unsigned int a, unsigned int v) {
    if (oor(a,4)) { fprintf(stderr,"[oor] w32 @0x%08x pc=%08x\n",a,g_last_pc); exit(2); }
    mem_write32_be(a,v);
}

static uint32_t be32(const uint8_t *p) {
    return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];
}
static uint16_t be16(const uint8_t *p) { return ((uint16_t)p[0]<<8)|p[1]; }

struct rsrc { uint32_t type; int id; uint32_t size; uint32_t addr; };

/* All parsed resources from the input MacBinary, including their final
 * load address in RAM. Resources whose data was loaded at a specific
 * location during setup (CODE 1+) have addr in SEG_BASE+. Other
 * resources get copied into the heap region on first GetResource. */
static struct rsrc g_resources[256];
static int g_n_resources = 0;

/* Cache from (type, id) → already-issued Handle, so repeated
 * GetResource calls for the same resource hand back the same Handle.
 * Some libretrocrt code does pointer-equality checks on Handles. */
struct rcache { uint32_t type; int id; uint32_t handle; };
static struct rcache g_rcache[256];
static int g_n_rcache = 0;

/* Master pointer allocator (returns the address of a free master
 * pointer slot, increments forever — we never DisposeHandle for real). */
static uint32_t g_mpt_next = MPT_BASE;
/* Heap bump allocator (returns next free heap byte). */
static uint32_t g_heap_next = HEAP_BASE;

/* Allocate a new master pointer slot. Stores `target_addr` in the slot
 * and returns the slot's address (the Handle). */
static uint32_t alloc_handle(uint32_t target_addr) {
    if (g_mpt_next + 4 > MPT_BASE + MPT_BYTES) {
        fprintf(stderr,"[heap] master pointer table full\n"); exit(2);
    }
    uint32_t h = g_mpt_next;
    g_mpt_next += 4;
    mem_write32_be(h, target_addr);
    return h;
}

/* Allocate `size` bytes from the heap region, aligned to 4 bytes. */
static uint32_t alloc_heap(uint32_t size) {
    uint32_t aligned = (size + 3) & ~3u;
    if (g_heap_next + aligned > HEAP_TOP) {
        fprintf(stderr,"[heap] out of memory (wanted %u, have %u)\n",
            aligned, (uint32_t)(HEAP_TOP - g_heap_next));
        exit(2);
    }
    uint32_t p = g_heap_next;
    g_heap_next += aligned;
    return p;
}

/* Return a Handle for resource (type, id), creating + caching it on
 * first access. Returns 0 if not found. */
static uint32_t handle_for_resource(uint32_t type, int id) {
    for (int i = 0; i < g_n_rcache; i++) {
        if (g_rcache[i].type == type && g_rcache[i].id == id)
            return g_rcache[i].handle;
    }
    for (int i = 0; i < g_n_resources; i++) {
        if (g_resources[i].type == type && g_resources[i].id == id) {
            uint32_t h = alloc_handle(g_resources[i].addr);
            if (g_n_rcache < (int)(sizeof(g_rcache)/sizeof(g_rcache[0]))) {
                g_rcache[g_n_rcache++] = (struct rcache){type, id, h};
            }
            return h;
        }
    }
    return 0;
}

/* Toolbox trap name lookup. Covers what libretrocrt + the bundled
 * hello.c hit. Anything not listed shows as raw "$Axxx" in trace. */
static const char *trap_name(uint16_t op) {
    if ((op & 0xf000) != 0xa000) return NULL;
    /* Many traps share a base trap number with bit 9 ("clear" flag) or
     * bit 10 (auto-pop / register variant) varying. Mask off those bits
     * for lookup: the underlying behavior is identical for our stubs. */
    uint16_t base = op & 0xf9ff;
    switch (base) {
        case 0xa055: return "StripAddress";
        case 0xa063: return "MaxApplZone";
        case 0xa036: return "MoreMasters";
        case 0xa11e: return "NewPtr";
        case 0xa11f: return "DisposePtr";
        case 0xa31e: return "NewHandle";
        case 0xa023: return "DisposeHandle";
        case 0xa024: return "SetHandleSize";
        case 0xa025: return "GetHandleSize";
        case 0xa029: return "HLock";
        case 0xa02a: return "HUnlock";
        case 0xa02e: return "BlockMove";
        case 0xa040: return "ReserveMem";
        case 0xa71e: return "NewPtrSysClear";
        case 0xa86e: return "InitGraf";
        case 0xa8fe: return "InitFonts";
        case 0xa912: return "InitWindows";
        case 0xa930: return "InitMenus";
        case 0xa9cc: return "TEInit";
        case 0xa97b: return "InitDialogs";
        case 0xa86c: return "FlushEvents";
        case 0xa850: return "InitCursor";
        case 0xa882: return "DrawString";
        case 0xa893: return "MoveTo";
        case 0xa974: return "Button";
        case 0xa860: return "WaitNextEvent";
        case 0xa9f4: return "ExitToShell";
        case 0xa9f0: return "LoadSeg";
        case 0xa9ff: return "Debugger";
        case 0xabff: return "DebugStr";
        case 0xa9a0: return "GetResource";
        case 0xa9a1: return "GetNamedResource";
        case 0xa9a3: return "ReleaseResource";
        case 0xa994: return "CurResFile";
        case 0xa9a4: return "HomeResFile";
        case 0xa998: return "GetResAttrs";
        case 0xa99a: return "ChangedResource";
        case 0xa9a8: return "SizeRsrc";
        case 0xa9b9: return "ResError";
        case 0xa996: return "SetResLoad";
        default:     return NULL;
    }
}

/* ────────────────────────────────────────────────────────────────────
 * Toolbox trap stubs
 *
 * Calling conventions (refresher):
 *   • Memory Manager (NewHandle, HLock, etc): register-based.
 *     Inputs in D0/A0. Outputs in A0/D0. D0 also carries result code.
 *   • Resource Manager (GetResource, etc): Pascal stack convention.
 *     Caller reserved space for return value, pushed args, hit trap.
 *     Trap pops args, leaves return value where the space was.
 *
 * We catch the A-line trap in m68k_instr_hook BEFORE the CPU's exception
 * fires, so the stack is exactly as the caller set it up — no exception
 * frame, no return-addr on top. After our stub: advance PC past the
 * trap word and return.
 * ────────────────────────────────────────────────────────────────────*/

/* GetResource(theType: ResType, theID: INTEGER): Handle
 * Stack on entry:
 *   sp+0  short theID (2 bytes)
 *   sp+2  long  theType (4 bytes)
 *   sp+6  long  return-Handle slot (caller's reserved space)
 * We pop 6 bytes of args, leave Handle in the slot. */
static void stub_GetResource(void) {
    uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
    uint16_t id = mem_read16_be(sp);
    uint32_t type = mem_read32_be(sp + 2);
    uint32_t h = handle_for_resource(type, (int16_t)id);
    if (!g_quiet) {
        char t[5] = {type>>24, type>>16, type>>8, type, 0};
        fprintf(stderr,"  [GetResource] type='%s' id=%d → handle=0x%08x\n",
            t, (int16_t)id, h);
    }
    mem_write32_be(sp + 6, h);
    m68k_set_reg(M68K_REG_SP, sp + 6);  /* pop args, leave return slot */
}

/* ReleaseResource(theResource: Handle): no return value */
static void stub_ReleaseResource(void) {
    uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
    /* Pop the 4-byte Handle arg. No return value. */
    m68k_set_reg(M68K_REG_SP, sp + 4);
}

/* HomeResFile(theResource: Handle): INTEGER (file refnum)
 * We don't track multiple resource files. Return 1 (the "system" file). */
static void stub_HomeResFile(void) {
    uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
    /* Stack: handle (4 B), return-INTEGER slot (2 B). Pop handle, write 1. */
    mem_write16_be(sp + 4, 1);
    m68k_set_reg(M68K_REG_SP, sp + 4);
}

/* CurResFile: INTEGER. No args, returns 1. */
static void stub_CurResFile(void) {
    uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
    mem_write16_be(sp, 1);
    /* No SP adjust — return slot was already at sp. */
}

/* SizeRsrc(theResource: Handle): LongInt */
static void stub_SizeRsrc(void) {
    uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
    uint32_t h = mem_read32_be(sp);
    uint32_t target = h ? mem_read32_be(h) : 0;
    /* Reverse-lookup which resource this handle is for, to get its size. */
    uint32_t size = 0;
    for (int i = 0; i < g_n_resources; i++) {
        if (g_resources[i].addr == target) { size = g_resources[i].size; break; }
    }
    mem_write32_be(sp, size);
    /* sp pre-call: [handle, ret_slot]. Pop handle, leave ret_slot. */
    /* The Universal Header glue does: clr.l -(sp); move.l h, -(sp); _SizeRsrc; pop. */
    /* So same layout as GetResource sans short id. We pop 4 (handle), leave slot. */
    /* Actually pattern above wrote size to sp (which is where handle was);
     * we want size to end up at sp+4 after popping. Re-do cleanly. */
    uint32_t handle = mem_read32_be(sp + 4); /* re-read after our garbled write */
    (void)handle;
    /* Cleaner version: stack on entry is [id-space-not-used? no, [handle, ret_slot]].
     * Easiest: write size to sp+0 (overwriting handle) then SP unchanged (caller pops the now-size).
     * But that doesn't match Pascal — Pascal expects [args, ret_slot] and trap pops args.
     * The macro for SizeRsrc actually has form: result := SizeRsrc(h).
     * Glue: pushes h (4B), reserved ret-LongInt space (4B), trap, then pop 4B result.
     * Actually order: caller pushes RET space first, then args. So on entry:
     *   sp+0 = handle (4B)
     *   sp+4 = ret_slot (4B)
     * Trap pops 4B of arg, writes ret_slot, advances. */
    mem_write32_be(sp + 4, size);
    m68k_set_reg(M68K_REG_SP, sp + 4);
}

/* NewHandle(byteCount: Size): Handle
 * Register convention: D0 in = size, A0 out = handle, D0 out = result. */
static void stub_NewHandle(void) {
    uint32_t size = m68k_get_reg(NULL, M68K_REG_D0);
    uint32_t data = alloc_heap(size ? size : 4);
    uint32_t h = alloc_handle(data);
    m68k_set_reg(M68K_REG_A0, h);
    m68k_set_reg(M68K_REG_D0, 0);  /* noErr */
}

/* DisposeHandle(h: Handle). No-op (we don't reclaim memory). */
static void stub_DisposeHandle(void) {
    m68k_set_reg(M68K_REG_D0, 0);
}

/* HLock / HUnlock / GetHandleSize / SetHandleSize: minimal no-ops. */
static void stub_HLockUnlock(void) { m68k_set_reg(M68K_REG_D0, 0); }
static void stub_GetHandleSize(void) {
    /* Returns size in D0. We don't track sizes — return 0 (caller may
     * use this to size a buffer; that path will crash, fix when hit). */
    m68k_set_reg(M68K_REG_D0, 0);
}
static void stub_SetHandleSize(void) { m68k_set_reg(M68K_REG_D0, 0); }

/* NewPtr(byteCount: Size): Ptr. D0 = size, A0 = ptr, D0 = result. */
static void stub_NewPtr(void) {
    uint32_t size = m68k_get_reg(NULL, M68K_REG_D0);
    uint32_t p = alloc_heap(size ? size : 4);
    m68k_set_reg(M68K_REG_A0, p);
    m68k_set_reg(M68K_REG_D0, 0);
}

/* BlockMove(srcPtr, destPtr, byteCount): A0 src, A1 dst, D0 size. */
static void stub_BlockMove(void) {
    uint32_t src = m68k_get_reg(NULL, M68K_REG_A0);
    uint32_t dst = m68k_get_reg(NULL, M68K_REG_A1);
    uint32_t n   = m68k_get_reg(NULL, M68K_REG_D0);
    if (oor(src, n) || oor(dst, n)) {
        fprintf(stderr,"[BlockMove] oor src=%08x dst=%08x n=%u pc=%08x\n",
            src, dst, n, g_last_pc);
        exit(2);
    }
    memmove(RAM + dst, RAM + src, n);
    m68k_set_reg(M68K_REG_D0, 0);
}

/* StripAddress: identity in 32-bit mode. Input/output via D0 or A0;
 * Retro68 calls it on Handle data ptr. Leave registers alone. */
static void stub_StripAddress(void) { /* no-op */ }

/* ResError: returns last Resource Manager error in D0. Always 0 for us. */
static void stub_ResError(void) { m68k_set_reg(M68K_REG_D0, 0); }

/* SetResLoad(load: BOOLEAN): no return. Pop 2 bytes. */
static void stub_SetResLoad(void) {
    uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
    m68k_set_reg(M68K_REG_SP, sp + 2);
}

/* GetResAttrs(h: Handle): INTEGER. Return 0 (no attrs). */
static void stub_GetResAttrs(void) {
    uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
    mem_write16_be(sp + 4, 0);
    m68k_set_reg(M68K_REG_SP, sp + 4);
}

/* Dispatch a Toolbox A-line trap to its stub. Returns 1 if handled
 * (PC will be advanced by caller); 0 if no stub — caller will skip. */
static int dispatch_trap(uint16_t op) {
    uint16_t base = op & 0xf9ff;  /* mask off bit-9 (clear) and bit-10 (auto-pop) */
    switch (base) {
        case 0xa9a0: stub_GetResource();    return 1;
        case 0xa9a3: stub_ReleaseResource(); return 1;
        case 0xa9a4: stub_HomeResFile();    return 1;
        case 0xa994: stub_CurResFile();     return 1;
        case 0xa9a8: stub_SizeRsrc();       return 1;
        case 0xa9b9: stub_ResError();       return 1;
        case 0xa996: stub_SetResLoad();     return 1;
        case 0xa998: stub_GetResAttrs();    return 1;
        case 0xa31e: stub_NewHandle();      return 1;
        case 0xa023: stub_DisposeHandle();  return 1;
        case 0xa029:
        case 0xa02a: stub_HLockUnlock();    return 1;
        case 0xa025: stub_GetHandleSize();  return 1;
        case 0xa024: stub_SetHandleSize();  return 1;
        case 0xa11e:
        case 0xa71e: stub_NewPtr();         return 1;
        case 0xa02e: stub_BlockMove();      return 1;
        case 0xa055: stub_StripAddress();   return 1;
        /* ExitToShell exits cleanly elsewhere; don't dispatch here. */
        default:                            return 0;
    }
}

void m68k_instr_hook(unsigned int pc) {
    g_last_pc = pc;
    g_instr_count++;
    if (g_trace) {
        uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
        uint32_t stop = (sp + 4 <= RAM_BYTES) ? mem_read32_be(sp) : 0xdeadbeef;
        fprintf(stderr, "        sp=%08x [sp]=%08x\n", sp, stop);
    }
    if (g_max_instr > 0 && g_instr_count > g_max_instr) {
        fprintf(stderr,"[stop] hit --max=%ld at pc=%08x\n", g_max_instr, pc);
        fprintf(stderr,"[done] %ld insns, %ld traps, last pc=0x%08x\n",
            g_instr_count, g_aline_count, g_last_pc);
        exit(0);
    }
    uint16_t opcode = m68k_read_memory_16(pc);
    if ((opcode & 0xf000) == 0xa000) {
        const char *name = trap_name(opcode);
        g_aline_count++;
        if (opcode == 0xa9f4) {
            fprintf(stderr,"[trap @%08x] $A%03x ExitToShell\n",
                pc, opcode & 0x0fff);
            fprintf(stderr,"[done] ExitToShell at pc=%08x\n", pc);
            fprintf(stderr,"[done] %ld insns, %ld traps\n", g_instr_count, g_aline_count);
            exit(0);
        }
        int handled = dispatch_trap(opcode);
        if (!g_quiet) {
            fprintf(stderr,"[trap @%08x] $A%03x %s%s\n",
                pc, opcode & 0x0fff,
                name ? name : "(unknown)",
                handled ? "" : " [skip]");
        }
        m68k_set_reg(M68K_REG_PC, pc + 2);
        return;
    }
    if (g_trace) {
        fprintf(stderr,"[trace] %08x  %04x\n", pc, opcode);
    }
}

static int parse_macbin(const uint8_t *bytes, size_t blen,
                        struct rsrc *out, int max_out,
                        const uint8_t **rfork_out) {
    if (blen < 128) return -1;
    uint32_t data_len = be32(bytes+83);
    uint32_t rsrc_len = be32(bytes+87);
    uint32_t rsrc_start = 128 + ((data_len + 127)/128)*128;
    if (rsrc_start + rsrc_len > blen) return -1;
    const uint8_t *rfork = bytes + rsrc_start;
    if (rfork_out) *rfork_out = rfork;
    uint32_t rh_data_off = be32(rfork+0), rh_map_off = be32(rfork+4);
    uint16_t type_list_off = be16(rfork + rh_map_off + 24);
    uint16_t n_types_m1 = be16(rfork + rh_map_off + type_list_off);
    int n_types = (n_types_m1 == 0xffff) ? 0 : n_types_m1 + 1;
    int n_out = 0;
    for (int i = 0; i < n_types; i++) {
        const uint8_t *te = rfork + rh_map_off + type_list_off + 2 + i*8;
        uint32_t rtype = be32(te);
        int n_refs = be16(te+4) + 1;
        uint16_t ref_off = be16(te+6);
        for (int j = 0; j < n_refs; j++) {
            const uint8_t *re = rfork + rh_map_off + type_list_off + ref_off + j*12;
            int16_t rid = (int16_t)be16(re);
            uint32_t data_off_24 = ((uint32_t)re[5]<<16)|((uint32_t)re[6]<<8)|re[7];
            uint32_t data_abs = rh_data_off + data_off_24;
            uint32_t data_size = be32(rfork+data_abs);
            if (n_out < max_out) {
                /* Data ptr will be filled in by load_binary after it copies
                 * the bytes into RAM. Use `addr` for now to stash the offset
                 * into rfork; load_binary resolves to a real address. */
                out[n_out++] = (struct rsrc){
                    .type=rtype, .id=rid, .size=data_size,
                    .addr=data_abs + 4,
                };
            }
        }
    }
    return n_out;
}

static void load_binary(const char *path) {
    FILE *f = fopen(path,"rb");
    if (!f) { perror(path); exit(1); }
    fseek(f,0,SEEK_END); long sz = ftell(f); fseek(f,0,SEEK_SET);
    uint8_t *bytes = malloc(sz);
    if (!bytes || fread(bytes,1,sz,f) != (size_t)sz) { perror(path); exit(1); }
    fclose(f);

    const uint8_t *rfork = NULL;
    int n = parse_macbin(bytes, sz, g_resources, 256, &rfork);
    if (n < 0) { fprintf(stderr,"not MacBinary II: %s\n", path); exit(1); }
    g_n_resources = n;

    const struct rsrc *code0 = NULL;
    for (int i = 0; i < n; i++)
        if (g_resources[i].type == 0x434f4445 && g_resources[i].id == 0) code0 = &g_resources[i];
    if (!code0) { fprintf(stderr,"no CODE 0\n"); exit(1); }
    /* code0->addr is currently an offset into rfork; deref via rfork. */
    const uint8_t *code0_data = rfork + (code0->addr - 4) + 4;
    uint32_t above_a5 = be32(code0_data+0);
    uint32_t below_a5 = be32(code0_data+4);
    uint32_t jt_size  = be32(code0_data+8);
    uint32_t jt_a5off = be32(code0_data+12);
    fprintf(stderr,"[setup] above_a5=%u below_a5=%u jt_size=%u jt_a5_off=0x%x jt_entries=%u\n",
        above_a5, below_a5, jt_size, jt_a5off, jt_size/8);

    a5_value = A5_WORLD + below_a5;
    memcpy(RAM + a5_value + jt_a5off, code0_data + 16, jt_size);

    /* Walk every resource, load each into RAM, and resolve its addr.
     * CODE 1+ goes at SEG_BASE + (id-1)*0x10000 (the seg-table layout
     * expected by libretrocrt). Everything else (RELA, SIZE, BNDL,
     * STR/STR#, etc) gets copied into the heap region so GetResource
     * can hand out a Handle pointing at it. */
    uint32_t seg1_addr = 0;
    for (int i = 0; i < n; i++) {
        struct rsrc *r = &g_resources[i];
        const uint8_t *src = rfork + (r->addr - 4) + 4;  /* current addr = file offset */
        if (r->type == 0x434f4445 && r->id >= 1) {
            uint32_t addr = SEG_BASE + (r->id - 1) * 0x10000;
            memcpy(RAM + addr, src, r->size);
            r->addr = addr;
            if (r->id == 1) seg1_addr = addr;
            fprintf(stderr,"[setup] CODE %d at 0x%08x (%u B)\n",
                r->id, addr, r->size);
        } else if (r->type == 0x434f4445 && r->id == 0) {
            /* CODE 0 was used to set up the A5 world; we keep it in
             * the heap for GetResource('CODE', 0) — Retro68's relocator
             * may need to walk it. */
            uint32_t addr = alloc_heap(r->size);
            memcpy(RAM + addr, src, r->size);
            r->addr = addr;
        } else {
            uint32_t addr = alloc_heap(r->size);
            memcpy(RAM + addr, src, r->size);
            r->addr = addr;
            if (!g_quiet) {
                char t[5]={r->type>>24,r->type>>16,r->type>>8,r->type,0};
                fprintf(stderr,"[setup] '%s' %d → 0x%08x (%u B)\n",
                    t, r->id, addr, r->size);
            }
        }
    }
    if (!seg1_addr) { fprintf(stderr,"no CODE 1\n"); exit(1); }
    pc_start = seg1_addr + 4;
    fprintf(stderr,"[setup] PC = 0x%08x (entry trampoline)\n", pc_start);
    fprintf(stderr,"[setup] heap %u/%u B used after resource load\n",
        (uint32_t)(g_heap_next - HEAP_BASE), (uint32_t)(HEAP_TOP - HEAP_BASE));
}

int main(int argc, char **argv) {
    const char *path = NULL;
    for (int i = 1; i < argc; i++) {
        if      (!strcmp(argv[i],"--trace")) g_trace = 1;
        else if (!strcmp(argv[i],"--quiet")) g_quiet = 1;
        else if (!strncmp(argv[i],"--max=",6)) g_max_instr = atol(argv[i]+6);
        else if (argv[i][0] != '-')           path = argv[i];
        else { fprintf(stderr,"unknown: %s\n", argv[i]); return 1; }
    }
    if (!path) { fprintf(stderr,"usage: m68k-run [--trace] [--max=N] BIN\n"); return 1; }

    RAM = calloc(1, RAM_BYTES);
    if (!RAM) { perror("calloc"); return 1; }
    load_binary(path);

    mem_write32_be(0x0000, RAM_BYTES - 16);
    mem_write32_be(0x0004, pc_start);
    m68k_init();
    m68k_set_cpu_type(M68K_CPU_TYPE_68020);
    m68k_set_instr_hook_callback(m68k_instr_hook);
    m68k_pulse_reset();
    m68k_set_reg(M68K_REG_A5, a5_value);

    fprintf(stderr,"[run] pc=0x%08x sp=0x%08x a5=0x%08x max=%ld\n",
        (uint32_t)m68k_get_reg(NULL,M68K_REG_PC),
        (uint32_t)m68k_get_reg(NULL,M68K_REG_SP),
        a5_value, g_max_instr);

    while (g_instr_count < g_max_instr) {
        m68k_execute(1000);
    }
    fprintf(stderr,"[done] %ld insns, %ld traps, last pc=0x%08x\n",
        g_instr_count, g_aline_count, g_last_pc);
    return 0;
}
