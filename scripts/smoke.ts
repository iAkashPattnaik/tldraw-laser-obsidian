// Headless smoke test for the ScribbleManager port (laser engine).
//
// Flush semantics tested match upstream tldraw's ScribbleManager: a single
// `next` slot keeps the last accepted point between ticks, so at most one new
// point (gated at >=1px from the previous) enters the scribble per tick.
import { ScribbleManager } from '../src/scribble'

const visible: number[] = []
const manager = new ScribbleManager(
	500,
	(scribbles) => {
		visible.length = 0
		for (const s of scribbles) visible.push(s.points.length)
	},
	{
		schedule: (fn, ms) => setTimeout(fn, ms),
		cancel: (handle) => clearTimeout(handle),
	}
)

let failed = false
function check(label: string, actual: unknown, ok: boolean, expected: string) {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${actual} (expected ${expected})`)
	if (!ok) failed = true
}

// --- first stroke: flushing per tick -------------------------------------------

const sessionId = manager.startSession({
	selfConsume: false,
	idleTimeoutMs: 5_000,
	fadeMode: 'grouped',
	fadeEasing: 'ease-in',
})

const scribble = manager.addScribbleToSession(sessionId, {
	color: 'hsl(0, 100%, 50%)',
	opacity: 0.7,
	size: 4,
	taper: false,
})
const id = scribble.id

manager.addPointToSession(sessionId, id, 0, 0)
manager.tick(16)
check('first point flushed', visible[0], visible[0] === 1, '1')

for (let i = 1; i <= 40; i++) {
	manager.addPointToSession(sessionId, id, i * 4, Math.sin(i / 4) * 6)
	manager.tick(16)
}
check('one point flushes per tick', visible[0], visible[0] === 41, '41')

// many adds within one tick keep only the last accepted point (upstream's
// single `next` slot - real input arrives at tick cadence, so this is a
// faithful representation of fast movers too)
const beforeBurst = visible[0]
for (let i = 0; i < 5; i++) manager.addPointToSession(sessionId, id, (beforeBurst + i) * 5, 0)
manager.tick(16)
check('burst within one tick flushes one point', visible[0], visible[0] === beforeBurst + 1, `${beforeBurst + 1}`)

// idle-in-flight: persistent scribbles (laser) must not self-consume
manager.tick(120)
manager.tick(120)
check(`trail holds while active (no self-consume)`, visible[0], visible[0] === 42, '42')

// --- stop -> grouped ease-in fade drains over the fade duration -----------------

for (let i = 0; i < 100; i++) {
	manager.addPointToSession(sessionId, id, i * 4 + 42 * 5, 0)
	manager.tick(16)
}
check('long trail accumulated', visible[0], visible[0] === 142, '142')

manager.stopSession(sessionId)
let ticks = 0
while (manager.sessionCount() > 0 && ticks < 200) {
	manager.tick(16)
	ticks++
}
const drainedMs = ticks * 16
console.log(`drained after ${drainedMs}ms of fade time`)
check('session removed', manager.sessionCount(), manager.sessionCount() === 0, '0')
check(
	'drain matches fade duration (fade >=500ms zeroes leftovers)',
	drainedMs,
	drainedMs >= 500 && drainedMs <= 560,
	'500..560'
)
check('final emit was empty', visible.length, visible.length === 0, '0')
check('live sessions report empty', manager.hasLiveSessions(), !manager.hasLiveSessions(), 'false')

// --- cancel: clearSession dismisses immediately ----------------------------------

const sid2 = manager.startSession({ selfConsume: false, idleTimeoutMs: 5_000, fadeMode: 'grouped' })
const sc2 = manager.addScribbleToSession(sid2, { size: 4, taper: false })
manager.addPointToSession(sid2, sc2.id, 1, 1)
manager.tick(16)
manager.addPointToSession(sid2, sc2.id, 9, 9)
manager.tick(16)
check('second session built per tick', visible[0], visible[0] === 2, '2')
manager.clearSession(sid2)
check('clearSession empties canvas', visible.length, visible.length === 0, '0')
check('cleared session is not active', manager.isSessionActive(sid2), !manager.isSessionActive(sid2), 'false')

// --- non-repeating duplicate point suppression -----------------------------------

const sid3 = manager.startSession()
const sc3 = manager.addScribbleToSession(sid3, { size: 4, taper: false })
manager.addPointToSession(sid3, sc3.id, 5, 5)
manager.tick(16)
check('initial point flushed', visible[0], visible[0] === 1, '1')
manager.addPointToSession(sid3, sc3.id, 5, 5)
manager.addPointToSession(sid3, sc3.id, 5, 5)
manager.tick(16)
check('duplicate point suppressed (<1px)', visible[0], visible[0] === 1, '1')

process.exit(failed ? 1 : 0)
