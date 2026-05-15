/*
 * runner.c — minimum-viable m68k boot tracer for in-browser-built
 * MacBinary II APPLs (cv-mac #89).
 *
 * Loads a `.bin` produced by cv-mac's compileToBin, lays out CODE 0's
 * A5 world + CODE 1's code, points the m68k PC at the entry
 * trampoline, and runs the binary through the embedded Musashi CPU
 * emulator for a cycle budget. Logs:
 *
 *   - each instruction's PC + opcode (when --trace)
 *   - every A-line (0xA000-0xAFFF) trap with its number and a symbol
 *     guess from the well-known set
 *   - exit reason
 *
 * Not a Mac OS emulator. There is no Process Manager, no Heap
 * Manager, no Toolbox. When the running code hits an A-line trap we
 * log it and skip past the trap word so execution continues. That's
 * enough to see whether libretrocrt's `_start` reaches `main`, where
 * `Retro68Relocate` dies, what traps `main` makes, etc.
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

struct rsrc { uint32_t type; int id; uint32_t size; const uint8_t *data; };

static int parse_macbin(const uint8_t *bytes, size_t blen,
                        struct rsrc *out, int max_out) {
    if (blen < 128) return -1;
    uint32_t data_len = be32(bytes+83);
    uint32_t rsrc_len = be32(bytes+87);
    uint32_t rsrc_start = 128 + ((data_len + 127)/128)*128;
    if (rsrc_start + rsrc_len > blen) return -1;
    const uint8_t *rfork = bytes + rsrc_start;
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
                out[n_out++] = (struct rsrc){
                    .type=rtype, .id=rid, .size=data_size,
                    .data=rfork+data_abs+4,
                };
            }
        }
    }
    return n_out;
}

/* Toolbox trap name lookup. Covers what libretrocrt + the bundled
 * hello.c hit. Anything not listed shows as raw "$Axxx" in trace. */
static const char *trap_name(uint16_t op) {
    if ((op & 0xf000) != 0xa000) return NULL;
    switch (op) {
        case 0xa055: return "StripAddress";
        case 0xa063: return "MaxApplZone";
        case 0xa036: return "MoreMasters";
        case 0xa11e: return "NewPtr";
        case 0xa31e: return "NewHandle";
        case 0xa023: return "DisposeHandle";
        case 0xa029: return "HLock";
        case 0xa02a: return "HUnlock";
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
        default:     return NULL;
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
        if (!g_quiet) {
            fprintf(stderr,"[trap @%08x] $A%03x %s\n",
                pc, opcode & 0x0fff, name ? name : "(unknown)");
        }
        if (opcode == 0xa9f4) {
            fprintf(stderr,"[done] ExitToShell at pc=%08x\n", pc);
            fprintf(stderr,"[done] %ld insns, %ld traps\n", g_instr_count, g_aline_count);
            exit(0);
        }
        m68k_set_reg(M68K_REG_PC, pc + 2);
        return;
    }
    if (g_trace) {
        fprintf(stderr,"[trace] %08x  %04x\n", pc, opcode);
    }
}

static void load_binary(const char *path) {
    FILE *f = fopen(path,"rb");
    if (!f) { perror(path); exit(1); }
    fseek(f,0,SEEK_END); long sz = ftell(f); fseek(f,0,SEEK_SET);
    uint8_t *bytes = malloc(sz);
    if (!bytes || fread(bytes,1,sz,f) != (size_t)sz) { perror(path); exit(1); }
    fclose(f);

    struct rsrc rs[64];
    int n = parse_macbin(bytes, sz, rs, 64);
    if (n < 0) { fprintf(stderr,"not MacBinary II: %s\n", path); exit(1); }

    const struct rsrc *code0 = NULL;
    for (int i = 0; i < n; i++)
        if (rs[i].type == 0x434f4445 && rs[i].id == 0) code0 = &rs[i];
    if (!code0) { fprintf(stderr,"no CODE 0\n"); exit(1); }
    uint32_t above_a5 = be32(code0->data+0);
    uint32_t below_a5 = be32(code0->data+4);
    uint32_t jt_size  = be32(code0->data+8);
    uint32_t jt_a5off = be32(code0->data+12);
    fprintf(stderr,"[setup] above_a5=%u below_a5=%u jt_size=%u jt_a5_off=0x%x jt_entries=%u\n",
        above_a5, below_a5, jt_size, jt_a5off, jt_size/8);

    a5_value = A5_WORLD + below_a5;
    memcpy(RAM + a5_value + jt_a5off, code0->data + 16, jt_size);

    uint32_t seg1_addr = 0;
    for (int i = 0; i < n; i++) {
        if (rs[i].type != 0x434f4445 || rs[i].id < 1) continue;
        uint32_t addr = SEG_BASE + (rs[i].id - 1) * 0x10000;
        memcpy(RAM + addr, rs[i].data, rs[i].size);
        if (rs[i].id == 1) seg1_addr = addr;
        fprintf(stderr,"[setup] CODE %d at 0x%08x (%u B)\n",
            rs[i].id, addr, rs[i].size);
    }
    if (!seg1_addr) { fprintf(stderr,"no CODE 1\n"); exit(1); }
    pc_start = seg1_addr + 4;
    fprintf(stderr,"[setup] PC = 0x%08x (entry trampoline)\n", pc_start);
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
