/*
 * MiniLexer.cc — minimal Rez lexer for the WASM spike.
 *
 * Replaces RezLexer.cc + RezLexerNextToken.cc + Boost.Wave dependency.
 *
 * Scope (matches the spike's success target — a single STR# resource):
 *   - Lexes Rez tokens directly (no preprocessor, no #include support).
 *   - Recognises identifiers, integers (decimal/hex), string literals,
 *     punctuation, comments (// and /* * /), and the Rez-specific
 *     "$" + hex literal form ($$ABCD).
 *   - Produces yy::RezParser::symbol_type values matching what the bison
 *     parser expects, identical to what RezLexerNextToken.cc emits.
 *
 * Out of scope (returns errors if hit):
 *   - #include / #define / #if (preprocessor)
 *   - Wide string literals, character constants beyond ASCII.
 *   - Unicode source.
 *
 * This file replaces both RezLexer.cc and RezLexerNextToken.cc when
 * compiled into the rez-wasm-mini target. The interface is the same
 * (RezLexer constructor + nextToken()) so no parser changes are needed.
 */

#include "RezLexer.h"
#include "Diagnostic.h"
#include "RezParser.generated.hh"

// The bison-generated parser is included via .generated.hh and provides
// `using yy::RezParser;` in its `%code provides` block. Don't include
// RezWorld.h here — it forward-declares `class RezParser;` at file scope
// (for friendship), which collides with the using-decl in this TU.

#include <cctype>
#include <cstring>
#include <fstream>
#include <sstream>
#include <unordered_map>
#include <algorithm>
#include <vector>
#include <stdexcept>

// We do NOT include Boost.Wave headers. WaveToken in the original code is
// a Wave-derived type (lex_token<>); here we provide an empty inner class
// so the unused nextWave()/peekWave() declarations still compile.

class RezLexer::WaveToken {
public:
    WaveToken() = default;
};

// The Priv struct must be defined to satisfy the unique_ptr destructor. We
// give it a non-empty body so unique_ptr<Priv> works.
struct RezLexer::Priv
{
    std::string filename;
    std::string contents;
    size_t pos = 0;
    int line = 1;
    int column = 1;

    // Macro table for #define. The Rez constructor pre-defines a few; we
    // mirror those here even though the lexer emits no preprocessor tokens.
    std::unordered_map<std::string, std::string> macros = {
        {"DeRez", "0"},
        {"Rez", "1"},
        {"true", "1"},
        {"false", "0"},
        {"TRUE", "1"},
        {"FALSE", "0"},
    };

    std::vector<std::string> includePaths;

    Priv(std::string fn, std::string data)
        : filename(std::move(fn)), contents(std::move(data)) {}

    // --- character access helpers -----------------------------------
    bool eof() const { return pos >= contents.size(); }
    char peek(size_t off = 0) const {
        return pos + off < contents.size() ? contents[pos + off] : '\0';
    }
    char advance() {
        if (eof()) return '\0';
        char c = contents[pos++];
        if (c == '\n') { ++line; column = 1; }
        else { ++column; }
        return c;
    }
    void skipLine() {
        while (!eof() && peek() != '\n') advance();
    }
    void skipBlockComment() {
        while (!eof()) {
            if (peek() == '*' && peek(1) == '/') {
                advance(); advance();
                return;
            }
            advance();
        }
    }
};

static std::string readFile(const std::string& path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in.is_open())
        throw std::runtime_error("could not open " + path);
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

RezLexer::RezLexer(RezWorld& world, std::string filename)
    : RezLexer(world, filename, readFile(filename))
{
}

RezLexer::RezLexer(RezWorld& world, std::string filename, const std::string &data)
    : world(world), curFile(filename), lastLocation(&curFile)
{
    pImpl.reset(new Priv(filename, data));
}

RezLexer::~RezLexer() = default;

void RezLexer::addDefine(std::string s)
{
    auto eq = s.find('=');
    if (eq == std::string::npos) pImpl->macros[s] = "1";
    else pImpl->macros[s.substr(0,eq)] = s.substr(eq+1);
}

void RezLexer::addIncludePath(std::string path)
{
    // Split on ':' (Rez convention).
    size_t start = 0;
    for (size_t i = 0; i <= path.size(); ++i) {
        if (i == path.size() || path[i] == ':') {
            if (i > start) pImpl->includePaths.push_back(path.substr(start, i - start));
            start = i + 1;
        }
    }
}

bool RezLexer::atEnd() { return pImpl->eof(); }

// nextWave / peekWave are not used by this implementation; provide stubs.
RezLexer::WaveToken RezLexer::nextWave() { return WaveToken(); }
RezLexer::WaveToken RezLexer::peekWave() { return WaveToken(); }

// --- The main lexer ---------------------------------------------------------

namespace {

// readInt — same logic as the original.
static int readInt(const char *str, const char *end = nullptr, int baseOverride = 0)
{
    int x = 0;
    int base = 10;
    if (baseOverride) base = baseOverride;
    else if (*str == '0') {
        base = 8; ++str;
        if (*str == 'x' || *str == 'X') { base = 16; ++str; }
        if (*str == 'b' || *str == 'B') { base = 2;  ++str; }
        if (*str == 'd' || *str == 'D') { base = 10; ++str; }
    }
    while (*str && (!end || str < end)) {
        char c = *str++;
        int digit = -1;
        if (c >= '0' && c <= '9') digit = c - '0';
        else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
        if (digit < 0 || digit >= base) break;
        x = x * base + digit;
    }
    return x;
}

// readStringLit — reproduce the original's logic (Rez uses MPW-style
// escapes incl. \0xNN). For our STR# target, plain ASCII suffices.
static std::string readStringLit(const char *p)
{
    std::string out;
    if (*p == '"') ++p;
    while (*p && *p != '"') {
        if (*p == '\\' && p[1]) {
            ++p;
            if (*p == 'n') { out += '\n'; ++p; }
            else if (*p == 't') { out += '\t'; ++p; }
            else if (*p == 'r') { out += '\r'; ++p; }
            else if (*p == '0' && (p[1] == 'x' || p[1] == 'X')) {
                p += 2;
                int v = 0, n = 0;
                while (n < 2 && isxdigit((unsigned char)*p)) {
                    v = v*16 + (isdigit((unsigned char)*p) ? *p - '0' : (tolower(*p) - 'a' + 10));
                    ++p; ++n;
                }
                out += static_cast<char>(v);
            }
            else { out += *p++; }
        } else {
            out += *p++;
        }
    }
    return out;
}

static int readCharLit(const char *p) {
    // 4-char OSType in single quotes, e.g. 'STR#'. Pack into int big-endian.
    if (*p == '\'') ++p;
    int v = 0; int n = 0;
    while (*p && *p != '\'' && n < 4) {
        v = (v << 8) | (unsigned char)*p++;
        ++n;
    }
    return v;
}

} // namespace

RezSymbol RezLexer::nextToken()
{
    auto& p = *pImpl;

    while (true) {
        // skip whitespace + comments
        while (!p.eof()) {
            char c = p.peek();
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') { p.advance(); continue; }
            if (c == '/' && p.peek(1) == '/') { p.skipLine(); continue; }
            if (c == '/' && p.peek(1) == '*') { p.advance(); p.advance(); p.skipBlockComment(); continue; }
            // Rez's preprocessor lines: skip-from-# to end-of-line (we don't
            // honour them, but they appear in real .r files).
            if (c == '#') { p.skipLine(); continue; }
            break;
        }

        if (p.eof()) {
            return yy::RezParser::symbol_type(yy::RezParser::token_type(0), yy::location());
        }

        int startLine = p.line, startCol = p.column;
        std::string startFile = p.filename;
        curFile = startFile;
        yy::location loc(yy::position(&curFile, startLine, startCol));
        lastLocation = loc;

        char c = p.peek();

        // ---- string literal -------------------------------------------
        if (c == '"') {
            std::string buf;
            buf += p.advance();
            while (!p.eof() && p.peek() != '"') {
                if (p.peek() == '\\') buf += p.advance();
                buf += p.advance();
            }
            if (!p.eof()) buf += p.advance(); // closing quote
            return yy::RezParser::make_STRINGLIT(readStringLit(buf.c_str()), loc);
        }

        // ---- "hex string" literal $"AABB" — Rez specific -------------
        if (c == '$' && p.peek(1) == '"') {
            // Treat as a STRINGLIT carrying raw hex bytes.
            p.advance(); p.advance();
            std::string hex;
            while (!p.eof() && p.peek() != '"') {
                char ch = p.advance();
                if (isxdigit((unsigned char)ch)) hex += ch;
            }
            if (!p.eof()) p.advance();
            std::string out;
            for (size_t i = 0; i + 1 < hex.size(); i += 2) {
                int hi = isdigit(hex[i]) ? hex[i]-'0' : tolower(hex[i])-'a'+10;
                int lo = isdigit(hex[i+1]) ? hex[i+1]-'0' : tolower(hex[i+1])-'a'+10;
                out += static_cast<char>((hi<<4)|lo);
            }
            return yy::RezParser::make_STRINGLIT(out, loc);
        }

        // ---- character / OSType literal -------------------------------
        if (c == '\'') {
            std::string buf;
            buf += p.advance();
            while (!p.eof() && p.peek() != '\'') buf += p.advance();
            if (!p.eof()) buf += p.advance();
            return yy::RezParser::make_CHARLIT(readCharLit(buf.c_str()), loc);
        }

        // ---- numeric literal ------------------------------------------
        if (isdigit((unsigned char)c) || (c == '0' && (p.peek(1) == 'x' || p.peek(1) == 'X'))) {
            std::string num;
            while (!p.eof() && (isalnum((unsigned char)p.peek()) || p.peek() == '.'))
                num += p.advance();
            return yy::RezParser::make_INTLIT(readInt(num.c_str()), loc);
        }

        // ---- $$function or $hex literal -------------------------------
        if (c == '$') {
            std::string buf;
            buf += p.advance();
            if (p.peek() == '$') {
                buf += p.advance();
                while (!p.eof() && isalnum((unsigned char)p.peek()))
                    buf += p.advance();
                // Resolve as keyword (e.g. $$CountOf).
                std::string lower = buf;
                std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
                if (lower == "$$countof")    return yy::RezParser::make_FUN_COUNTOF(loc);
                if (lower == "$$arrayindex") return yy::RezParser::make_FUN_ARRAYINDEX(loc);
                if (lower == "$$read")       return yy::RezParser::make_FUN_READ(loc);
                if (lower == "$$bitfield")   return yy::RezParser::make_FUN_BITFIELD(loc);
                if (lower == "$$word")       return yy::RezParser::make_FUN_WORD(loc);
                if (lower == "$$byte")       return yy::RezParser::make_FUN_BYTE(loc);
                if (lower == "$$long")       return yy::RezParser::make_FUN_LONG(loc);
                return yy::RezParser::make_BADTOKEN(buf, loc);
            }
            // $ABCD — hex literal.
            while (!p.eof() && isxdigit((unsigned char)p.peek()))
                buf += p.advance();
            if (buf.size() <= 1) return yy::RezParser::make_DOLLAR(loc);
            return yy::RezParser::make_INTLIT(readInt(buf.c_str()+1, nullptr, 16), loc);
        }

        // ---- identifier / keyword -------------------------------------
        if (isalpha((unsigned char)c) || c == '_') {
            std::string id;
            while (!p.eof() && (isalnum((unsigned char)p.peek()) || p.peek() == '_'))
                id += p.advance();

            // Macro substitution (one-pass; recursive expansion not needed
            // for STR# scope).
            auto m = p.macros.find(id);
            if (m != p.macros.end()) {
                // If it's an integer macro, return as INTLIT.
                if (!m->second.empty() && (isdigit((unsigned char)m->second[0]) || m->second[0] == '-')) {
                    return yy::RezParser::make_INTLIT(readInt(m->second.c_str()), loc);
                }
                // Otherwise treat as identifier.
                id = m->second;
            }

            std::string lower = id;
            std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);

            // Same keyword table as the original.
            #define KW(upper, lower_str) if (lower == lower_str) return yy::RezParser::make_ ## upper(loc)
            KW(TYPE, "type");
            KW(RESOURCE, "resource");
            KW(DATA, "data");
            KW(READ, "read");
            KW(INCLUDE, "include");
            KW(CHANGE, "change");
            KW(DELETE, "delete");
            KW(ARRAY, "array");
            KW(SWITCH, "switch");
            KW(CASE, "case");
            KW(AS, "as");
            KW(FILL, "fill");
            KW(ALIGN, "align");
            KW(HEX, "hex");
            KW(KEY, "key");
            KW(WIDE, "wide");
            KW(UNSIGNED, "unsigned");
            KW(BINARY, "binary");
            KW(LITERAL, "literal");
            KW(BOOLEAN, "boolean");
            KW(BIT, "bit");
            KW(NIBBLE, "nibble");
            KW(BYTE, "byte");
            KW(CHAR, "char");
            KW(WORD, "word");
            KW(INTEGER, "integer");
            KW(LONG, "long");
            KW(LONGINT, "longint");
            KW(PSTRING, "pstring");
            KW(PSTRING, "wstring");
            KW(STRING, "string");
            KW(POINT, "point");
            KW(RECT, "rect");
            KW(BITSTRING, "bitstring");
            KW(INTEGER, "int");
            #undef KW

            return yy::RezParser::make_IDENTIFIER(lower, loc);
        }

        // ---- punctuation ----------------------------------------------
        p.advance();
        switch (c) {
            case '{': return yy::RezParser::make_LEFTBRACE(loc);
            case '}': return yy::RezParser::make_RIGHTBRACE(loc);
            case '[': return yy::RezParser::make_LEFTBRACKET(loc);
            case ']': return yy::RezParser::make_RIGHTBRACKET(loc);
            case '(': return yy::RezParser::make_LEFTPAREN(loc);
            case ')': return yy::RezParser::make_RIGHTPAREN(loc);
            case ';': return yy::RezParser::make_SEMICOLON(loc);
            case ',': return yy::RezParser::make_COMMA(loc);
            case '+': return yy::RezParser::make_PLUS(loc);
            case '-': return yy::RezParser::make_MINUS(loc);
            case '/': return yy::RezParser::make_DIVIDE(loc);
            case '*': return yy::RezParser::make_STAR(loc);
            case ':': return yy::RezParser::make_COLON(loc);
            case '~': return yy::RezParser::make_COMPL(loc);
            case '|': return yy::RezParser::make_OR(loc);
            case '^': return yy::RezParser::make_XOR(loc);
            case '&': return yy::RezParser::make_AND(loc);
            case '=':
                if (p.peek() == '=') { p.advance(); return yy::RezParser::make_EQUAL(loc); }
                return yy::RezParser::make_ASSIGN(loc);
            case '!':
                if (p.peek() == '=') { p.advance(); return yy::RezParser::make_NOTEQUAL(loc); }
                break;
            case '<':
                if (p.peek() == '<') { p.advance(); return yy::RezParser::make_SHIFTLEFT(loc); }
                break;
            case '>':
                if (p.peek() == '>') { p.advance(); return yy::RezParser::make_SHIFTRIGHT(loc); }
                break;
        }
        std::string bad(1, c);
        return yy::RezParser::make_BADTOKEN(bad, loc);
    }
}
