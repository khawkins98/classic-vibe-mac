# Unit tests for host-compilable Mac app code.
#
# Convention: any function in src/app/<app>/ that does NOT call MacToolbox
# APIs (QuickDraw, WindowManager, Events, etc.) can be unit-tested here by
# compiling with the host gcc/clang. This bypasses Retro68 entirely so the
# test loop is sub-second.
#
# Reader:     html_parse.c is the pure-C HTML tokenizer + layout.
# MacWeather: weather_parse.c is the pure-C JSON parser scoped to the
#             open-meteo response shape.
# Toolbox shells (reader.c, macweather.c) are NOT host-compilable.

CC      ?= cc
CFLAGS  ?= -std=c99 -Wall -Wextra -O0 -g -DUNIT_TEST

READER_SRC      = ../../src/app/reader
MACWEATHER_SRC  = ../../src/app/macweather

HTML_PARSE      = $(READER_SRC)/html_parse.c
WEATHER_PARSE   = $(MACWEATHER_SRC)/weather_parse.c

TESTS = test_html_parse test_weather_parse

.PHONY: all clean run

all: $(TESTS)

test_html_parse: test_html_parse.c $(HTML_PARSE) $(READER_SRC)/html_parse.h
	$(CC) $(CFLAGS) -I. -I$(READER_SRC) -o $@ test_html_parse.c $(HTML_PARSE)

test_weather_parse: test_weather_parse.c $(WEATHER_PARSE) $(MACWEATHER_SRC)/weather_parse.h
	$(CC) $(CFLAGS) -I. -I$(MACWEATHER_SRC) -o $@ test_weather_parse.c $(WEATHER_PARSE)

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
