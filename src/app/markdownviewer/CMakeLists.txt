# Markdown Viewer — classic Mac 68k Markdown reader.
#
# Outputs in build/markdownviewer/:
#   MarkdownViewer.bin  — MacBinary (canonical artifact)
#   MarkdownViewer.dsk  — mountable HFS disk image
#   MarkdownViewer.APPL — data fork (usually 0 bytes)

add_application(MarkdownViewer
    CREATOR CVMV
    markdownviewer.c
    markdown_parse.c
    markdownviewer.r
)

set_target_properties(MarkdownViewer PROPERTIES COMPILE_OPTIONS -ffunction-sections)
if(CMAKE_SYSTEM_NAME MATCHES Retro68)
    set_target_properties(MarkdownViewer PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections -Wl,--mac-strip-macsbug")
else()
    set_target_properties(MarkdownViewer PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections")
endif()
