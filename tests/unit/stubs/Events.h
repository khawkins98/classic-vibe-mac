/* Host stub for <Events.h>. Tests drive the clock explicitly via
 * EngineTick(g, now), so TickCount() only seeds next_move_tick. */
#include <Types.h>
static inline long TickCount(void) { return 0; }
