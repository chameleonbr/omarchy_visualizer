// Checks for Visualizer.js: the cava config, the frames, the smoothing, the
// palettes, the shapes and the WLED bridge.
//
// Run with `node test_visualizer.js`. No audio, no cava, no network.
//
// `.pragma library` is a QML directive rather than JavaScript, so it is stripped
// before eval. It has to be in the file: without it each importing QML file
// gets its own copy of the module.

const assert = require("assert")
const fs = require("fs")

eval(fs.readFileSync(__dirname + "/Visualizer.js", "utf8").replace(/^\.pragma .*$/gm, ""))

let passed = 0
function check(name, run) {
  try {
    run()
    passed++
  } catch (error) {
    console.error("FAIL " + name + "\n  " + error.message)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------- cava config

check("the config asks for what the widget draws", () => {
  const text = cavaConfig({ barCount: 18, framerate: 45 })
  assert.ok(text.indexOf("bars = 18") > 0)
  assert.ok(text.indexOf("framerate = 45") > 0)
  assert.ok(text.indexOf("method = raw") > 0)
  assert.ok(text.indexOf("data_format = ascii") > 0, "ascii: no binary, no endianness")
  assert.ok(text.indexOf("autosens = 1") > 0, "cava does its own gain")
  assert.ok(text.indexOf("channels = mono") > 0)
})

check("settings outside their range are clamped, not obeyed", () => {
  const wild = cavaConfig({ barCount: 500, framerate: 500 })
  assert.ok(wild.indexOf("bars = 24") > 0)
  assert.ok(wild.indexOf("framerate = 60") > 0)

  const tiny = cavaConfig({ barCount: 0, framerate: 0 })
  assert.ok(tiny.indexOf("bars = 14") > 0, "zero means unset, not zero bars")
  assert.ok(tiny.indexOf("framerate = 30") > 0)
})

check("the config is written where it cannot clobber the user's", () => {
  // ~/.config/cava belongs to whoever runs cava in a terminal.
  const path = configPath("/run/user/1000", "/home/someone")
  assert.ok(path.indexOf("/run/user/1000") === 0)
  assert.ok(path.indexOf(".config/cava") < 0)
})

check("the config never lands in a directory other users can write", () => {
  // The bug: `/tmp/omarchy-visualizer/cava.conf` when XDG_RUNTIME_DIR was
  // unset. Predictable, shared, and created with `mkdir -p`, which is happy to
  // adopt a directory — or a symlink — someone else put there first. A shell
  // that lives for the whole session then writes through it.
  assert.strictEqual(configPath("", "/home/someone"),
    "/home/someone/.cache/omarchy-visualizer/cava.conf")
  assert.strictEqual(configPath("", ""), "",
    "with nowhere private, no path at all — never a shared one")

  for (const [runtime, home] of [["/run/user/1000", "/home/a"], ["", "/home/a"], ["", ""]]) {
    const path = configPath(runtime, home)
    assert.ok(path.indexOf("/tmp") !== 0, "still reaching for /tmp: " + path)
    assert.ok(path.indexOf("/var/tmp") !== 0, "still reaching for /var/tmp: " + path)
  }
})

check("the directory is made private and checked for being ours", () => {
  const script = configDirCommand("/run/user/1000/omarchy-visualizer").join(" ")
  assert.ok(script.indexOf("mkdir -m 700") > 0, "created private, not fixed up after")
  assert.ok(script.indexOf('[ ! -L "$d" ]') > 0, "a symlink in the way is refused")
  assert.ok(script.indexOf('[ -O "$d" ]') > 0, "a directory someone else made is refused")
  assert.ok(script.indexOf('[ ! -L "$f" ]') > 0, "the config itself is not written through a link")
  assert.ok(script.indexOf("sudo") < 0 && script.indexOf("pkexec") < 0)

  // The path is an argument, not spliced into the script: a directory name is
  // data, and $HOME is not always a name anyone vetted.
  const command = configDirCommand("/x/'; rm -rf ~; '")
  assert.strictEqual(command[command.length - 1], "/x/'; rm -rf ~; '")
  assert.strictEqual(command[2].indexOf("rm -rf ~"), -1)
})

check("no private directory means the plugin stays off", () => {
  const state = {
    installed: true, visible: true, playing: true,
    onBattery: false, pauseWhenSilent: true, pauseOnBattery: true
  }
  assert.strictEqual(shouldRun(Object.assign({}, state, { configReady: true })), true)
  assert.strictEqual(shouldRun(Object.assign({}, state, { configReady: false })), false)
  assert.strictEqual(idleReason(Object.assign({}, state, { configReady: false })), "noConfigDir")
  // Before the check has run there is nothing to report and nothing to start.
  assert.strictEqual(idleReason(Object.assign({}, state, { configReady: null })), "")
})

check("cava is run against that config, and never installed", () => {
  assert.deepStrictEqual(cavaCommand("/run/x/cava.conf"), ["cava", "-p", "/run/x/cava.conf"])

  const probe = cavaCheckCommand().join(" ")
  assert.ok(probe.indexOf("command -v cava") > 0)
  assert.ok(probe.indexOf("install") < 0 && probe.indexOf("pacman") < 0,
    "the plugin says what is missing; it does not go and get it")
})

// --------------------------------------------------------------- frames

check("a frame is N numbers and nothing else", () => {
  assert.deepStrictEqual(parseFrame("0;12;45;98;3", 5), [0, 12, 45, 98, 3])
  assert.deepStrictEqual(parseFrame("  0;12;45;98;3  ", 5), [0, 12, 45, 98, 3])
})

check("a short frame is padded and a long one is trimmed", () => {
  // cava is restarted when barCount changes; for the frame in between, a short
  // draw beats a stall.
  assert.deepStrictEqual(parseFrame("10;20", 5), [10, 20, 0, 0, 0])
  assert.deepStrictEqual(parseFrame("1;2;3;4;5;6;7", 3), [1, 2, 3])
})

check("a partial line is dropped, not read as silence", () => {
  // Returning zeros would draw a flat bar that looks like the music stopped.
  assert.strictEqual(parseFrame("10;abc", 5), null)
  assert.strictEqual(parseFrame("", 5), null)
  assert.strictEqual(parseFrame("   ", 5), null)
})

check("values are clamped to the range the config asked for", () => {
  assert.deepStrictEqual(parseFrame("-5;150", 2), [0, 100])
})

// ------------------------------------------------------------- smoothing

check("attack is immediate and release is eased", () => {
  // Matching the attack is what makes it look connected to the sound; easing
  // the release is what stops it looking like noise.
  assert.deepStrictEqual(smoothFrame([0, 0], [100, 100], 60), [100, 100])

  const falling = smoothFrame([100, 100], [0, 0], 60)
  assert.ok(falling[0] > 0 && falling[0] < 100)
  assert.strictEqual(falling[0], 60)
})

check("smoothing at either end behaves", () => {
  assert.deepStrictEqual(smoothFrame([100], [0], 0), [0], "0 means no easing at all")

  const slow = smoothFrame([100], [0], 95)
  assert.strictEqual(slow[0], 95)

  for (const value of [-10, 200, NaN]) {
    const out = smoothFrame([100], [0], value)
    assert.ok(isFinite(out[0]), "smoothing " + value)
  }
})

check("a change of bar count restarts cleanly", () => {
  // Different length means cava was restarted; the old frame is not comparable.
  assert.deepStrictEqual(smoothFrame([1, 2, 3], [9, 9], 60), [9, 9])
  assert.deepStrictEqual(smoothFrame(null, [9, 9], 60), [9, 9])
})

check("a floor lets the widget rest", () => {
  // Room noise keeps the bars trembling at one or two forever, and with the
  // bridge on it keeps a lamp flickering all night.
  assert.deepStrictEqual(applyFloor([0, 2, 3, 40], 3), [0, 0, 3, 40])
  assert.deepStrictEqual(applyFloor([1, 2], 0), [1, 2], "no floor, no change")
})

check("the first frames are dropped while autosens calibrates", () => {
  assert.strictEqual(isWarmup(0), true)
  assert.strictEqual(isWarmup(9), true)
  assert.strictEqual(isWarmup(10), false)
})

// --------------------------------------------------------- energy guards

check("the truth table of when it runs", () => {
  const base = {
    installed: true, visible: true, playing: true, onBattery: false,
    pauseWhenSilent: true, pauseOnBattery: true
  }
  const with_ = extra => Object.assign({}, base, extra)

  assert.strictEqual(shouldRun(base), true)
  assert.strictEqual(shouldRun(with_({ installed: false })), false)
  assert.strictEqual(shouldRun(with_({ visible: false })), false)
  assert.strictEqual(shouldRun(with_({ playing: false })), false)
  assert.strictEqual(shouldRun(with_({ onBattery: true })), false)

  // Both guards can be turned off, and then they do not apply.
  assert.strictEqual(shouldRun(with_({ playing: false, pauseWhenSilent: false })), true)
  assert.strictEqual(shouldRun(with_({ onBattery: true, pauseOnBattery: false })), true)
})

check("not running is explained, because nothing is not an error", () => {
  const base = {
    installed: true, visible: true, playing: true, onBattery: false,
    pauseWhenSilent: true, pauseOnBattery: true
  }
  assert.strictEqual(idleReason(base), "")
  assert.strictEqual(idleReason(Object.assign({}, base, { installed: false })), "missing")
  assert.strictEqual(idleReason(Object.assign({}, base, { playing: false })), "silent")
  assert.strictEqual(idleReason(Object.assign({}, base, { onBattery: true })), "battery")
})

check("a missing cava outranks every other reason", () => {
  // Telling someone the music is stopped when the program is not installed
  // sends them looking in the wrong place.
  assert.strictEqual(idleReason({
    installed: false, visible: false, playing: false, onBattery: true,
    pauseWhenSilent: true, pauseOnBattery: true
  }), "missing")
})

// --------------------------------------------------------------- shapes

check("every shape in the settings is a shape the renderer knows", () => {
  assert.deepStrictEqual(SHAPES, ["bars", "mirror", "blocks", "dots", "wave"])
  for (const shape of SHAPES) assert.ok(isShape(shape), shape)
  assert.strictEqual(isShape("spiral"), false)
})

check("blocks light both ends exactly", () => {
  assert.strictEqual(litSegments(0, 8), 0, "silence lights none")
  assert.strictEqual(litSegments(100, 8), 8, "full lights all")
  assert.strictEqual(litSegments(50, 8), 4)
  assert.strictEqual(litSegments(100, 1), 1)
})

check("the wave spans the width and inverts for the screen", () => {
  const points = wavePoints([0, 50, 100])
  assert.strictEqual(points[0].x, 0)
  assert.strictEqual(points[2].x, 1)
  assert.strictEqual(points[0].y, 1, "silence sits on the floor")
  assert.strictEqual(points[2].y, 0, "full reaches the top")
  assert.strictEqual(points[1].y, 0.5)

  assert.strictEqual(wavePoints([42])[0].x, 0.5, "a single point is centred, not at zero")
})

// -------------------------------------------------------------- palettes

// Colours are compared with a tolerance: mixing at either extreme lands on
// 0.19999999999999996 rather than on 0.2, and a test that cares about that is
// testing IEEE 754 rather than the palette.
function sameColor(a, b, message) {
  for (const channel of ["r", "g", "b"]) {
    assert.ok(Math.abs(a[channel] - b[channel]) < 1e-9,
      (message || "") + " " + channel + ": " + a[channel] + " vs " + b[channel])
  }
}

const CTX = {
  foreground: { r: 0.8, g: 0.8, b: 0.8 },
  accent: { r: 0.2, g: 0.6, b: 0.9 },
  urgent: { r: 0.9, g: 0.2, b: 0.2 },
  peakThreshold: 85
}

check("every palette returns a colour for silence, middle and full", () => {
  for (const palette of PALETTES) {
    for (const value of [0, 50, 100]) {
      const color = paletteColor(palette, 1, 8, value, CTX)
      for (const channel of ["r", "g", "b"]) {
        assert.ok(isFinite(color[channel]) && color[channel] >= 0 && color[channel] <= 1,
          palette + " at " + value + " channel " + channel)
      }
    }
  }
})

check("intensity moves with the sound, between the two theme colours", () => {
  const quiet = paletteColor("intensity", 0, 8, 0, CTX)
  const loud = paletteColor("intensity", 0, 8, 100, CTX)

  sameColor(quiet, CTX.foreground, "silence is the foreground")
  sameColor(loud, CTX.accent, "full is the accent")
})

check("urgent crosses at the threshold and comes back", () => {
  sameColor(paletteColor("urgent", 0, 8, 84, CTX), CTX.accent, "below")
  sameColor(paletteColor("urgent", 0, 8, 85, CTX), CTX.urgent, "at")
  sameColor(paletteColor("urgent", 0, 8, 60, CTX), CTX.accent, "back below")
})

check("spectrum sweeps by position and does not repeat the ends", () => {
  const first = paletteColor("spectrum", 0, 8, 50, CTX)
  const last = paletteColor("spectrum", 7, 8, 50, CTX)
  const distance = Math.abs(first.r - last.r) + Math.abs(first.g - last.g) + Math.abs(first.b - last.b)

  assert.ok(distance > 0.1, "the two ends are different colours")
})

check("spectrum keeps the theme's saturation", () => {
  // Otherwise a muted theme gets a rainbow that belongs to some other desktop.
  const muted = Object.assign({}, CTX, { accent: { r: 0.5, g: 0.5, b: 0.5 } })
  const color = paletteColor("spectrum", 3, 8, 50, muted)

  const max = Math.max(color.r, color.g, color.b)
  const min = Math.min(color.r, color.g, color.b)
  assert.ok(max - min < 0.05, "a grey accent stays grey")
})

check("gradient runs between the two given colours", () => {
  const ctx = Object.assign({}, CTX, {
    gradientFrom: { r: 1, g: 0, b: 0 },
    gradientTo: { r: 0, g: 0, b: 1 }
  })

  sameColor(paletteColor("gradient", 0, 3, 50, ctx), { r: 1, g: 0, b: 0 }, "from")
  sameColor(paletteColor("gradient", 2, 3, 50, ctx), { r: 0, g: 0, b: 1 }, "to")
})

check("a bad hex falls back to the theme rather than to nothing", () => {
  const broken = Object.assign({}, CTX, { gradientFrom: null, gradientTo: null })
  sameColor(paletteColor("gradient", 0, 3, 50, broken), CTX.accent, "fallback")

  assert.strictEqual(parseHex("nonsense"), null)
  assert.strictEqual(parseHex(""), null)
  assert.strictEqual(parseHex("#12345"), null)
})

check("hex parses in both lengths", () => {
  assert.deepStrictEqual(parseHex("#ffffff"), { r: 1, g: 1, b: 1 })
  assert.deepStrictEqual(parseHex("000000"), { r: 0, g: 0, b: 0 })
  assert.deepStrictEqual(parseHex("#fff"), { r: 1, g: 1, b: 1 })
})

check("an unknown palette is the accent, not a crash", () => {
  sameColor(paletteColor("nonsense", 0, 8, 50, CTX), CTX.accent, "unknown")
})

// ------------------------------------------------------------ WLED bridge

check("brightness follows the mean, not the peak", () => {
  // Tracking the peak makes the lamp follow the kick drum alone, which reads as
  // strobing rather than as the music.
  assert.strictEqual(frameEnergy([0, 0, 0, 100]), 0.25)
  assert.strictEqual(frameEnergy([100, 100]), 1)
  assert.strictEqual(frameEnergy([]), 0)
  assert.strictEqual(frameEnergy(null), 0)
})

check("brightness is monotonic and stays in range", () => {
  let previous = -1
  for (let energy = 0; energy <= 1.0001; energy += 0.1) {
    const bri = wledBrightness(energy, 0, 255)
    assert.ok(bri >= 0 && bri <= 255)
    assert.ok(bri >= previous, "never goes down as the music gets louder")
    previous = bri
  }
  assert.strictEqual(wledBrightness(0, 0, 255), 0)
  assert.strictEqual(wledBrightness(1, 0, 255), 255)
})

check("frames above the rate are dropped, never queued", () => {
  // WLED over HTTP cannot take 30 requests a second: the lamp stops answering
  // and looks like a hardware fault. A queue would move that to the end of the
  // song rather than avoid it.
  assert.strictEqual(shouldSendToWled(0, 100, 10), true, "100ms at 10Hz")
  assert.strictEqual(shouldSendToWled(0, 99, 10), false)
  assert.strictEqual(shouldSendToWled(0, 50, 20), true)
  assert.strictEqual(shouldSendToWled(0, 1000, 1), true)
})

check("the rate is clamped where the hardware can follow", () => {
  // Asking for 1000Hz gets 20Hz, which is one frame every 50ms.
  assert.strictEqual(shouldSendToWled(0, 49, 1000), false, "49ms is too soon even at the cap")
  assert.strictEqual(shouldSendToWled(0, 50, 1000), true)
  assert.strictEqual(shouldSendToWled(0, 999, 0), true, "zero means the default")
})

check("the lamp shows the colour the bar is showing", () => {
  const loud = wledColor("intensity", 1, CTX)
  const quiet = wledColor("intensity", 0, CTX)

  sameColor(loud, CTX.accent, "loud")
  sameColor(quiet, CTX.foreground, "quiet")
})

check("the payload is the WLED state API and nothing exotic", () => {
  const payload = JSON.parse(wledPayload(128, { r: 1, g: 0, b: 0.5 }))

  assert.strictEqual(payload.on, true)
  assert.strictEqual(payload.bri, 128)
  assert.deepStrictEqual(payload.seg[0].col[0], [255, 0, 128])
})

check("the plugin's own loopbacks are not somebody playing music", () => {
  // `input: both` loads a null sink and two loopbacks, and a loopback is a
  // stream on the sink side -- which is what `playing` looks for. The plugin
  // created the evidence that convinced it something was playing, so
  // pauseWhenSilent could never fire once the mix was up.
  const mix = { isStream: true, isSink: true, name: "output.loopback-1700-13",
    properties: { "target.object": "omarchy_visualizer_mix" } }
  const sink = { isStream: false, isSink: true, name: "omarchy_visualizer_mix", properties: {} }
  const chrome = { isStream: true, isSink: true, name: "Google Chrome", properties: {} }
  const mic = { isStream: true, isSink: false, name: "cava", properties: {} }

  assert.strictEqual(isPlaying([mix, mix, sink, mic]), false,
    "our own graph, and a capture, and nothing else")
  assert.strictEqual(isPlaying([mix, chrome]), true, "somebody else's stream counts")
  assert.strictEqual(isPlaying([]), false)
  assert.strictEqual(isPlaying(null), false)
  assert.strictEqual(isPlaying([null, undefined]), false)

  assert.strictEqual(isOwnMixNode({ "target.object": "omarchy_visualizer_mix" }, "x"), true)
  assert.strictEqual(isOwnMixNode({}, "omarchy_visualizer_mix"), true, "the sink itself")
  assert.strictEqual(isOwnMixNode({ "target.object": "alsa_output.pci" }, "Firefox"), false)
  assert.strictEqual(isOwnMixNode(null, null), false)
})

check("silence over silence is not a frame to draw", () => {
  // Assigning a frame of zeroes over a frame of zeroes still changes the
  // property, re-evaluates every binding under it and repaints every bar on
  // every monitor to draw the same nothing.
  assert.strictEqual(isSilentFrame([0, 0, 0]), true)
  assert.strictEqual(isSilentFrame([]), true)
  assert.strictEqual(isSilentFrame(null), true)
  assert.strictEqual(isSilentFrame([0, 0, 1]), false, "one band above the floor is sound")

  // The floor is what decides quiet; this only decides that quiet twice
  // running is not news. A frame under the floor arrives here already zeroed.
  assert.deepStrictEqual(applyFloor([1, 2, 9], 3), [0, 0, 9])
  assert.strictEqual(isSilentFrame(applyFloor([1, 2], 3)), true)
  assert.strictEqual(isSilentFrame(applyFloor([1, 2], 0)), false,
    "and with no floor set, room noise is still something")
})

check("what the light was doing is recorded before anything overwrites it", () => {
  // The bug this exists for: `solid` sends fx 0 and pal 0 -- it has to, or the
  // effect keeps running and the colour is decoration -- and the restore only
  // sent `on: false`. So a song ended with every light left on Solid, its
  // effect and palette gone for good. Borrowing the strip is the deal; keeping
  // it is not.
  const before = wledBaseline({
    on: true, bri: 124,
    seg: [{ id: 0, fx: 188, pal: 63, sx: 110, ix: 128, c1: 110, c2: 50, c3: 31,
            o1: true, frz: true, col: [[181, 138, 255]] }]
  })
  assert.strictEqual(before.bri, 124)
  assert.strictEqual(before.seg.fx, 188)
  assert.strictEqual(before.seg.pal, 63)
  assert.deepStrictEqual(before.seg.col, [[181, 138, 255]])
  assert.strictEqual(before.seg.frz, false,
    "a strip found frozen is not handed back frozen: that is the state to escape")
  assert.strictEqual(wledBaseline({ on: true, seg: [] }), null)
  assert.strictEqual(wledBaseline(null), null)
})

check("the restore puts the lamp back, and says so plainly when it cannot", () => {
  // Leaving a lamp frozen on a colour after the music stops is the worst thing
  // this bridge can do.
  const restored = JSON.parse(wledRestorePayload(
    wledBaseline({ on: true, bri: 200, seg: [{ fx: 87, pal: 3, col: [[1, 2, 3]] }] })))
  assert.strictEqual(restored.bri, 200)
  assert.strictEqual(restored.seg[0].fx, 87, "the effect, not just the colour")
  assert.strictEqual(restored.seg[0].pal, 3)
  assert.strictEqual(restored.seg[0].frz, false)
  assert.deepStrictEqual(restored.seg[0].col[0], [1, 2, 3])

  const unknown = JSON.parse(wledRestorePayload(null))
  assert.strictEqual(unknown.on, false, "nothing remembered: turn it off rather than guess")
  assert.strictEqual(unknown.seg[0].frz, false, "and the freeze is lifted either way")
})


// ------------------------------------------------------------ pixel grid

check("bars are one width and one pitch, on the device grid", () => {
  // The trap the docker mosaic fell into: a pitch of width/count is fractional,
  // and identical bars then rasterise at different widths.
  for (const dpr of [1, 0.85, 1.25, 1.5, 2]) {
    const layout = barLayout(90, 14, 3, 2, dpr)
    const whole = value => Math.abs(value * dpr - Math.round(value * dpr)) < 1e-6

    assert.ok(whole(layout.pitch), "dpr " + dpr + " pitch")
    assert.ok(whole(layout.width), "dpr " + dpr + " width")
    assert.ok(whole(layout.offset), "dpr " + dpr + " offset")
    assert.ok(layout.width <= layout.pitch, "a bar never overruns its pitch")
  }
})

check("the leftover becomes padding, not a wider bar", () => {
  // Smearing the remainder across the bars is how they end up different.
  const layout = barLayout(100, 7, 20, 2, 1)
  assert.ok(layout.pitch * 7 + layout.offset * 2 <= 100 + 1e-6)
  assert.ok(layout.offset >= 0)
})

check("a bar never disappears, however tight the space", () => {
  for (const width of [10, 20, 40]) {
    const layout = barLayout(width, 24, 3, 2, 0.85)
    assert.ok(layout.width >= 1 / 0.85 - 1e-9, "width " + width)
  }
})

// ------------------------------------------------------------- style axes

check("the axes are what the settings offer", () => {
  assert.deepStrictEqual(BASES, ["bottom", "top", "mirror", "radial"])
  assert.deepStrictEqual(CAPS, ["flat", "round", "segments"])
  for (const base of BASES) assert.ok(isBase(base))
  for (const cap of CAPS) assert.ok(isCap(cap))
  assert.strictEqual(isBase("sideways"), false)
})

check("the base edge never moves, whatever the value", () => {
  // Rounding y and height independently made the floor of every bar wander by
  // a pixel as the value changed, and the bars looked like they were standing
  // on something loose. The LENGTH is rounded once and the position derived.
  for (const dpr of [1, 0.85, 1.25, 1.5]) {
    for (let value = 0; value <= 100; value += 3) {
      const bottom = barGeometry("bottom", value, 40, 2, dpr)
      assert.ok(Math.abs(bottom.y + bottom.height - 40) < 1e-9,
        "bottom at dpr " + dpr + " value " + value + " -> " + (bottom.y + bottom.height))

      const top = barGeometry("top", value, 40, 2, dpr)
      assert.strictEqual(top.y, 0, "top at dpr " + dpr + " value " + value)
    }
  }
})

check("a mirrored bar grows around a fixed centre", () => {
  for (const dpr of [1, 0.85, 1.5]) {
    const centres = []
    for (let value = 0; value <= 100; value += 7) {
      const g = barGeometry("mirror", value, 40, 2, dpr)
      centres.push(g.y + g.height / 2)
    }
    for (const centre of centres) {
      assert.ok(Math.abs(centre - centres[0]) < 1e-9,
        "dpr " + dpr + " centre moved: " + centre + " vs " + centres[0])
    }
  }
})

check("every bar edge lands on a device pixel", () => {
  for (const dpr of [0.85, 1.25]) {
    for (const value of [7, 23, 61, 94]) {
      const g = barGeometry("bottom", value, 40, 2, dpr)
      const whole = v => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6
      assert.ok(whole(g.height), "height at " + value)
    }
  }
})

check("a bar grows from the edge its base names", () => {
  const bottom = barGeometry("bottom", 50, 100, 1)
  const top = barGeometry("top", 50, 100, 1)
  const mirror = barGeometry("mirror", 50, 100, 1)

  assert.strictEqual(bottom.y + bottom.height, 100, "bottom ends at the floor")
  assert.strictEqual(top.y, 0, "top starts at the ceiling")
  assert.strictEqual(mirror.y + mirror.height / 2, 50, "mirror is centred")
})

check("silence still draws something on every base", () => {
  // A bar that vanishes at zero makes the widget look broken rather than quiet.
  for (const base of ["bottom", "top", "mirror"]) {
    const geometry = barGeometry(base, 0, 100, 2)
    assert.ok(geometry.height >= 1, base)
    assert.ok(geometry.y >= 0 && geometry.y + geometry.height <= 100 + 1e-9, base)
  }
})

check("a full bar fills the height on every base", () => {
  for (const base of ["bottom", "top", "mirror"]) {
    assert.strictEqual(barGeometry(base, 100, 100, 1).height, 100, base)
  }
})

// ---------------------------------------------------------------- radial

check("a closed ring does not stack the last bar on the first", () => {
  const angles = [0, 1, 2, 3].map(i => radialBar(i, 4, 100, {}).angle)
  assert.deepStrictEqual(angles, [0, 0.25, 0.5, 0.75])
  assert.ok(angles[3] < 1, "the fourth bar is not back at the start")
})

check("an open fan reaches its far edge", () => {
  const angles = [0, 1, 2, 3].map(i => radialBar(i, 4, 100, { spread: 0.5 }).angle)
  assert.strictEqual(angles[0], 0)
  assert.ok(Math.abs(angles[3] - 0.5) < 1e-9, "the last bar lands on the edge")
})

check("radial length runs between the two radii", () => {
  const quiet = radialBar(0, 8, 0, { innerRadius: 0.3, outerRadius: 1 })
  const loud = radialBar(0, 8, 100, { innerRadius: 0.3, outerRadius: 1 })

  assert.strictEqual(quiet.outer, 0.3, "silence is the inner circle")
  assert.strictEqual(loud.outer, 1, "full reaches the rim")
  assert.ok(loud.outer > quiet.outer)
})

check("radial survives one bar and a missing spread", () => {
  assert.ok(isFinite(radialBar(0, 1, 50, {}).angle))
  assert.ok(isFinite(radialBar(0, 1, 50, { spread: 0 }).angle))
})

// ------------------------------------------------------------- peak hold

check("a peak is taken at once and sinks slowly", () => {
  // The bars say what is happening now; the markers say what just happened.
  assert.deepStrictEqual(updatePeaks([0, 0], [80, 40], 5), [80, 40], "a new high is immediate")
  assert.deepStrictEqual(updatePeaks([80, 40], [10, 10], 5), [75, 35], "and then it decays")
})

check("a marker never sinks below the bar it marks", () => {
  assert.deepStrictEqual(updatePeaks([50], [90], 100), [90])
  assert.deepStrictEqual(updatePeaks([50], [30], 100), [30], "decay stops at the bar")
})

check("a changed bar count restarts the markers", () => {
  assert.deepStrictEqual(updatePeaks([1, 2, 3], [9, 9], 5), [9, 9])
  assert.deepStrictEqual(updatePeaks(null, [9], 5), [9])
})

// ------------------------------------------------------- the new palettes

check("rainbow is loud and spectrum is polite", () => {
  // One borrows the theme's restraint, the other ignores it; having both is
  // the point of having two.
  const muted = Object.assign({}, CTX, { accent: { r: 0.5, g: 0.5, b: 0.5 } })

  const spectrum = paletteColor("spectrum", 3, 8, 50, muted)
  const rainbow = paletteColor("rainbow", 3, 8, 50, muted)

  const spread = c => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
  assert.ok(spread(spectrum) < 0.05, "a grey accent keeps spectrum grey")
  assert.ok(spread(rainbow) > 0.4, "rainbow is saturated regardless")
})

check("heat runs cold at rest and hot at the peak", () => {
  const cold = paletteColor("heat", 0, 8, 0, CTX)
  const hot = paletteColor("heat", 0, 8, 100, CTX)

  assert.ok(cold.b > cold.r, "quiet leans blue")
  assert.ok(hot.r > hot.b, "loud leans red")
})

check("solid uses the colour given, or the accent when there is none", () => {
  const picked = Object.assign({}, CTX, { solidColor: { r: 1, g: 0, b: 0 } })
  sameColor(paletteColor("solid", 3, 8, 70, picked), { r: 1, g: 0, b: 0 }, "picked")
  sameColor(paletteColor("solid", 3, 8, 70, CTX), CTX.accent, "fallback")
})

check("a bar gradient runs from its resting colour to its current one", () => {
  const pair = barGradientPair("intensity", 0, 8, 100, CTX)
  sameColor(pair.base, CTX.foreground, "base")
  sameColor(pair.tip, CTX.accent, "tip")
})

// ------------------------------------------------------------ audio input

check("the three inputs map to three sources", () => {
  assert.deepStrictEqual(INPUTS, ["system", "mic", "both"])
  assert.strictEqual(inputSource("system"), "auto", "cava's own default sink monitor")
  assert.strictEqual(inputSource("mic", "alsa_input.usb"), "alsa_input.usb")
  assert.ok(inputSource("both").indexOf(".monitor") > 0, "both reads the mix it builds")
})

check("the config carries the chosen input", () => {
  const text = cavaConfig({ barCount: 14, framerate: 30, input: "mic", micSource: "mymic" })
  assert.ok(text.indexOf("[input]") > 0)
  assert.ok(text.indexOf("source = mymic") > 0)
  assert.ok(text.indexOf("method = pulse") > 0)
})

check("hearing both builds a device and takes it away again", () => {
  // Leaving a stray sink in someone's audio graph is a mess that outlives the
  // widget.
  const setup = mixSetupCommands("sink.monitor", "mic")
  assert.strictEqual(setup.length, 3, "a null sink and two loopbacks")
  assert.ok(setup[0].join(" ").indexOf("module-null-sink") > 0)
  assert.ok(setup[1].join(" ").indexOf("source=sink.monitor") > 0)
  assert.ok(setup[2].join(" ").indexOf("source=mic") > 0)

  const teardown = mixTeardownCommand().join(" ")
  assert.ok(teardown.indexOf("unload-module") > 0)
  // The module types narrow what is looked at; the sink name decides which
  // ones actually go. See the teardown check further down for that half.
  assert.ok(teardown.indexOf("null-sink") > 0 && teardown.indexOf("loopback") > 0)
  assert.ok(teardown.indexOf("true") > 0, "safe to run when nothing is loaded")
})

check("nothing in the audio path needs root", () => {
  const all = mixSetupCommands("a", "b").concat([mixTeardownCommand(),
    defaultSinkCommand(), defaultSourceCommand()])
  for (const command of all) {
    const text = command.join(" ")
    assert.ok(text.indexOf("sudo") < 0 && text.indexOf("pkexec") < 0, text)
  }
})

// -------------------------------------------------------------------- i18n

eval(fs.readFileSync(__dirname + "/I18n.js", "utf8").replace(/^\.pragma .*$/gm, ""))

check("English is the default and every table is complete against it", () => {
  assert.strictEqual(language(), "en")
  const english = Object.keys(STRINGS.en)
  for (const name of Object.keys(STRINGS)) {
    const missing = english.filter((key) => STRINGS[name][key] === undefined)
    assert.deepStrictEqual(missing, [], name + " is missing: " + missing.join(", "))
    const extra = Object.keys(STRINGS[name]).filter((key) => STRINGS.en[key] === undefined)
    assert.deepStrictEqual(extra, [], name + " has keys English does not: " + extra.join(", "))
  }
})

check("every setting the pane shows has a label and a word per value", () => {
  const axes = {
    base: BASES, cap: CAPS, fill: FILLS, palette: PALETTES,
    input: INPUTS, language: LANGUAGES
  }
  for (const name of Object.keys(STRINGS)) {
    setLanguage(name)
    for (const key of Object.keys(axes)) {
      assert.notStrictEqual(t("row." + key), "row." + key, name + " has no label for " + key)
      for (const option of axes[key]) {
        const full = key + "." + option
        assert.notStrictEqual(t(full), full, name + " has no word for " + full)
      }
    }
  }
  setLanguage("en")
})

check("a value is a word, a number is itself", () => {
  assert.strictEqual(value("base", "mirror"), "mirror")
  assert.strictEqual(value("barCount", 24), "24")
  assert.strictEqual(value("showWave", true), "on")
  assert.strictEqual(value("showWave", false), "off")
  setLanguage("pt")
  assert.strictEqual(value("base", "mirror"), "espelho")
  assert.strictEqual(value("barCount", 24), "24", "numbers are not translated")
  setLanguage("en")
})

check("an untranslated key falls back to English, never to the key", () => {
  setLanguage("pt")
  STRINGS.pt["row.base"] = undefined
  delete STRINGS.pt["row.base"]
  assert.strictEqual(t("row.base"), "base", "English, not the key")
  STRINGS.pt["row.base"] = "base"
  setLanguage("en")
})

check("an unknown language is English rather than an empty pane", () => {
  assert.strictEqual(setLanguage("klingon"), "en")
  assert.strictEqual(detectLanguage("pt_BR.UTF-8"), "pt")
  assert.strictEqual(detectLanguage("de_DE.UTF-8"), "en")
  assert.strictEqual(detectLanguage(""), "en")
})

check("the idle message keeps its fix line attached to its reason", () => {
  assert.ok(idleText("missing").indexOf("omarchy pkg add cava") > 0)
  assert.strictEqual(idleText("nonsense"), "", "an unknown reason says nothing")
})

check("the hint says what the letters on screen cannot", () => {
  assert.ok(hintText(false).indexOf("settings") >= 0)
  assert.strictEqual(hintText(false).indexOf("shift"), -1,
    "nothing to reverse with the pane shut")
  assert.ok(hintText(true).indexOf("shift") >= 0)
})

// ---------------------------------------------------------------- manifest

check("the manifest advertises exactly the settings that exist", () => {
  const manifest = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"))
  const widget = manifest.barWidget
  const advertised = widget.schema.map((entry) => entry.key)

  // The manifest is what a reviewer and the shell's settings UI read. It went
  // stale once, still offering a `shape` axis that had been replaced by three.
  assert.deepStrictEqual(advertised.filter((key) => DEFAULTS[key] === undefined), [],
    "the manifest offers settings the plugin does not have")
  assert.deepStrictEqual(Object.keys(DEFAULTS).filter((key) => advertised.indexOf(key) < 0), [],
    "the plugin has settings the manifest does not offer")

  for (const entry of widget.schema) {
    assert.strictEqual(entry.defaultValue, DEFAULTS[entry.key],
      entry.key + " is advertised with the wrong default")
    assert.strictEqual(widget.defaults[entry.key], DEFAULTS[entry.key],
      entry.key + " has a stale default")
    if (entry.options) {
      assert.ok(entry.options.indexOf(DEFAULTS[entry.key]) >= 0,
        entry.key + " cannot be set to its own default")
    }
  }
})

// ------------------------------------------------------------------- fills

const FILL_CTX = {
  foreground: { r: 1, g: 1, b: 1 },
  accent: { r: 0, g: 0.4, b: 1 },
  urgent: { r: 1, g: 0, b: 0 },
  gradientFrom: null, gradientTo: null, solidColor: null,
  peakThreshold: 85
}

check("no palette draws a gradient between a colour and itself", () => {
  for (const palette of PALETTES) {
    for (const fill of ["barGradient", "screenGradient"]) {
      for (const value of [10, 50, 95]) {
        const pair = barGradientPair(palette, 3, 14, value, FILL_CTX, fill)
        assert.ok(!sameColor(pair.base, pair.tip),
          palette + "/" + fill + " at " + value + " is a flat bar")
      }
    }
  }
})

check("barGradient normalises to the bar, screenGradient to the drawing area", () => {
  for (const palette of PALETTES) {
    const quiet = barGradientPair(palette, 3, 14, 10, FILL_CTX, "barGradient")
    const loud = barGradientPair(palette, 3, 14, 95, FILL_CTX, "barGradient")
    assert.ok(sameColor(quiet.tip, loud.tip),
      palette + ": a barGradient tip must not depend on the value")

    const low = barGradientPair(palette, 3, 14, 10, FILL_CTX, "screenGradient")
    const high = barGradientPair(palette, 3, 14, 95, FILL_CTX, "screenGradient")
    assert.ok(!sameColor(low.tip, high.tip),
      palette + ": a screenGradient tip must follow the value")
  }
})

check("the fill is read, so all three do something different", () => {
  // The bug this replaced: `fill` had three values and two behaviours, because
  // the pair was built without ever being told which fill asked for it.
  for (const palette of PALETTES) {
    const bar = barGradientPair(palette, 3, 14, 40, FILL_CTX, "barGradient")
    const screen = barGradientPair(palette, 3, 14, 40, FILL_CTX, "screenGradient")
    assert.ok(!sameColor(bar.tip, screen.tip),
      palette + ": barGradient and screenGradient are the same picture")
  }
})

check("a dimmed foot is darker than the tip, never brighter", () => {
  const pair = barGradientPair("rainbow", 3, 14, 90, FILL_CTX, "barGradient")
  const sum = (c) => c.r + c.g + c.b
  assert.ok(sum(pair.base) < sum(pair.tip))
  assert.deepStrictEqual(dim({ r: 1, g: 1, b: 1 }, 0), { r: 0, g: 0, b: 0 })
  assert.deepStrictEqual(dim({ r: 1, g: 0.5, b: 0 }, 1), { r: 1, g: 0.5, b: 0 })
})

// ------------------------------------------------------------ accelerators

const ALL_ROWS = SETTING_ROWS.concat(WLED_ROWS)

check("every row has its own letter and nothing else claims it", () => {
  const taken = new Set(["s"])   // s opens and closes the pane
  for (const row of ALL_ROWS) {
    assert.ok(row.accel, row.key + " has no accelerator")
    assert.strictEqual(row.accel, row.accel.toLowerCase(), "accelerators are lower case")
    assert.ok(!taken.has(row.accel), row.accel + " is claimed twice (" + row.key + ")")
    taken.add(row.accel)
  }
  for (const digit of COLOR_ACCELS) {
    assert.ok(!taken.has(digit), digit + " is claimed twice")
    taken.add(digit)
  }
})

check("every row is a real setting with real values", () => {
  for (const row of ALL_ROWS) {
    if (row.key === "wledDevices") continue   // its values come from the config
    assert.notStrictEqual(DEFAULTS[row.key], undefined, row.key + " is not a setting")
    assert.ok(row.values.length >= 2, row.key + " has nothing to cycle through")
    assert.ok(row.values.indexOf(DEFAULTS[row.key]) >= 0,
      row.key + " cannot cycle back to its own default")
  }
})

check("the accelerator is a letter of the label where there is one", () => {
  const split = splitAccel("palette", "p")
  assert.deepStrictEqual(split, { before: "", letter: "p", after: "alette" })
  assert.deepStrictEqual(splitAccel("language", "g"),
    { before: "lan", letter: "g", after: "uage" })
})

check("a label without its letter shows it rather than losing it", () => {
  const split = splitAccel("fps", "r")
  assert.strictEqual(split.before + split.letter + split.after, "fps (r)")
  assert.strictEqual(split.letter, "r", "still one letter to paint")
})

check("every label in every language still shows its letter", () => {
  for (const name of Object.keys(STRINGS)) {
    setLanguage(name)
    for (const row of ALL_ROWS) {
      const split = splitAccel(t("row." + row.key), row.accel)
      assert.strictEqual(split.letter.toLowerCase(), row.accel,
        name + "/" + row.key + " lost its accelerator")
    }
  }
  setLanguage("en")
})

check("the wled rows are offered only when there is a light to point at", () => {
  const names = wledDeviceNames({ devices: [
    { name: "desk", host: "wled-desk" },
    { host: "wled-shelf" },
    { name: "desk" },
    {}
  ] })
  assert.deepStrictEqual(names, ["desk", "wled-shelf"], "named once, and only if named")
  assert.deepStrictEqual(wledDeviceNames(null), [], "no config, no rows")

  const rows = wledRows(names)
  assert.strictEqual(rows.length, WLED_ROWS.length)
  const devices = rows.filter((row) => row.key === "wledDevices")[0]
  assert.deepStrictEqual(devices.values, ["", "desk", "wled-shelf"],
    "empty is every light the config lists")
  const empty = wledRows([]).filter((row) => row.key === "wledDevices")[0]
  assert.deepStrictEqual(empty.values, [""], "nothing to narrow to")
})

check("a device list longer than the ceiling offers no more than the ceiling", () => {
  const devices = []
  for (let i = 0; i < 5000; i++) devices.push({ name: "lamp-" + i })
  assert.strictEqual(wledDeviceNames({ devices: devices }).length, MAX_WLED_DEVICES)
})

check("a letter for a row that is not on screen does nothing", () => {
  assert.strictEqual(rowForAccel("d"), null, "no wled rows in the default list")
  assert.strictEqual(rowForAccel("d", SETTING_ROWS.concat(wledRows([]))).key, "wledEnabled")
  assert.strictEqual(rowForAccel("p", SETTING_ROWS.concat(wledRows([]))).key, "palette",
    "the axes are still there")
})

const STRIP_CTX = { accent: { r: 0, g: 1, b: 0.5 }, foreground: { r: 1, g: 1, b: 1 },
  urgent: { r: 1, g: 0, b: 0 }, peakThreshold: 85 }
const stripPixel = (hex, i) => hex.slice(i * 6, i * 6 + 6)

check("a strip is a panel one row tall, and is painted the same way", () => {
  // It used to be painted here with run-length `seg.i` indices under a frozen
  // segment, on the JSON path, capped at wledRateHz. One paint path now, and
  // no freeze to lift afterwards -- a frozen segment nobody unfreezes keeps
  // the last frame of the music for as long as the light stays on, which is
  // what a session that died without its teardown left behind more than once.
  const hex = wledPanelFrame([10, 50, 90, 20], "rainbow", STRIP_CTX, 12, 1,
    "solid", "spectrum")
  assert.strictEqual(hex.length, 12 * 6, "one RGB triple per LED, no more")
  for (let i = 0; i < 12; i++) {
    assert.ok(/^[0-9A-F]{6}$/.test(stripPixel(hex, i)), "WLED wants RRGGBB")
  }

  // `bars` has nowhere to put a height on one row, so it is `spectrum` there
  // rather than a row of LEDs that are either full on or off.
  assert.strictEqual(
    wledPanelFrame([10, 50, 90, 20], "rainbow", STRIP_CTX, 12, 1, "solid", "bars"), hex)
})

check("a band that is quiet is dim, not missing", () => {
  const loud = stripPixel(wledPanelFrame([100], "rainbow", STRIP_CTX, 4, 1, "solid", "spectrum"), 0)
  const quiet = stripPixel(wledPanelFrame([1], "rainbow", STRIP_CTX, 4, 1, "solid", "spectrum"), 0)
  assert.notStrictEqual(quiet, "000000", "a dark stretch reads as a fault, not as quiet")
  assert.notStrictEqual(quiet, loud, "and it is still darker than a loud one")
})

check("every band gets its own colour, which is what a strip is for", () => {
  // The bug this replaced: the payload asked the palette for band 0 of 1, so
  // a position palette answered with the same hue every time and the whole
  // strip was one colour no matter what was playing.
  const hex = wledPanelFrame([60, 60, 60, 60], "rainbow", STRIP_CTX, 8, 1, "solid", "spectrum")
  const colors = new Set()
  for (let i = 0; i < 8; i++) colors.add(stripPixel(hex, i))
  assert.strictEqual(colors.size, 4, "four bands, four colours, two LEDs each")
})

check("mirror folds the same bands around the middle", () => {
  const hex = wledPanelFrame([10, 50, 90, 20], "rainbow", STRIP_CTX, 12, 1, "solid", "mirror")
  assert.strictEqual(stripPixel(hex, 0), stripPixel(hex, 11), "both ends show the same band")
  assert.strictEqual(wledBandAt(0, 12, 4, "mirror"), wledBandAt(11, 12, 4, "mirror"))
  assert.strictEqual(wledBandAt(5, 12, 4, "mirror"), wledBandAt(6, 12, 4, "mirror"),
    "and the middle is where the low band lives")
})

check("a light that has not answered yet is not painted at all", () => {
  assert.strictEqual(wledPanelFrame([50], "rainbow", STRIP_CTX, 0, 1, "solid", "spectrum"), "")
  assert.strictEqual(wledPanelFrame([], "rainbow", STRIP_CTX, 30, 1, "solid", "spectrum"), "")
  assert.strictEqual(wledPanelFrame(null, "rainbow", STRIP_CTX, 30, 1, "solid", "spectrum"), "")
})

// PS Fire, as a Gledopto running WLED 16 reports it. Eight labels: five
// sliders and three checkboxes, and the checkboxes are not this bridge's to
// touch — flipping a boolean fifteen times a second is a glitch, not motion.
const PS_FIRE = "Speed,Intensity,Flame Height,Wind,Spread,Smooth,Cylinder,Turbulence;;!;2;pal=35"
const PS_FIRE_SEG = { sx: 110, ix: 128, c1: 110, c2: 50, c3: 31 }

check("an effect says which knobs it has, and the light says where they sit", () => {
  const knobs = wledDeclaredKnobs(PS_FIRE, PS_FIRE_SEG)
  assert.deepStrictEqual(knobs.map(k => k.key), ["sx", "ix", "c1", "c2", "c3"])
  assert.deepStrictEqual(knobs.map(k => k.label),
    ["Speed", "Intensity", "Flame Height", "Wind", "Spread"])
  assert.deepStrictEqual(knobs.map(k => k.base), [110, 128, 110, 50, 31])
  assert.strictEqual(knobs[4].max, 31, "c3 is the one that does not go to 255")

  // A label the effect leaves blank is a slider it does not use. Driving it
  // writes a value the effect never reads, which is invisible and confusing.
  assert.deepStrictEqual(
    wledDeclaredKnobs("Cooling,Spark rate,,2D Blur,Boost", {}).map(k => k.key),
    ["sx", "ix", "c2", "c3"])
  assert.deepStrictEqual(wledDeclaredKnobs(";!,!;!;01f", {}), [])
  assert.deepStrictEqual(wledDeclaredKnobs("", {}), [], "Solid has no sliders at all")
  assert.strictEqual(wledDeclaredKnobs("Speed", {})[0].base, 128,
    "a light that did not say defaults to the middle, not to zero")
})

check("the knobs that do not take modulation are left alone", () => {
  assert.deepStrictEqual(
    wledPickKnobs(wledDeclaredKnobs(PS_FIRE, PS_FIRE_SEG)).map(k => k.label),
    ["Intensity", "Flame Height", "Wind", "Spread"], "Speed is the effect's own clock")

  // Roughly a third of WLED's effects declare nothing but decay knobs. Empty
  // is the honest answer there; the caller falls back to brightness rather
  // than driving Fade rate and Blur and calling the result a visualiser.
  assert.deepStrictEqual(wledPickKnobs(wledDeclaredKnobs("Fade rate,Blur", {})), [])
  assert.deepStrictEqual(wledPickKnobs([]), [])
  for (const label of ["Blur", "2D Blur", "Fade rate", "Scroll speed", "Select bin",
                       "Sensitivity", "Volume (min)", "Starting color", "Font size"]) {
    assert.strictEqual(wledKnobModulatable(label), false, label)
  }
  for (const label of ["Flame Height", "Wind", "Gravity", "# of balls", "Density",
                       "Explosion Size", "Amplitude 1", "Cooling"]) {
    assert.strictEqual(wledKnobModulatable(label), true, label)
  }
})

check("the knob the spectrum drives can be named, and is named by label", () => {
  const declared = wledDeclaredKnobs(PS_FIRE, PS_FIRE_SEG)
  assert.deepStrictEqual(wledKnobLabels(declared),
    ["Speed", "Intensity", "Flame Height", "Wind", "Spread"])

  // By label, not by key: `c1` is "Flame Height" on PS Fire, "Low bin" on
  // Freqwave and "Arms" on PS Vortex. The key names a slot; only the label
  // names a thing, and it is the word the light's own app shows.
  const one = wledDriveKnobs(declared, "Wind")
  assert.deepStrictEqual(one.map(k => k.label), ["Wind"])
  assert.strictEqual(one[0].key, "c2")
  assert.strictEqual(one[0].base, 50, "and it keeps the value the light had")

  // Nothing asked for: the blocklist's guess, which is what it always was.
  assert.deepStrictEqual(wledDriveKnobs(declared, "").map(k => k.label),
    ["Intensity", "Flame Height", "Wind", "Spread"])

  // A name the current effect does not have is the effect having been changed
  // on the light, not an error. The guess beats driving nothing, and beats
  // guessing which of the new sliders was meant.
  assert.deepStrictEqual(wledDriveKnobs(declared, "Cooling").map(k => k.label),
    ["Intensity", "Flame Height", "Wind", "Spread"])
  assert.deepStrictEqual(wledDriveKnobs([], "Wind"), [])

  // The row is offered only when there is more than nothing to choose between.
  assert.strictEqual(wledKnobRows([]).length, 0)
  assert.strictEqual(wledKnobRows(null).length, 0)
  const row = wledKnobRows(["Wind", "Spread"])[0]
  assert.strictEqual(row.key, "wledKnob")
  assert.deepStrictEqual(row.values, ["", "Wind", "Spread"], "empty is the guess")
})

check("one named knob hears the whole spectrum", () => {
  const ctx = { accent: { r: 0, g: 1, b: 0.5 }, foreground: { r: 1, g: 1, b: 1 },
    urgent: { r: 1, g: 0, b: 0 }, peakThreshold: 85 }
  // With four knobs each takes a quarter of the bands. With one it takes all
  // of them, or naming a single knob would wire it to the bass alone and the
  // rest of the song would go nowhere.
  const only = wledDriveKnobs(wledDeclaredKnobs(PS_FIRE, PS_FIRE_SEG), "Wind")
  const wide = JSON.parse(wledParamsPayload(only, [100, 100, 100, 100], 0.4)).seg[0]
  const treble = JSON.parse(wledParamsPayload(only, [0, 0, 0, 100], 0.4)).seg[0]
  const bass = JSON.parse(wledParamsPayload(only, [100, 0, 0, 0], 0.4)).seg[0]
  assert.strictEqual(wide.c2, 50 + Math.round(0.4 * 255))
  assert.strictEqual(treble.c2, bass.c2,
    "one knob hears every band alike, rather than being wired to the bass")
  assert.notStrictEqual(wide.c2, treble.c2)
  assert.deepStrictEqual(Object.keys(wide), ["id", "c2"], "nothing else is touched")
})

check("each knob gets its own slice of the spectrum", () => {
  // One number driving every knob is what brightness already does, and it
  // makes the whole effect pulse in phase. Low bands first: the knob that
  // moves most is the one the bass is on.
  const frame = [100, 100, 0, 0]
  assert.strictEqual(wledKnobLevel(frame, 0, 2), 1)
  assert.strictEqual(wledKnobLevel(frame, 1, 2), 0)
  assert.strictEqual(wledKnobLevel([100, 0], 0, 1), 0.5, "one knob hears everything")
  // More knobs than bands: a slice is never empty, so a knob never divides by
  // zero and never silently reads as full silence.
  assert.strictEqual(wledKnobLevel([100], 3, 8), 1)
  assert.strictEqual(wledKnobLevel([], 0, 4), 0)
  assert.strictEqual(wledKnobLevel(null, 0, 4), 0)
})

check("the effect keeps running while the audio moves its knobs", () => {
  const knobs = wledPickKnobs(wledDeclaredKnobs(PS_FIRE, PS_FIRE_SEG))
  const payload = JSON.parse(wledParamsPayload(knobs, [100, 100, 100, 100], 0.4))
  const seg = payload.seg[0]

  assert.strictEqual(seg.frz, undefined, "freezing it would stop the effect this style is for")
  assert.strictEqual(seg.fx, undefined, "the effect is the point")
  assert.strictEqual(seg.col, undefined)
  assert.strictEqual(payload.bri, undefined, "the knobs carry the audio here, not the brightness")

  // Full scale, so every knob is at its base plus the whole span.
  assert.strictEqual(seg.ix, 128 + Math.round(0.4 * 255))
  assert.strictEqual(seg.c2, 50 + Math.round(0.4 * 255))
  assert.strictEqual(seg.c3, 31, "and clamped to its own ceiling, not to 255")

  // Bipolar around the base: silence has to give back what the user tuned,
  // and a knob that only ever rises spends the quiet half of a song pinned.
  const quiet = JSON.parse(wledParamsPayload(knobs, [0, 0, 0, 0], 0.4)).seg[0]
  assert.strictEqual(quiet.c2, Math.max(0, 50 - Math.round(0.4 * 255)))
  const still = JSON.parse(wledParamsPayload(knobs, [50, 50, 50, 50], 0.4)).seg[0]
  assert.deepStrictEqual([still.ix, still.c1, still.c2, still.c3], [128, 110, 50, 31])
  assert.deepStrictEqual(JSON.parse(wledParamsPayload(knobs, [100, 100], 0)).seg[0],
    { id: 0, ix: 128, c1: 110, c2: 50, c3: 31 }, "no span, no movement")
})

check("a panel gets bars, one column per band, standing on the floor", () => {
  const ctx = { accent: { r: 0, g: 1, b: 0.5 }, foreground: { r: 1, g: 1, b: 1 },
    urgent: { r: 1, g: 0, b: 0 }, peakThreshold: 85 }
  // Four columns, four rows, two bands: half the panel per band. Full scale on
  // the first band, silence on the second.
  const hex = wledPanelFrame([100, 0], "rainbow", ctx, 4, 4, "solid", "bars")
  assert.strictEqual(hex.length, 4 * 4 * 6, "one RGB triple per pixel, no more")

  const pixel = (x, y) => hex.slice((y * 4 + x) * 6, (y * 4 + x) * 6 + 6)
  // Row-major with y=0 at the top, so a full-height bar reaches the top row
  // and an empty one is dark all the way down.
  for (let y = 0; y < 4; y++) {
    assert.notStrictEqual(pixel(0, y), "000000", "loud band, row " + y)
    assert.strictEqual(pixel(3, y), "000000", "silent band, row " + y)
  }

  // Half scale is half the rows, and it is the BOTTOM half: bars stand on the
  // floor. Getting this upside down is invisible in a test that only counts
  // lit pixels.
  const half = wledPanelFrame([50], "rainbow", ctx, 1, 4, "solid", "bars")
  const rows = [0, 1, 2, 3].map(y => half.slice(y * 6, y * 6 + 6))
  assert.deepStrictEqual(rows.map(c => c !== "000000"), [false, false, true, true])

  // Silence is no frame at all, not a frame of black: realtime packets hold
  // the light in realtime for as long as they arrive, so streaming black
  // would pin a dark panel instead of letting it go back to its effect.
  assert.strictEqual(wledPanelFrame([0, 0], "rainbow", ctx, 4, 4, "solid", "bars"), "")
  assert.notStrictEqual(wledPanelFrame([5, 0], "rainbow", ctx, 4, 24, "solid", "bars"), "",
    "but one band barely moving is still something to draw")
  assert.strictEqual(wledPanelFrame([], "rainbow", ctx, 4, 4, "solid", "bars"), "")
  assert.strictEqual(wledPanelFrame([100], "rainbow", ctx, 0, 4, "solid", "bars"), "")
  assert.strictEqual(wledPanelFrame(null, "rainbow", ctx, 4, 4, "solid", "bars"), "")
})

check("a panel bar is the bar on screen, gradient and all", () => {
  const ctx = { accent: { r: 0, g: 1, b: 0.5 }, foreground: { r: 1, g: 1, b: 1 },
    urgent: { r: 1, g: 0, b: 0 }, peakThreshold: 85 }
  // The bug this replaced: the strip painted one flat colour per band while
  // the screen drew each bar as a gradient, so the two never matched. A panel
  // bar has a height, so it can show the whole pair.
  const pair = barGradientPair("rainbow", 0, 1, 100, ctx, "barGradient")
  const hex = wledPanelFrame([100], "rainbow", ctx, 1, 8, "barGradient", "bars")
  const rows = []
  for (let y = 0; y < 8; y++) rows.push(hex.slice(y * 6, y * 6 + 6))

  assert.strictEqual(rows[7], wledHex(pair.base), "the base sits on the floor")
  assert.strictEqual(rows[0], wledHex(pair.tip), "the tip is the top of the bar")
  assert.notStrictEqual(rows[0], rows[7], "and they are two colours, not one")
  assert.strictEqual(new Set(rows).size, 8, "every row between them differs")

  // A short bar still shows both ends -- the tip is the top of THIS bar, not
  // the top of the panel, the same way a quiet bar on screen still has one.
  const quiet = wledPanelFrame([25], "rainbow", ctx, 1, 8, "barGradient", "bars")
  const short = [0, 1, 2, 3, 4, 5, 6, 7].map(y => quiet.slice(y * 6, y * 6 + 6))
  assert.deepStrictEqual(short.slice(0, 6), Array(6).fill("000000"))
  assert.strictEqual(short[6], wledHex(barGradientPair("rainbow", 0, 1, 25, ctx, "barGradient").tip))
  assert.notStrictEqual(short[6], short[7])

  // The fill is a setting, and it has to reach here: `solid` means one colour
  // up the whole column, and reading the same picture as `barGradient` would
  // mean the setting never arrived.
  const flat = wledPanelFrame([100], "rainbow", ctx, 1, 8, "solid", "bars")
  assert.strictEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]
    .map(y => flat.slice(y * 6, y * 6 + 6))).size, 1)
  assert.notStrictEqual(flat, hex)
})

check("on a panel, spectrum runs along the width and fills the height", () => {
  const ctx = { accent: { r: 0, g: 1, b: 0.5 }, foreground: { r: 1, g: 1, b: 1 },
    urgent: { r: 1, g: 0, b: 0 }, peakThreshold: 85 }
  // The bug: `spectrum` and `mirror` went out as run-length indices over all
  // 768 pixels, which is a line that snakes across the rows. The bands did not
  // line up with the columns and nothing lined up with the height -- a
  // rectangle treated as a long strip.
  const hex = wledPanelFrame([100, 0], "rainbow", ctx, 4, 4, "solid", "spectrum")
  const px = (x, y) => hex.slice((y * 4 + x) * 6, (y * 4 + x) * 6 + 6)

  for (let y = 0; y < 4; y++) {
    assert.strictEqual(px(0, y), px(0, 0), "a column is one colour, top to bottom")
    assert.notStrictEqual(px(0, y), "000000", "and the loud band fills its height")
    // Never black: a quiet band that goes dark takes its stretch of the panel
    // out of the picture and the whole thing reads as a fault.
    assert.notStrictEqual(px(3, y), "000000", "the quiet band is dim, not gone")
  }
  assert.notStrictEqual(px(0, 0), px(3, 0), "loud and quiet differ in brightness")

  // `bars` is the one that puts the value in the height instead.
  const bars = wledPanelFrame([100, 0], "rainbow", ctx, 4, 4, "solid", "bars")
  assert.strictEqual(bars.slice((0 * 4 + 3) * 6, (0 * 4 + 3) * 6 + 6), "000000",
    "a silent band has no bar at all")
})

check("mirror folds the bands across the width, not along the wire", () => {
  const ctx = { accent: { r: 0, g: 1, b: 0.5 }, foreground: { r: 1, g: 1, b: 1 },
    urgent: { r: 1, g: 0, b: 0 }, peakThreshold: 85 }
  // Eight columns, two bands: the low band belongs in the middle and the high
  // one at both edges, which is the same fold the strip does over its wire.
  const hex = wledPanelFrame([100, 10], "rainbow", ctx, 8, 1, "solid", "mirror")
  const col = x => hex.slice(x * 6, x * 6 + 6)
  assert.strictEqual(col(3), col(4), "the middle two share the low band")
  assert.strictEqual(col(0), col(7), "and the two edges share the high one")
  assert.notStrictEqual(col(0), col(3))

  const straight = wledPanelFrame([100, 10], "rainbow", ctx, 8, 1, "solid", "spectrum")
  assert.notStrictEqual(straight.slice(0, 6), straight.slice(7 * 6, 7 * 6 + 6),
    "unfolded, the two ends are different bands")
  assert.notStrictEqual(hex, straight)

  assert.strictEqual(isWledPanelStyle("bars"), true)
  assert.strictEqual(isWledPanelStyle("spectrum"), true)
  assert.strictEqual(isWledPanelStyle("mirror"), true)
  assert.strictEqual(isWledPanelStyle("solid"), false, "a lamp style, not a panel one")
  assert.strictEqual(isWledPanelStyle("params"), false)
})

check("a strip can always be streamed; a panel only from the origin", () => {
  // DNRGB indexes LEDs in order, so a strip's segment start is just the index
  // its frame is written at. Which LED a PANEL pixel lands on is the light's
  // own ledmap, unknowable from here, so a segment starting anywhere else
  // would be painted through a mapping this plugin invented.
  const panel = { matrix: true, width: 32, height: 24 }
  const strip = { matrix: false, width: 49, height: 1 }

  assert.strictEqual(wledCanStream(panel, { start: 0, startY: 0 }), true)
  assert.strictEqual(wledCanStream(panel, { start: 8, startY: 0 }), false)
  assert.strictEqual(wledCanStream(panel, { start: 0, startY: 4 }), false)
  assert.strictEqual(wledCanStream(strip, { start: 0 }), true)
  assert.strictEqual(wledCanStream(strip, { start: 12 }), true, "an offset is an offset")
  assert.strictEqual(wledCanStream(null, {}), false)

  assert.strictEqual(wledStreamStart(strip, { start: 12 }), 12)
  assert.strictEqual(wledStreamStart(strip, {}), 0)
  assert.strictEqual(wledStreamStart(panel, { start: 0, startY: 0 }), 0,
    "a panel is only ever written from zero")
})

check("a light is fed in packets, not in frames", () => {
  // The bug: a 768-pixel panel is two DNRGB packets, so pacing by frames sent
  // 60 packets a second into something turning over 37 times. What WLED drops
  // is what arrived last — the second half of every frame, which on a bar
  // chart is the half the bars stand on. It read as a second of lag.
  assert.strictEqual(wledStreamPackets(489), 1, "the protocol's own ceiling")
  assert.strictEqual(wledStreamPackets(490), 2)
  assert.strictEqual(wledStreamPackets(768), 2)
  assert.strictEqual(wledStreamPackets(49), 1, "a strip is always one")
  assert.strictEqual(wledStreamPackets(0), 1, "never zero, or nothing is ever due")

  // The budget is packets a second, so the frame rate a light gets is that
  // budget divided by what one frame costs it.
  assert.strictEqual(wledStreamFps(400), 50, "one packet, so the whole budget")
  assert.strictEqual(wledStreamFps(768), 25, "two packets, so half of it")
  assert.strictEqual(wledStreamFps(2000), 10)

  assert.strictEqual(wledStreamDue(0, 19, 400), false, "19ms is not quite 1/50")
  assert.strictEqual(wledStreamDue(0, 20, 400), true)
  assert.strictEqual(wledStreamDue(0, 20, 768), false, "the panel waits twice as long")
  assert.strictEqual(wledStreamDue(0, 40, 768), true)
})

check("the host travels as data, never as command", () => {
  assert.strictEqual(wledStreamLine("led.local", 0, "FF0000"), "led.local\t0\tFF0000\n")
  assert.strictEqual(wledStreamLine("led.local", 12, "FF0000"), "led.local\t12\tFF0000\n")
  assert.strictEqual(wledStreamLine("a", -3, "00"), "a\t0\t00\n", "never behind the first LED")
  // One line per frame is what lets the streamer outlive the frames it drops,
  // and a tab is the one character neither a host nor a hex string contains.
  assert.strictEqual(wledStreamLine("a", 0, "00").split("\n").length, 2)
})

check("an effect with no knob to drive keeps its effect", () => {
  // The one-colour payload carries fx 0. Sending it as the fallback would
  // turn "nothing here takes modulation" into "your effect is gone", which is
  // the loudest possible way to handle a case that should be quiet.
  const payload = JSON.parse(wledBrightnessPayload(200))
  assert.deepStrictEqual(payload, { on: true, bri: 200 })
  assert.strictEqual(payload.seg, undefined)
})

check("stopping puts the knobs back where the light had them", () => {
  // `params` moves sliders rather than taking the strip, so the same recorded
  // baseline that undoes `solid` undoes this too -- one restore, not one per
  // style, because a style added later would otherwise arrive without one.
  const restore = JSON.parse(wledRestorePayload(wledBaseline({
    on: true, bri: 124, seg: [Object.assign({ id: 0, fx: 188 }, PS_FIRE_SEG)]
  })))
  assert.strictEqual(restore.on, true, "it was never taken away, so off is not a restore")
  assert.strictEqual(restore.seg[0].fx, 188)
  assert.deepStrictEqual(
    [restore.seg[0].sx, restore.seg[0].ix, restore.seg[0].c1,
     restore.seg[0].c2, restore.seg[0].c3], [110, 128, 110, 50, 31])
})

check("solid means solid, not the strip's effect tinted", () => {
  // The bug: col alone. An unfrozen segment keeps running fx, and any palette
  // but Default ignores col[0] — so the lamp showed its own effect in its own
  // colours while the plugin thought it was driving it.
  const solid = JSON.parse(wledPayload(128, { r: 1, g: 0, b: 0 })).seg[0]
  assert.strictEqual(solid.fx, 0, "Solid")
  assert.strictEqual(solid.pal, 0, "Default, or col[0] is ignored")
  assert.deepStrictEqual(solid.col, [[255, 0, 0]])
})

check("every way out of the spectrum lifts the freeze", () => {
  // A frozen segment keeps the last frame for as long as it stays on, and the
  // strip's own effects never run again.
  assert.strictEqual(JSON.parse(wledPayload(128, { r: 1, g: 0, b: 0 })).seg[0].frz, false,
    "falling back to solid")
  assert.strictEqual(JSON.parse(wledRestorePayload(null)).seg[0].frz, false,
    "and stopping altogether")
})

const siLine = (host, body) => host + "\t" + JSON.stringify(body)
const si = (seg, count) => ({
  state: { seg: seg === null ? [] : [seg] },
  info: { leds: { count: count === undefined ? 144 : count } }
})

check("the strip is asked what it is once, per host, as data", () => {
  for (const command of [wledInfoCommand(["led.local", "$(touch /tmp/pwned)"]),
                         wledFxDataCommand(["led.local", "$(touch /tmp/pwned)"])]) {
    assert.strictEqual(command[0], "sh")
    assert.ok(command[2].indexOf("-m 3") > 0, "a light that does not answer is not waited on")
    assert.strictEqual(command[command.length - 1], "$(touch /tmp/pwned)",
      "hosts are arguments, never script")
    assert.strictEqual(command[2].indexOf("touch"), -1)
  }
  assert.ok(wledInfoCommand([])[2].indexOf("/json/si") > 0,
    "state and info in one request: the bridge needs both")
  assert.ok(wledFxDataCommand([])[2].indexOf("/json/fxdata") > 0)

  // The board truncates the big one: 9205 bytes ten times in twelve and 5514
  // twice, cut off mid-array. Half a JSON document does not parse, and this
  // is asked once per effect change, so one short answer left `params` with
  // no knobs until the effect changed again.
  assert.ok(wledFxDataCommand([])[2].indexOf('*"]"') > 0,
    "a complete array ends with its own closer; a truncated one does not")
  assert.ok(wledInfoCommand([])[2].indexOf('*"}"') > 0)
  for (const command of [wledInfoCommand([]), wledFxDataCommand([])]) {
    assert.ok(command[2].indexOf("while") > 0, "and a short answer is asked again")
  }
})

check("an answer that is not a strip is not believed", () => {
  const answer = parseWledInfo(siLine("led.local", si({ start: 0, stop: 144, fx: 188 })))
  assert.strictEqual(answer.host, "led.local")
  assert.strictEqual(answer.count, 144)
  assert.strictEqual(answer.fx, 188)
  assert.strictEqual(parseWledInfo("led.local\t"), null, "no answer at all")
  assert.strictEqual(parseWledInfo("led.local\tnot json"), null)
  assert.strictEqual(parseWledInfo("led.local\t{}"), null, "no length, no painting")
  assert.strictEqual(parseWledInfo("no tab here"), null)
  assert.strictEqual(parseWledInfo(""), null)
})

check("the segmented cap grows from the base edge like every other cap", () => {
  // The bug: the segmented column counted blocks up from the floor and never
  // read `base`, so `top` and `mirror` looked like settings that did nothing
  // while `flat` and `round` honoured them through barGeometry.
  const unit = 10, gap = 2, height = 100

  const bottom = [0, 1, 2].map(i => segmentGeometry("bottom", i, 8, unit, gap, height))
  assert.deepStrictEqual(bottom.map(g => g.y), [90, 78, 66], "off the floor, upward")

  const top = [0, 1, 2].map(i => segmentGeometry("top", i, 8, unit, gap, height))
  assert.deepStrictEqual(top.map(g => g.y), [0, 12, 24], "off the ceiling, downward")
  assert.deepStrictEqual(top.map(g => g.step), [0, 1, 2], "and lit in the same order")

  // Mirror is two columns off the middle, so it needs twice the blocks and
  // half the room, and the second half counts its steps from the centre again.
  assert.strictEqual(segmentCount("mirror", 8), 16)
  assert.strictEqual(segmentCount("bottom", 8), 8)
  assert.strictEqual(segmentSpan("mirror", 100), 50)
  assert.strictEqual(segmentSpan("top", 100), 100)

  const up = [0, 1].map(i => segmentGeometry("mirror", i, 8, unit, gap, height))
  const down = [8, 9].map(i => segmentGeometry("mirror", i, 8, unit, gap, height))
  assert.deepStrictEqual(up.map(g => g.y), [40, 28], "above the middle, rising")
  assert.deepStrictEqual(down.map(g => g.y), [50, 62], "below it, falling")
  assert.deepStrictEqual(down.map(g => g.step), [0, 1],
    "the mirrored half lights with its twin, not after every block on the other side")
})

check("a matrix is measured in two directions, a strip in one", () => {
  // The bug: a 32x24 panel whose segment 0 reads `start 0, stop 32`. On a
  // strip that subtraction is the pixel count; on a matrix it is the WIDTH,
  // so the bridge sized a 768-pixel panel at 32 and every band but the first
  // fell off the end. info.leds.count is no better -- that light counts 1344
  // LEDs behind the panel.
  const panel = parseWledInfo(siLine("led.local", {
    state: { seg: [{ start: 0, stop: 32, startY: 0, stopY: 24, fx: 188 }] },
    info: { leds: { count: 1344, matrix: { w: 32, h: 24 } } }
  }))
  assert.strictEqual(panel.matrix, true)
  assert.strictEqual(panel.width, 32)
  assert.strictEqual(panel.height, 24)
  assert.strictEqual(panel.count, 768, "not 32, and not 1344")

  const strip = parseWledInfo(siLine("led.local", si({ start: 0, stop: 49 }, 49)))
  assert.strictEqual(strip.matrix, false)
  assert.strictEqual(strip.height, 1, "one row, so width is the whole answer")
  assert.strictEqual(strip.count, 49)

  // Half a panel is still a panel.
  const half = parseWledInfo(siLine("led.local", {
    state: { seg: [{ start: 8, stop: 24, startY: 0, stopY: 12 }] },
    info: { leds: { count: 768, matrix: { w: 32, h: 24 } } }
  }))
  assert.deepStrictEqual([half.width, half.height, half.count], [16, 12, 192])
})

check("the segment bounds the paint, not the strip", () => {
  // The bug: a Gledopto reporting 1344 LEDs whose segment 0 stops at 32. The
  // `i` indices are relative to the segment and WLED drops the ones past its
  // end, so every band but the first fell off and 32 LEDs showed one colour.
  assert.strictEqual(
    parseWledInfo(siLine("led.local", si({ start: 0, stop: 32, fx: 1 }, 1344))).count, 32)
  assert.strictEqual(
    parseWledInfo(siLine("led.local", si(null, 60))).count, 60,
    "no segment to ask, so the strip is the answer")
  assert.strictEqual(
    parseWledInfo(siLine("led.local", si({ start: 0, stop: 900 }, 60))).count, 60,
    "and a segment claiming more than the strip has is not believed either")
})

check("only the running effect's slider layout is kept", () => {
  const table = ["Speed,Intensity", "", "Cooling,Spark rate,,2D Blur,Boost"]
  const line = "led.local\t" + JSON.stringify(table)
  assert.deepStrictEqual(parseWledFxData(line, { "led.local": 2 }),
    { host: "led.local", meta: "Cooling,Spark rate,,2D Blur,Boost" })
  assert.strictEqual(parseWledFxData(line, { "led.local": 99 }), null,
    "an effect the firmware does not have")
  assert.strictEqual(parseWledFxData(line, {}), null, "nothing known about this host yet")
  assert.strictEqual(parseWledFxData("led.local\t{}", { "led.local": 0 }), null)
  assert.strictEqual(parseWledFxData("no tab here", {}), null)
})

check("a light shows as whatever its owner called it", () => {
  assert.strictEqual(value("wledDevices", "kitchen"), "kitchen")
  assert.strictEqual(value("wledDevices", ""), "all")
  setLanguage("pt")
  assert.strictEqual(value("wledDevices", "kitchen"), "kitchen", "a name is not translated")
  assert.strictEqual(value("wledDevices", ""), "todos")
  assert.strictEqual(value("base", "mirror"), "espelho", "a value still is")
  setLanguage("en")
})

check("a key that is nobody's setting does nothing", () => {
  assert.strictEqual(rowForAccel("z"), null)
  assert.strictEqual(rowForAccel(""), null)
  assert.strictEqual(rowForAccel(undefined), null)
  assert.strictEqual(rowForAccel("P").key, "palette", "shift-P is still the palette")
})

check("the tooltip is a template, not translated fragments glued together", () => {
  assert.ok(STRINGS.en["widget.tooltip"].indexOf("{base}") >= 0)
  assert.strictEqual(
    t("widget.tooltip", { base: "mirror", palette: "rainbow" }),
    "mirror · rainbow · click to open")
})

check("the window mode is gone: the compositor owns that", () => {
  assert.strictEqual(typeof MODES, "undefined")
  assert.strictEqual(DEFAULTS.mode, undefined)
  assert.strictEqual(DEFAULTS.language, "auto")
})

// ------------------------------------------------------- file ceilings

check("a file past the ceiling is refused rather than held", () => {
  const fat = JSON.stringify({ barCount: 16, junk: "x".repeat(MAX_CONFIG_BYTES) })
  assert.ok(fat.length > MAX_CONFIG_BYTES)
  assert.strictEqual(parseSettingsFile(fat), null, "nothing of it is kept")
  assert.strictEqual(parseConfigFile(fat), null)
  assert.deepStrictEqual(parseSettingsFile('{"barCount":16}'), { barCount: 16 },
    "an ordinary file still loads")
})

check("the read is the ceiling, not a measurement taken before it", () => {
  // The bug this replaced: stat in one process, open in another. A same-user
  // writer only had to grow the file in between for the shell to read bytes
  // nobody had counted.
  const command = readCappedCommand("/home/someone/.config/omarchy/visualizer.json",
    MAX_CONFIG_BYTES)
  const script = command[2]
  assert.strictEqual(command[0], "sh")
  assert.ok(script.indexOf("stat") < 0, "nothing is measured separately any more")
  assert.ok(script.indexOf('head -c "$((c + 1))"') >= 0,
    "one byte past the ceiling, so a file that did not fit says so")
  assert.ok(script.indexOf('[ -f "$f" ] || exit 1') >= 0, "regular files only")
  assert.ok(script.indexOf("timeout") >= 0, "a fifo must not hold the read open")
  assert.strictEqual(command[command.length - 1], String(MAX_CONFIG_BYTES))
})

check("the path the read runs on is data, never script", () => {
  const nasty = "/home/someone/$(touch /tmp/pwned)/`id`.json"
  const command = readCappedCommand(nasty, MAX_CONFIG_BYTES)
  assert.strictEqual(command.indexOf(nasty), command.length - 2,
    "passed as an argument")
  assert.strictEqual(command[2].indexOf(nasty), -1, "and never spliced in")
})

check("the device list is read to a fixed depth", () => {
  const devices = []
  for (let i = 0; i < 5000; i++) devices.push({ host: "wled-" + i, address: "10.0.0." + i })
  const hosts = wledHostList({ devices: devices }, [])
  assert.strictEqual(hosts.length, MAX_WLED_DEVICES)
  assert.strictEqual(hosts[0], "10.0.0.0")
  assert.deepStrictEqual(wledHostList(null, []), [], "a file that never loaded is empty")
  assert.deepStrictEqual(wledHostList({}, []), [])
})

check("the names asked for are capped the same way", () => {
  const spec = new Array(5000).fill("lamp").join(",")
  assert.strictEqual(wledWantedNames(spec).length, MAX_WLED_DEVICES)
  assert.deepStrictEqual(wledWantedNames(" desk , shelf ,, "), ["desk", "shelf"])
  assert.deepStrictEqual(wledWantedNames(""), [])
  assert.deepStrictEqual(wledWantedNames(undefined), [])
})

check("naming a device still picks it out of the file", () => {
  const parsed = { devices: [
    { name: "desk", host: "wled-desk", address: "10.0.0.2" },
    { name: "shelf", host: "wled-shelf", address: "10.0.0.3" },
    { name: "broken" }
  ] }
  assert.deepStrictEqual(wledHostList(parsed, []), ["10.0.0.2", "10.0.0.3"],
    "no filter means every device that has an address")
  assert.deepStrictEqual(wledHostList(parsed, ["shelf"]), ["10.0.0.3"])
  assert.deepStrictEqual(wledHostList(parsed, ["wled-desk"]), ["10.0.0.2"],
    "by host as well as by name")
  assert.deepStrictEqual(wledHostList(parsed, ["nobody"]), [])
})

check("the mix is never fed from its own monitor", () => {
  assert.ok(isMixMonitor("omarchy_visualizer_mix.monitor"),
    "a loopback from the mix into the mix is a feedback loop")
  assert.ok(!isMixMonitor("bluez_output.C0_DA_5E_AB_82_10.1.monitor"))
  assert.ok(!isMixMonitor(""))
  assert.ok(!isMixMonitor(null))
})

check("the mix asks not to be made the default sink", () => {
  const props = mixSetupCommands("a.monitor", "b").
    find(c => c.indexOf("module-null-sink") >= 0).
    find(a => String(a).indexOf("sink_properties=") === 0)
  assert.ok(props.indexOf("priority.session=0") > 0,
    "the newest sink is what gets promoted, and this one plays to nothing")
})

check("the mix is rebuilt around the device, not the name", () => {
  const built = mixSetupCommands("headphones.monitor", "mic1")
  assert.ok(built[1].indexOf("source=headphones.monitor") > 0)
  assert.ok(built[2].indexOf("source=mic1") > 0)
  // The sink name is fixed, which is why cava's config survives a rebuild and
  // only its capture has to be reopened.
  assert.ok(built[0].indexOf("sink_name=" + MIX_SINK) > 0)
})

check("the teardown takes this plugin's modules and nobody else's", () => {
  const script = mixTeardownCommand()[2]
  assert.ok(script.indexOf(MIX_SINK) > 0,
    "modules are found by the sink they name, not by being a null sink")
  assert.ok(script.indexOf("unload-module module-null-sink") < 0
    && script.indexOf("unload-module module-loopback") < 0,
    "unloading by name would take every loopback on the machine with it")
  assert.ok(script.indexOf("xargs") > 0, "what it finds is what it unloads")
})

check("the mix does not present itself as somewhere to play", () => {
  const props = mixSetupCommands("a.monitor", "b")[0]
    .find(a => String(a).indexOf("sink_properties=") === 0)
  assert.ok(props.indexOf("device.class=filter") > 0,
    "picking it as an output sends audio into a sink with no way out")
})

// ------------------------------------------------- choosing a microphone

check("the source list leaves monitors out", () => {
  const script = sourceListCommand()[2]
  assert.ok(script.indexOf("monitor") > 0,
    "a monitor is the other half of the mix, not a microphone")
  assert.deepStrictEqual(parseSourceList("a\nb\n\na\n"), ["a", "b"],
    "blank lines and repeats are not devices")
  assert.deepStrictEqual(parseSourceList(""), [])
  assert.deepStrictEqual(parseSourceList(null), [])
})

check("a source is named by the part that tells it apart", () => {
  const full = "alsa_input.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Mic1__source"
  assert.strictEqual(sourceLabel(full), "Mic1")
  assert.strictEqual(sourceLabel("bluez_input.C0:DA:5E:AB:82:10"), "bluez_input")
  assert.strictEqual(sourceLabel(""), "")
})

check("a microphone that is gone falls back to the system default", () => {
  const names = [
    "alsa_input.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Mic1__source",
    "bluez_input.C0:DA:5E:AB:82:10"
  ]
  assert.strictEqual(resolveSource("Mic1", names), names[0])
  // Empty is what the service ORs against the default, so both of these mean
  // "use whatever the system says".
  assert.strictEqual(resolveSource("Headset", names), "",
    "unplugged is not a device to keep pointing at")
  assert.strictEqual(resolveSource("", names), "")
  assert.strictEqual(resolveSource("Mic1", []), "")
})

check("the microphone row offers the default and every device once", () => {
  const names = ["x__Mic1__source", "y__Mic1__source", "bluez_input.AA"]
  const row = micRows(names)[0]
  assert.strictEqual(row.key, "micDevice")
  assert.deepStrictEqual(row.values, ["", "Mic1", "bluez_input"],
    "two cards with the same short name are one choice, not two")
  assert.strictEqual(row.values[0], "", "the system default leads")
})

check("no two rows answer to the same key", () => {
  const all = SETTING_ROWS.concat(MIC_ROWS).concat(WLED_ROWS)
  const seen = {}
  for (const row of all) {
    assert.ok(!seen[row.accel], "two rows share the accelerator " + row.accel)
    seen[row.accel] = true
  }
})

check("the manifest offers the microphone with a default that means system", () => {
  const manifest = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"))
  const entry = manifest.barWidget.schema.find(s => s.key === "micDevice")
  assert.ok(entry, "a setting the pane writes has to be one the manifest declares")
  assert.strictEqual(entry.defaultValue, "")
  assert.strictEqual(manifest.barWidget.defaults.micDevice, "")
})

console.log(passed + " checks passed")
