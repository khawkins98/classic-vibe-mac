/*
 * Rez_main.cc — replacement for Retro68's Rez.cc in the spike's mini build.
 *
 * Drops boost::program_options and boost::filesystem. Just enough to drive
 * the compile pipeline: parse a single .r file, write a single output file
 * in MacBinary format (the same default the original Rez uses).
 *
 * Usage:
 *   mini-rez [-I path] [-D macro=value] [-o output] input.r
 *
 * Output format: MacBinary (single-fork, type 'rsrc', creator 'RSED').
 * Matches `rez input.r -o output.bin` from the upstream tool.
 */

#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "RezParser.generated.hh"
#include "RezLexer.h"
#include "RezWorld.h"

#include "ResourceFile.h"
#include "BinaryIO.h"
#include "Diagnostic.h"

static void usage() {
    std::cerr << "Usage: mini-rez [options] input.r\n"
              << "  -o FILE    output file (default: rez.output.rsrc)\n"
              << "  -I PATH    add include path\n"
              << "  -D MACRO   define preprocessor macro (no #include support in spike)\n";
}

int main(int argc, const char *argv[])
{
    std::string outfile = "rez.output.rsrc";
    std::vector<std::string> defines;
    std::vector<std::string> includes;
    std::vector<std::string> inputs;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "-h" || a == "--help") { usage(); return 0; }
        else if (a == "-o" && i + 1 < argc) outfile = argv[++i];
        else if (a == "-I" && i + 1 < argc) includes.push_back(argv[++i]);
        else if (a == "-D" && i + 1 < argc) defines.push_back(argv[++i]);
        else if (!a.empty() && a[0] == '-') {
            std::cerr << "unknown option: " << a << "\n"; usage(); return 1;
        }
        else inputs.push_back(a);
    }

    if (inputs.empty()) { usage(); return 1; }

    RezWorld world;

    for (const auto& f : inputs) {
        try {
            RezLexer lexer(world, f);
            for (const auto& d : defines) lexer.addDefine(d);
            for (const auto& I : includes) lexer.addIncludePath(I);

            yy::RezParser parser(lexer, world);
            int rc = parser.parse();
            if (rc != 0) {
                std::cerr << "parse failed for " << f << "\n";
                return 2;
            }
        } catch (const std::exception& e) {
            std::cerr << "error processing " << f << ": " << e.what() << "\n";
            return 3;
        }
    }

    if (world.hadErrors) {
        std::cerr << "rez: errors reported, no output written\n";
        return 4;
    }

    // Write MacBinary output (matches the default of upstream Rez).
    ResourceFile rsrcFile;
    rsrcFile.resources = world.getResources();
    rsrcFile.type = ResType(std::string("rsrc"));
    rsrcFile.creator = ResType(std::string("RSED"));
    rsrcFile.write(outfile);

    return 0;
}
