# PixelPad — 64×64 1-bit pixel editor for classic-vibe-mac.
#
# Output artifacts (in build/pixelpad/):
#   PixelPad.bin    — MacBinary (canonical artifact for boot-disk)
#   PixelPad.dsk    — mountable HFS disk image
#   PixelPad.APPL   — data fork only

# CREATOR 'CVPP' — Classic Vibe Pixel Pad.
add_application(PixelPad
    CREATOR CVPP
    pixelpad.c
    pixelpad.r
)

set_target_properties(PixelPad PROPERTIES COMPILE_OPTIONS -ffunction-sections)
if(CMAKE_SYSTEM_NAME MATCHES Retro68)
    set_target_properties(PixelPad PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections -Wl,--mac-strip-macsbug")
else()
    set_target_properties(PixelPad PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections")
endif()
