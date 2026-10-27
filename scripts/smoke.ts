// Behavior contract for the trail engine (src/trail-engine.ts), run headless.
//
// Staging semantics under test: a stroke holds at most one staged point
// between ticks (fast input collapses to the newest point), staged points
// commit one per tick, and input under 1px from the newest committed point is
// rejected. A finished session drains from its oldest points across the whole
// fade duration with an ease-in ramp.
import { TrailEngine } from '../src/trail-engine'

const visible: number[] = []
const engine = new TrailEngine(
	500,
	(strokes) => {
		visible.length = 0
		for (const s of strokes) visible.push(s.points.length)
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

// --- first stroke: one commit per tick ------------------------------------------

const sessionId = engine.startSession({ idleMs: 5_000, fadeMs: 500 })

const stroke = engine.addStroke(sessionId, {
	color: 'hsl(0, 100%, 50%)',
	opacity: 0.7,
	size: 4,
	taper: false,
})

engine.queuePoint(sessionId, stroke.id, 0, 0)
engine.advance(16)
check('first point committed', visible[0], visible[0] === 1, '1')

for (let i = 1; i <= 40; i++) {
	engine.queuePoint(sessionId, stroke.id, i * 4, Math.sin(i / 4) * 6)
	engine.advance(16)
}
check('one point commits per tick', visible[0], visible[0] === 41, '41')

// many queued points within one tick keep only the newest staged point (real
// input arrives at tick cadence, so this models fast movers faithfully)
const beforeBurst = visible[0]
for (let i = 0; i < 5; i++) engine.queuePoint(sessionId, stroke.id, (beforeBurst + i) * 5, 0)
engine.advance(16)
check('burst within one tick commits one point', visible[0], visible[0] === beforeBurst + 1, `${beforeBurst + 1}`)

// holding: strokes persist without shrinking while the session runs
engine.advance(120)
engine.advance(120)
check('trail holds while the session runs (no drain)', visible[0], visible[0] === 42, '42')

// --- stop -> grouped ease-in drain over the fade duration -----------------------

for (let i = 0; i < 100; i++) {
	engine.queuePoint(sessionId, stroke.id, i * 4 + 42 * 5, 0)
	engine.advance(16)
}
check('long trail accumulated', visible[0], visible[0] === 142, '142')

engine.stopSession(sessionId)
let ticks = 0
while (engine.count > 0 && ticks < 200) {
	engine.advance(16)
	ticks++
}
const drainedMs = ticks * 16
console.log(`drained after ${drainedMs}ms of drain time`)
check('session removed', engine.count, engine.count === 0, '0')
check(
	'drain matches fade duration (fade >=500ms zeroes leftovers)',
	drainedMs,
	drainedMs >= 500 && drainedMs <= 560,
	'500..560'
)
check('final snapshot was empty', visible.length, visible.length === 0, '0')
check('engine reports quiet after drain', engine.isQuiet(), engine.isQuiet(), 'true')

// --- dismiss: drops everything immediately --------------------------------------

const sid2 = engine.startSession({ idleMs: 5_000, fadeMs: 500 })
const sc2 = engine.addStroke(sid2, { color: 'red', size: 4, opacity: 0.7, taper: false })
engine.queuePoint(sid2, sc2.id, 1, 1)
engine.advance(16)
engine.queuePoint(sid2, sc2.id, 9, 9)
engine.advance(16)
check('second session built per tick', visible[0], visible[0] === 2, '2')
engine.dismissSession(sid2)
check('dismiss empties the snapshot', visible.length, visible.length === 0, '0')
check('dismissed session is not live', engine.isLive(sid2), !engine.isLive(sid2), 'false')

// --- sub-pixel duplicate suppression ---------------------------------------------

const sid3 = engine.startSession()
const sc3 = engine.addStroke(sid3, { color: 'red', size: 4, opacity: 0.7, taper: false })
engine.queuePoint(sid3, sc3.id, 5, 5)
engine.advance(16)
check('initial point committed', visible[0], visible[0] === 1, '1')
engine.queuePoint(sid3, sc3.id, 5, 5)
engine.queuePoint(sid3, sc3.id, 5, 5)
engine.advance(16)
check('duplicate point rejected (<1px)', visible[0], visible[0] === 1, '1')

process.exit(failed ? 1 : 0)
