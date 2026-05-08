# HelloMac — the smallest possible classic Mac 68k app in this repo.
#
# Built by the top-level src/app/CMakeLists.txt aggregator. See its
# header for invocation. Outputs land in build/hello-mac/:
#   HelloMac.bin    — MacBinary (both forks; the canonical artifact)
#   HelloMac.dsk    — mountable HFS disk image containing the app
#   HelloMac.APPL   — data fork only
#
# This app exists as the friendliest first read of "what does a System 7
# Toolbox app actually look like?". It's deliberately simpler than Reader
# and MacWeather — one window, one string, a menu bar, an About box, and
# a Quit path. Newcomers should be able to read hello.c top-to-bottom in
# a few minutes.

# CREATOR "CVHM" — Classic Vibe Hello Mac. Stamps the MacBinary header
# so the Finder treats this binary as the registered owner of any
# documents bound to 'CVHM' (we don't ship any doc types). The
# signature resource alone is NOT sufficient — Retro68's
# add_application defaults the .bin's Type/Creator to APPL/???? unless
# we override it here.
add_application(HelloMac
    CREATOR CVHM
    hello.c
    hello.r
)

# Match Reader/MacWeather: strip dead code + MacsBug names so the binary
# stays small. Drop --mac-strip-macsbug if you ever need readable stack
# traces while debugging.
set_target_properties(HelloMac PROPERTIES COMPILE_OPTIONS -ffunction-sections)
if(CMAKE_SYSTEM_NAME MATCHES Retro68)
    set_target_properties(HelloMac PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections -Wl,--mac-strip-macsbug")
else()
    set_target_properties(HelloMac PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections")
endif()
