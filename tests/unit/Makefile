# Unit tests for host-compilable Mac app code.
#
# Convention: any function in src/app/<app>/ that does NOT call MacToolbox
# APIs (QuickDraw, WindowManager, Events, etc.) can be unit-tested here by
# compiling with the host gcc/clang. This bypasses Retro68 entirely so the
# test loop is sub-second.
#
# MarkdownViewer: markdown_parse.c is the pure-C markdown tokenizer.
# Toolbox shells (markdownviewer.c) are NOT host-compilable.
#
# Reader / MacWeather's test_html_parse and test_weather_parse were
# retired with the apps themselves (#276).

CC      ?= cc
CFLAGS  ?= -std=c99 -Wall -Wextra -O0 -g -DUNIT_TEST

MARKDOWNVIEWER_SRC = ../../src/app/markdownviewer

MARKDOWN_PARSE  = $(MARKDOWNVIEWER_SRC)/markdown_parse.c

TESTS = test_md_parse

.PHONY: all clean run

all: $(TESTS)

test_md_parse: test_md_parse.c $(MARKDOWN_PARSE) $(MARKDOWNVIEWER_SRC)/markdown_parse.h
	$(CC) $(CFLAGS) -I. -I$(MARKDOWNVIEWER_SRC) -o $@ test_md_parse.c $(MARKDOWN_PARSE)

# Just runs the host-cc C suite. The JS unit tests (preprocessor.test.mjs
# + hfs-patcher.test.mjs) live under `npm run test:unit:js` so this
# Makefile stays tsc-free; `npm run test:unit` chains both halves.
run: all
	@set -e; \
	for t in $(TESTS); do \
		echo "==> ./$$t"; \
		./$$t; \
	done
	@echo "All host C unit tests passed."

clean:
	rm -f $(TESTS)
