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

check("the restore puts the lamp back, and says so plainly when it cannot", () => {
  // Leaving a lamp frozen on a colour after the music stops is the worst thing
  // this bridge can do.
  const restored = JSON.parse(wledRestorePayload({ on: true, bri: 200, seg: [{ col: [[1, 2, 3]] }] }))
  assert.strictEqual(restored.bri, 200)
  assert.deepStrictEqual(restored.seg[0].col[0], [1, 2, 3])

  const unknown = JSON.parse(wledRestorePayload(null))
  assert.strictEqual(unknown.on, false, "nothing remembered: turn it off rather than guess")
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
  assert.ok(teardown.indexOf("module-loopback") > 0 && teardown.indexOf("module-null-sink") > 0)
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
  assert.deepStrictEqual(wledRows([])[1].values, [""], "nothing to narrow to")
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

console.log(passed + " checks passed")
