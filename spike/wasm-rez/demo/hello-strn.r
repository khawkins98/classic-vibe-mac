/*
 * Minimal STR# Rez input for the spike.
 * Vendors the STR# type definition inline so we don't need to feed Rez
 * Multiverse.r as an include — keeps the test self-contained.
 *
 * Expected output (resource fork only): one resource of type 'STR#',
 * id 128, with two pstrings "Hello" and "World".
 */

type 'STR#' {
    integer = $$CountOf(strings);
    array strings { pstring; };
};

resource 'STR#' (128) {
    {
        "Hello",
        "World"
    }
};
