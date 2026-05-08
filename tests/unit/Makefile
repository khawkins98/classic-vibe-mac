# Unit tests for host-compilable Mac app code.
#
# Convention: any function in src/app/ that does NOT call MacToolbox APIs
# (QuickDraw, WindowManager, Events, etc.) can be unit-tested here by
# compiling with the host gcc/clang. This bypasses Retro68 entirely so the
# test loop is sub-second.
#
# html_parse.c is the pure-C HTML tokenizer + layout for the Reader app.
# reader.c is the Toolbox shell and is NOT host-compilable.

CC      ?= cc
CFLAGS  ?= -std=c99 -Wall -Wextra -O0 -g -DUNIT_TEST
INCLUDES = -I. -I../../src/app

HTML_PARSE = ../../src/app/html_parse.c

TESTS = test_html_parse

.PHONY: all clean run

all: $(TESTS)

test_html_parse: test_html_parse.c $(HTML_PARSE) ../../src/app/html_parse.h
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ test_html_parse.c $(HTML_PARSE)

run: all
	@set -e; \
	for t in $(TESTS); do \
		echo "==> ./$$t"; \
		./$$t; \
	done
	@echo "All unit tests passed."

clean:
	rm -f $(TESTS)
