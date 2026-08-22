.pragma library

// Pure logic for the avila.visualizer plugin: the cava config it writes, the
// frames it reads back, the smoothing, the palettes and the WLED bridge.
//
// `.pragma library` so every importing QML file shares one copy — without it
// Service.qml and Panel.qml each get their own, and settings applied in one are
// invisible to the other.
//
// Nothing here touches QML types, so test_visualizer.js can eval it under plain
// node. Theme colours arrive as plain {r,g,b} objects for the same reason.

// ------------------------------------------------------------ cava config
//
// Written to $XDG_RUNTIME_DIR, never to ~/.config/cava. That file belongs to
// the user, and someone who runs cava in a terminal should not find their setup
// rewritten by a bar widget.

function configDir(runtimeDir) {
  return (runtimeDir || "/tmp") + "/omarchy-visualizer"
}

function configPath(runtimeDir) {
  return configDir(runtimeDir) + "/cava.conf"
}

function cavaConfig(settings) {
  var bars = clamp(Math.round(Number(settings.barCount) || 14), 6, 24)
  var framerate = clamp(Math.round(Number(settings.framerate) || 30), 10, 60)

  return [
    "[general]",
    "framerate = " + framerate,
    "bars = " + bars,
    // Let cava do its own gain. Doing it here is more code and a worse result.
    "autosens = 1",
    "",
    "[output]",
    // raw + ascii is one line per frame of N numbers: no binary, no
    // endianness, and a parse that cannot silently misread.
    "method = raw",
    "data_format = ascii",
    "ascii_max_range = " + FRAME_MAX,
    "channels = mono",
    ""
  ].join("\n")
}

function cavaCommand(path) {
  return ["cava", "-p", path]
}

// Whether cava is on PATH at all. The plugin never installs anything; it says
// what is missing and how to get it.
function cavaCheckCommand() {
  return ["sh", "-c", "command -v cava >/dev/null && echo yes || echo no"]
}

var FRAME_MAX = 100

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

// --------------------------------------------------------------- frames

// One line, N values 0..FRAME_MAX separated by ";".
//
// A frame of the wrong length is padded or trimmed rather than rejected: cava
// is restarted whenever barCount changes, and for the frame or two in between
// a short draw is better than a stall.
function parseFrame(line, barCount) {
  var count = Math.max(1, Math.round(Number(barCount) || 1))
  var text = String(line || "").trim()
  if (!text) return null

  var parts = text.split(";")
  var frame = []

  for (var i = 0; i < parts.length && frame.length < count; i++) {
    var piece = parts[i].trim()
    if (!piece) continue
    var value = Number(piece)
    if (!isFinite(value)) return null // a partial line is not a quiet zero
    frame.push(clamp(value, 0, FRAME_MAX))
  }

  if (frame.length === 0) return null
  while (frame.length < count) frame.push(0)
  return frame
}

// Rise immediately, fall gently. The asymmetry is the whole trick: matching the
// attack is what makes it look connected to the sound, and easing the release
// is what stops it looking like noise.
function smoothFrame(previous, next, smoothing) {
  if (!previous || previous.length !== next.length) return next.slice()

  var fall = clamp(Number(smoothing) || 0, 0, 95) / 100
  var out = []

  for (var i = 0; i < next.length; i++) {
    out.push(next[i] >= previous[i]
      ? next[i]
      : previous[i] * fall + next[i] * (1 - fall))
  }

  return out
}

// Room noise keeps the bars trembling at one or two forever. A floor lets the
// widget rest — and, with the bridge on, stops a lamp flickering all night.
function applyFloor(frame, floor) {
  var limit = Math.max(0, Number(floor) || 0)
  var out = []
  for (var i = 0; i < frame.length; i++) out.push(frame[i] < limit ? 0 : frame[i])
  return out
}

// autosens takes a moment to calibrate and the first frames spike. Dropping
// them costs a third of a second and avoids a lurch every time it starts.
var WARMUP_FRAMES = 10

function isWarmup(frameNumber) {
  return frameNumber < WARMUP_FRAMES
}

// ---------------------------------------------------------- energy guards
//
// This runs on a laptop. Repainting a bar at 60fps forever is why most of these
// widgets get uninstalled in a week.

function shouldRun(state) {
  if (!state.installed) return false
  if (!state.visible) return false
  if (state.pauseWhenSilent && !state.playing) return false
  if (state.pauseOnBattery && state.onBattery) return false
  return true
}

// Why it is not running, for the widget to say. "Nothing" is not an error.
function idleReason(state) {
  if (!state.installed) return "missing"
  if (!state.visible) return "hidden"
  if (state.pauseWhenSilent && !state.playing) return "silent"
  if (state.pauseOnBattery && state.onBattery) return "battery"
  return ""
}

// --------------------------------------------------------------- shapes

var SHAPES = ["bars", "mirror", "blocks", "dots", "wave"]

function isShape(name) {
  return SHAPES.indexOf(name) >= 0
}

// How many segments of a blocks bar are lit. Both ends are exact: silence lights
// none, a full bar lights all of them.
function litSegments(value, segments) {
  var total = Math.max(1, Math.round(Number(segments) || 1))
  return clamp(Math.round((value / FRAME_MAX) * total), 0, total)
}

// The points of the wave, as fractions of the drawing area. The renderer scales
// them; keeping it in fractions means the same numbers are testable and the
// canvas never sees a magic pixel.
function wavePoints(frame) {
  var points = []
  for (var i = 0; i < frame.length; i++) {
    points.push({
      x: frame.length === 1 ? 0.5 : i / (frame.length - 1),
      y: 1 - frame[i] / FRAME_MAX
    })
  }
  return points
}

// --------------------------------------------------------------- palettes
//
// Two families on purpose: `intensity` and `urgent` move with the sound,
// `spectrum` and `gradient` are fixed to position. One gives colour motion and
// the other keeps the bar visually still, and which you want is taste.

var PALETTES = ["accent", "foreground", "intensity", "spectrum", "gradient", "urgent"]

function isPalette(name) {
  return PALETTES.indexOf(name) >= 0
}

function mix(a, b, t) {
  var k = clamp(t, 0, 1)
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k
  }
}

function paletteColor(palette, index, count, value, ctx) {
  var fraction = value / FRAME_MAX
  var position = count <= 1 ? 0 : index / (count - 1)

  if (palette === "foreground") return ctx.foreground
  if (palette === "intensity") return mix(ctx.foreground, ctx.accent, fraction)

  if (palette === "urgent") {
    var threshold = clamp(Number(ctx.peakThreshold) || 85, 50, 100)
    return value >= threshold ? ctx.urgent : ctx.accent
  }

  if (palette === "spectrum") {
    // Hue swept low to high across the spectrum, saturation and value taken
    // from the theme's accent so it still belongs to the theme.
    var hsv = rgbToHsv(ctx.accent)
    return hsvToRgb((hsv.h + position * 0.8) % 1, hsv.s, hsv.v)
  }

  if (palette === "gradient") {
    // A bad or missing hex falls back to accent rather than rendering nothing.
    var from = ctx.gradientFrom || ctx.accent
    var to = ctx.gradientTo || ctx.accent
    return mix(from, to, position)
  }

  return ctx.accent
}

function rgbToHsv(c) {
  var max = Math.max(c.r, c.g, c.b)
  var min = Math.min(c.r, c.g, c.b)
  var d = max - min
  var h = 0

  if (d !== 0) {
    if (max === c.r) h = ((c.g - c.b) / d) % 6
    else if (max === c.g) h = (c.b - c.r) / d + 2
    else h = (c.r - c.g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }

  return { h: h, s: max === 0 ? 0 : d / max, v: max }
}

function hsvToRgb(h, s, v) {
  var i = Math.floor(h * 6)
  var f = h * 6 - i
  var p = v * (1 - s)
  var q = v * (1 - f * s)
  var t = v * (1 - (1 - f) * s)

  switch (i % 6) {
    case 0: return { r: v, g: t, b: p }
    case 1: return { r: q, g: v, b: p }
    case 2: return { r: p, g: v, b: t }
    case 3: return { r: p, g: q, b: v }
    case 4: return { r: t, g: p, b: v }
    default: return { r: v, g: p, b: q }
  }
}

// Accepts "#rgb", "#rrggbb" and plain hex. Anything else is null, and the
// caller falls back to a theme colour rather than drawing nothing.
function parseHex(text) {
  var hex = String(text || "").trim().replace(/^#/, "")
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null

  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255
  }
}

// ------------------------------------------------------------ WLED bridge
//
// The differentiator, and the part with a real device on the other end.

// Energy of a frame, for brightness. The mean rather than the peak: a peak
// makes the lamp track the kick drum alone, which reads as strobing.
function frameEnergy(frame) {
  if (!frame || frame.length === 0) return 0
  var total = 0
  for (var i = 0; i < frame.length; i++) total += frame[i]
  return total / frame.length / FRAME_MAX
}

// WLED over HTTP cannot take 30 requests a second — the lamp stops answering
// and looks broken, which reads as a hardware fault rather than as this widget.
// Frames above the rate are dropped, never queued: a queue would just move the
// problem to the end of the song.
function shouldSendToWled(lastSentMs, nowMs, rateHz) {
  var rate = clamp(Number(rateHz) || 10, 1, 20)
  return (nowMs - lastSentMs) >= (1000 / rate)
}

function wledBrightness(energy, floor, ceiling) {
  var low = Number(floor) === undefined ? 0 : Number(floor) || 0
  var high = Number(ceiling) || 255
  return Math.round(clamp(low + energy * (high - low), 0, 255))
}

function wledColor(palette, energy, ctx) {
  // The lamp shows the colour the bar is showing, which is the point of the
  // bridge: one thing happening in two places.
  var value = energy * FRAME_MAX
  return paletteColor(palette, 0, 1, value, ctx)
}

function toBytes(color) {
  return [
    Math.round(clamp(color.r, 0, 1) * 255),
    Math.round(clamp(color.g, 0, 1) * 255),
    Math.round(clamp(color.b, 0, 1) * 255)
  ]
}

// The WLED JSON state API. `bri` and one segment colour is all this needs;
// anything richer belongs in WLED's own interface.
function wledPayload(brightness, color) {
  return JSON.stringify({
    on: true,
    bri: brightness,
    seg: [{ col: [toBytes(color)] }]
  })
}

// Leaving a lamp frozen on a colour after the music stops is the worst thing
// this bridge can do, so the restore is explicit and idempotent.
function wledRestorePayload(previous) {
  if (!previous) return JSON.stringify({ on: false })
  return JSON.stringify({
    on: previous.on !== false,
    bri: Number(previous.bri) || 128,
    seg: previous.seg || []
  })
}
