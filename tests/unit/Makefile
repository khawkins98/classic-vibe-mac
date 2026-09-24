# Unit tests for host-compilable Mac app code.
#
# Convention: any function in src/app/<app>/ that does NOT call MacToolbox
# APIs (QuickDraw, WindowManager, Events, etc.) can be unit-tested here by
# compiling with the host gcc/clang. This bypasses Retro68 entirely so the
# test loop is sub-second.
#
# All previous targets (test_html_parse, test_weather_parse, test_md_parse)
# retired with their parent apps in #276 (Reader, MacWeather, HelloMac in
# Phase 1A; PixelPad, MarkdownViewer in Phase 1B). The Makefile is kept
# as scaffolding for any future host-native parser test — drop a
# test_<name>.c here, add a target, point it at ../../src/app/<name>/<file>.c.
#
# stubs/ holds minimal stand-ins for the Mac headers (<Types.h>,
# <Quickdraw.h>, <Events.h>) that pure-logic files include for types
# and TickCount(). Put it first on the include path so it shadows any
# host header with the same name on a case-insensitive filesystem.

CC      ?= cc
CFLAGS  ?= -std=c99 -Wall -Wextra -O0 -g -DUNIT_TEST

TESTS = test_arkanoid_engine

ARKANOID = ../../src/app/wasm-arkanoid

.PHONY: all clean run

all: $(TESTS)

test_arkanoid_engine: test_arkanoid_engine.c $(ARKANOID)/engine.c $(ARKANOID)/engine.h
	$(CC) $(CFLAGS) -Istubs -I$(ARKANOID) -o $@ test_arkanoid_engine.c $(ARKANOID)/engine.c

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
