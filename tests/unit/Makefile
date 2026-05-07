# Unit tests for host-compilable Mac app code.
#
# Convention: any function in src/app/ that does NOT call MacToolbox APIs
# (QuickDraw, WindowManager, Events, etc.) can be unit-tested here by
# compiling with the host gcc/clang. This bypasses Retro68 entirely so the
# test loop is sub-second.
#
# game_logic.c is the pure-C engine. minesweeper.c is the Toolbox shell
# and is NOT host-compilable.

CC      ?= cc
CFLAGS  ?= -std=c99 -Wall -Wextra -O0 -g -DUNIT_TEST
INCLUDES = -I. -I../../src/app

GAME_LOGIC = ../../src/app/game_logic.c

TESTS = test_minesweeper

.PHONY: all clean run

all: $(TESTS)

test_minesweeper: test_minesweeper.c $(GAME_LOGIC) ../../src/app/game_logic.h
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ test_minesweeper.c $(GAME_LOGIC)

run: all
	@set -e; \
	for t in $(TESTS); do \
		echo "==> ./$$t"; \
		./$$t; \
	done
	@echo "All unit tests passed."

clean:
	rm -f $(TESTS)
