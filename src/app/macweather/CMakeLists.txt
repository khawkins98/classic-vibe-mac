# MacWeather — classic Mac 68k weather app.
#
# Built by the top-level src/app/CMakeLists.txt aggregator. Outputs land
# in build/macweather/:
#   MacWeather.bin    — MacBinary (both forks; the canonical artifact)
#   MacWeather.dsk    — mountable HFS disk image containing the app
#   MacWeather.APPL   — data fork only

# CREATOR "CVMW" — Classic Vibe Mac Weather. Stamps the MacBinary header
# so the Finder treats this binary as the registered owner of any
# documents bound to 'CVMW' (we don't ship any doc types yet).
add_application(MacWeather
    CREATOR CVMW
    macweather.c
    weather_parse.c
    weather_glyphs.c
    macweather.r
)

set_target_properties(MacWeather PROPERTIES COMPILE_OPTIONS -ffunction-sections)
if(CMAKE_SYSTEM_NAME MATCHES Retro68)
    set_target_properties(MacWeather PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections -Wl,--mac-strip-macsbug")
else()
    set_target_properties(MacWeather PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections")
endif()
