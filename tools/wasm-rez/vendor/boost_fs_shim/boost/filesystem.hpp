/*
 * Header shim: maps boost::filesystem onto std::filesystem.
 *
 * Used by the spike's "mini" build (no Boost) to compile ResourceFile.cc
 * unchanged. We give boost::filesystem the same API surface that
 * ResourceFile.cc actually exercises (path, ofstream, ifstream,
 * create_directory). Anything else triggers a compile error, which is
 * what we want — the spike's path through ResourceFile.cc is narrow
 * (applesingle / macbin / appledouble), not all formats.
 */
#ifndef SPIKE_BOOST_FS_SHIM_HPP
#define SPIKE_BOOST_FS_SHIM_HPP

#include <filesystem>
#include <fstream>

namespace boost {
namespace filesystem {
    using path = std::filesystem::path;
    using ofstream = std::ofstream;
    using ifstream = std::ifstream;

    inline bool create_directory(const path& p) {
        std::error_code ec;
        return std::filesystem::create_directory(p, ec);
    }
}
}

#endif
