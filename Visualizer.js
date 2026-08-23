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
//
// It must go somewhere only this user can write.
//
// It used to fall back to `/tmp/omarchy-visualizer/cava.conf` whenever
// XDG_RUNTIME_DIR was unset, with no mode on the directory and no check that
// the path was what it claimed to be. `/tmp` is a shared namespace: another
// local user can create that directory first, or leave a symlink where the
// config goes, and a shell that lives for the whole session then writes
// through it into a file of their choosing. `mkdir -p` does not object to a
// directory it did not create, and a plain write follows a symlink.
//
// XDG_RUNTIME_DIR is /run/user/<uid>: 0700 and owned by us. The fallback is
// now ~/.cache, which is likewise not shared. With neither available the
// plugin does not run — it is an ornament, and failing closed costs nothing
// that is worth a foothold.
function configDir(runtimeDir, homeDir) {
  if (runtimeDir) return runtimeDir + "/omarchy-visualizer"
  if (homeDir) return homeDir + "/.cache/omarchy-visualizer"
  return ""
}

function configPath(runtimeDir, homeDir) {
  var dir = configDir(runtimeDir, homeDir)
  return dir ? dir + "/cava.conf" : ""
}

// Create the directory 0700 and refuse anything that is not ours.
//
// The checks are belt and braces on top of choosing a private parent: with a
// 0700 parent nobody else can put a symlink in the way, and the tests below
// pin that the command still looks for one. `-O` is "owned by the effective
// user", which is what rules out a directory someone else made first.
//
// A config that is already there but is a symlink, or is not a plain file, or
// belongs to someone else, is removed rather than written through.
function configDirCommand(dir) {
  return ["sh", "-c",
    'd="$1"; ' +
    'mkdir -m 700 -p -- "$d" || exit 1; ' +
    '[ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] || exit 1; ' +
    'chmod 700 -- "$d" || exit 1; ' +
    'f="$d/cava.conf"; ' +
    'if [ -e "$f" ] || [ -L "$f" ]; then ' +
    '  [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ] || rm -f -- "$f" || exit 1; ' +
    'fi',
    "omarchy-visualizer", dir]
}

// ------------------------------------------------------- file ceilings
//
// The shell outlives every window in it, so anything it reads it keeps. A
// settings file is a few hundred bytes and a WLED config a few thousand;
// past this ceiling the file is either corrupt or someone growing a
// long-lived heap, and neither is worth reading. The probe runs before the
// read rather than after, because after is where the allocation already is.

var MAX_CONFIG_BYTES = 65536

// Enough for more lights than a room holds. The list is scanned to this
// depth, so a device past it is not merely unselected but unseen — which is
// the point of a ceiling.
var MAX_WLED_DEVICES = 32

// Read and ceiling in one act, because they cannot be two.
//
// Stat-then-open is a race: the file that was measured and the file that is
// opened need not be the same one, and a same-user writer only has to grow it
// in between. `head -c` asks for at most `maxBytes + 1` bytes, so whatever
// arrives is bounded by construction — the bytes that arrive ARE the bytes
// that were counted. The extra byte is what distinguishes a file that fitted
// from one that did not; a file that did not is refused rather than
// truncated, because a truncated JSON file is a corrupt one.
//
// `timeout` because `-f` is checked in the same breath but not in the same
// instant: a path that has become a fifo would otherwise hold the read open
// for as long as the shell lives.
function readCappedCommand(path, maxBytes) {
  return ["sh", "-c",
    'f="$1"; c="$2"; ' +
    '[ -f "$f" ] || exit 1; ' +
    'exec timeout 5 head -c "$((c + 1))" -- "$f"',
    "omarchy-visualizer", path, String(maxBytes)]
}

function parseConfigFile(text) {
  if (!text) return null
  if (text.length > MAX_CONFIG_BYTES) return null
  try {
    var parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" ? parsed : null
  } catch (error) {
    return null
  }
}

// The names the user typed, capped the same way the device list is: a
// setting string is not a place to store a million commas.
function wledWantedNames(spec) {
  var wanted = []
  var parts = String(spec || "").split(",")
  for (var p = 0; p < parts.length && wanted.length < MAX_WLED_DEVICES; p++) {
    var name = parts[p].trim()
    if (name) wanted.push(name)
  }
  return wanted
}

function wledHostList(parsed, wanted) {
  var hosts = []
  var devices = (parsed && parsed.devices) || []
  var limit = Math.min(devices.length, MAX_WLED_DEVICES)
  for (var i = 0; i < limit; i++) {
    var device = devices[i] || {}
    var host = device.address || device.host
    if (!host) continue
    if (wanted.length > 0 && wanted.indexOf(device.host) < 0
      && wanted.indexOf(device.name) < 0) continue
    hosts.push(host)
  }
  return hosts
}

// --------------------------------------------------------- audio input
//
// cava reads one device. "What the machine is playing" is the monitor of the
// default sink, which cava's `auto` already picks; a microphone is a source
// like any other. Hearing both at once is not a cava setting at all — it needs
// a device that does not exist yet, and the plugin builds one.

var INPUTS = ["system", "mic", "both"]

function isInput(name) {
  return INPUTS.indexOf(name) >= 0
}

var MIX_SINK = "omarchy_visualizer_mix"

function inputSource(input, micSource) {
  if (input === "mic") return micSource || "auto"
  if (input === "both") return MIX_SINK + ".monitor"
  return "auto"
}

// The virtual device for "both": a sink nothing plays to directly, fed by two
// loopbacks — one from what you hear, one from the microphone. cava then reads
// its monitor and hears the sum.
//
// Built only while it is needed and torn down after, because leaving a stray
// sink in someone's audio graph is the kind of mess that outlives the widget.
// A sink the session manager must not choose. Without the priority it is the
// newest sink on the graph, which is exactly what WirePlumber promotes to
// default — and a default that plays into a null sink is silence with no
// visible cause.
function mixSetupCommands(sinkMonitor, micSource) {
  return [
    ["pactl", "load-module", "module-null-sink",
      "sink_name=" + MIX_SINK,
      "sink_properties=device.description=Visualizer priority.session=0"
        + " device.class=filter"],
    ["pactl", "load-module", "module-loopback",
      "source=" + sinkMonitor, "sink=" + MIX_SINK, "latency_msec=50"],
    ["pactl", "load-module", "module-loopback",
      "source=" + micSource, "sink=" + MIX_SINK, "latency_msec=50"]
  ]
}

// The mix must never be fed from its own monitor. If it ever does become the
// default sink, the monitor of "the default sink" is its own, and a loopback
// from a sink into itself is a feedback loop with a microphone in it.
function isMixMonitor(name) {
  return String(name || "").indexOf(MIX_SINK) === 0
}

// Unloading by module name would take every null sink and every loopback on the
// machine with it, including ones the user set up themselves — and this now runs
// on every device change rather than once. So the modules are found by the sink
// they name in their own arguments, which is exactly this plugin's three and
// nothing else. Tracking ids instead would lose them the moment the shell
// crashes; the arguments survive that, so this also cleans up after one.
function mixTeardownCommand() {
  return ["sh", "-c",
    "pactl list short modules"
    + " | awk '$2 ~ /^module-(null-sink|loopback)$/ && /" + MIX_SINK + "/ { print $1 }'"
    + " | xargs -r -n1 pactl unload-module 2>/dev/null; true"]
}

function defaultSinkCommand() {
  return ["sh", "-c", "pactl get-default-sink 2>/dev/null"]
}

function defaultSourceCommand() {
  return ["sh", "-c", "pactl get-default-source 2>/dev/null"]
}

function cavaConfig(settings) {
  var bars = clamp(Math.round(Number(settings.barCount) || 14), 6, 24)
  var framerate = clamp(Math.round(Number(settings.framerate) || 30), 10, 60)

  var source = inputSource(settings.input, settings.micSource)

  return [
    "[general]",
    "framerate = " + framerate,
    "bars = " + bars,
    // Let cava do its own gain. Doing it here is more code and a worse result.
    "autosens = 1",
    "",
    "[input]",
    "method = pulse",
    // `auto` is cava's own "whatever this machine is playing", which is right
    // for the common case and needs no lookup.
    "source = " + source,
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

// ------------------------------------------------------------ pixel grid
//
// The same trap the docker mosaic fell into. A pitch of width/count is
// fractional, so bars land between device pixels and the renderer resolves some
// at three pixels and others at four — a row of identical bars draws as a row of
// visibly different ones, with every number in the layout correct.
//
// QT_SCALE_FACTOR makes it worse: at 0.85 a whole logical pixel is not a whole
// real one either. Sizes are chosen on the device grid, and the PITCH is the
// thing that has to be whole — that is what makes every bar share one sub-pixel
// phase and rasterise the same way.

function snapToDevice(px, dpr) {
  var ratio = Number(dpr) || 1
  if (ratio <= 0 || ratio === 1) return Math.max(1, Math.round(px))
  return Math.max(1, Math.round(px * ratio)) / ratio
}

function floorToDevice(px, dpr) {
  var ratio = Number(dpr) || 1
  if (ratio <= 0 || ratio === 1) return Math.max(1, Math.floor(px))
  return Math.max(1, Math.floor(px * ratio)) / ratio
}

// Bars of one width at one pitch, and the leftover split as padding rather than
// smeared across the bars. Anything that cannot be divided evenly becomes empty
// space at the edges, where nobody reads it as data.
function barLayout(available, count, wantedWidth, gap, dpr) {
  var bars = Math.max(1, Math.round(Number(count) || 1))
  var space = Math.max(1, Number(available) || 0)
  var minGap = Math.max(0, Number(gap) || 0)

  var pitch = floorToDevice(space / bars, dpr)
  var width = floorToDevice(Math.min(Number(wantedWidth) || pitch, pitch - minGap), dpr)
  if (width < 1 / (Number(dpr) || 1)) width = pitch

  var used = pitch * bars
  return {
    pitch: pitch,
    width: width,
    // Centred, so a mosaic that cannot fill the space is not glued to one side.
    offset: floorToDevice(Math.max(0, (space - used) / 2), dpr)
  }
}

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
  // No private directory means no config, and no config means cava would read
  // whatever it found in the user's own ~/.config/cava instead.
  if (state.configReady === false) return false
  if (!state.visible) return false
  if (state.pauseWhenSilent && !state.playing) return false
  if (state.pauseOnBattery && state.onBattery) return false
  return true
}

// Why it is not running, for the widget to say. "Nothing" is not an error.
function idleReason(state) {
  if (!state.installed) return "missing"
  if (state.configReady === false) return "noConfigDir"
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

// ------------------------------------------------------------- settings
//
// Two sources, and a rule for which wins.
//
// The bar host has no API for a widget to write its own shell.json entry, and a
// plugin editing that file races the shell's own writes when someone drags the
// bar around. So the settings the panel changes live in a file of the plugin's
// own, the way the WLED and camera plugins do it, and shell.json seeds the
// defaults.

// Which language the pane speaks. `auto` follows the session locale and falls
// back to English, which is also what an untranslated key renders as.
var LANGUAGES = ["auto", "en", "pt"]

var DEFAULTS = {
  language: "auto",
  base: "bottom",
  cap: "flat",
  fill: "solid",
  palette: "accent",
  input: "system",
  barCount: 14,
  segments: 8,
  framerate: 30,
  barWidth: 3,
  widgetWidth: 90,
  smoothing: 60,
  floor: 3,
  peakFall: 1.5,
  showPeaks: false,
  showWave: false,
  spread: 1,
  innerRadius: 0.3,
  gradientFrom: "",
  gradientTo: "",
  solidColor: "",
  peakThreshold: 85,
  pauseOnBattery: true,
  pauseWhenSilent: true,
  wledEnabled: false,
  wledStyle: "spectrum",
  wledRateHz: 10,
  wledDevices: "",
  wledRestore: true
}

// Later sources win, and an absent key never overrides a present one — a file
// holding only `base` must not reset everything else to a default.
function mergeSettings() {
  var out = {}
  for (var key in DEFAULTS) out[key] = DEFAULTS[key]

  for (var i = 0; i < arguments.length; i++) {
    var source = arguments[i]
    if (!source) continue
    for (var name in source) {
      if (source[name] === undefined || source[name] === null) continue
      if (source[name] === "" && DEFAULTS[name] !== "") continue
      out[name] = source[name]
    }
  }

  return out
}

// A corrupt or oversized file falls back to the defaults rather than taking
// the widget down with it, or holding what it was fed.
function parseSettingsFile(text) {
  return parseConfigFile(text)
}

function serializeSettings(settings) {
  var out = {}
  for (var key in DEFAULTS) {
    if (settings[key] !== undefined) out[key] = settings[key]
  }
  return JSON.stringify(out, null, 2) + "\n"
}

// The next value on an axis, for a control that cycles rather than opens a
// list: at this size a dropdown costs more than it gives.
function cycle(values, current, direction) {
  var index = values.indexOf(current)
  var step = direction < 0 ? -1 : 1
  if (index < 0) return values[0]
  return values[(index + step + values.length) % values.length]
}

// ---------------------------------------------------------- style axes
//
// Four axes rather than a list of finished styles. Nine named presets would be
// nine things to maintain and would still miss the tenth someone wants; these
// combine, so "bars with round caps and a peak marker" and "a segmented ring"
// are the same three settings arranged differently.

var BASES = ["bottom", "top", "mirror", "radial"]   // where a bar grows from
var CAPS = ["flat", "round", "segments"]            // what its end looks like
var FILLS = [
  "solid",           // one flat colour per bar, from the palette
  "barGradient",     // every bar ramps through the whole palette range
  "screenGradient"   // one ramp anchored to the drawing area: a short bar only
                     // reaches the low end of it
]

function isBase(name) { return BASES.indexOf(name) >= 0 }
function isCap(name) { return CAPS.indexOf(name) >= 0 }
function isFill(name) { return FILLS.indexOf(name) >= 0 }

// Where one bar sits, in the drawing area, for the three linear bases. Radial
// has its own geometry below.
// The base edge is pinned and the far end moves; never the other way round.
//
// Rounding `y` and `height` independently was making the floor of every bar
// wander by a pixel as the value changed — the bars looked like they were
// standing on something loose. Round the LENGTH once, then derive the position
// from it, and the base lands on the same pixel every frame.
function barGeometry(base, value, height, minHeight, dpr) {
  var full = Math.max(0, Number(height) || 0)
  var floor = Math.max(1, Number(minHeight) || 1)
  var raw = Math.max(floor, (value / FRAME_MAX) * full)
  var length = dpr ? floorToDevice(raw, dpr) : Math.round(raw)

  if (base === "top") return { y: 0, height: length }

  if (base === "mirror") {
    // The centre line is the pinned edge here, so the half is what gets
    // rounded and the bar grows symmetrically around a fixed middle.
    var half = dpr ? floorToDevice(Math.max(floor / 2, raw / 2), dpr)
      : Math.round(Math.max(floor / 2, raw / 2))
    var middle = dpr ? floorToDevice(full / 2, dpr) : Math.round(full / 2)
    return { y: middle - half, height: half * 2 }
  }

  return { y: full - length, height: length }
}

// --------------------------------------------------------------- radial

// A bar on a ring: an angle and two radii. Returned as geometry rather than as
// pixels so the same numbers can be tested and the renderer can place it with a
// rotation instead of trigonometry per frame.
//
// `spread` is how much of the circle to use — a full turn is a ring, half is
// the fan from the reference sheet.
function radialBar(index, count, value, options) {
  var settings = options || {}
  // `Number(undefined)` is NaN, never undefined — checking the setting itself
  // is the difference between a ring and a frame of NaN.
  var spread = settings.spread === undefined ? 1 : Number(settings.spread) || 1
  var start = Number(settings.startAngle) || 0
  var inner = Number(settings.innerRadius) || 0.25
  var outer = Number(settings.outerRadius) || 1
  var bars = Math.max(1, Number(count) || 1)

  // The last bar must not land on top of the first when the spread is a full
  // turn, so a closed ring divides by the count and an open fan by count - 1.
  var closed = Math.abs(spread - 1) < 1e-9
  var step = closed ? spread / bars : spread / Math.max(1, bars - 1)

  var length = inner + (value / FRAME_MAX) * (outer - inner)

  return {
    angle: start + index * step,      // turns, not degrees: 0..1
    inner: inner,
    outer: Math.max(inner, length)
  }
}

// ------------------------------------------------------------- peak hold
//
// The marker that rises instantly with a peak and sinks slowly afterwards. It
// is what makes a meter readable at a glance: the bars say what is happening
// now, the markers say what just happened.

function updatePeaks(previous, frame, fallPerFrame) {
  var fall = Math.max(0, Number(fallPerFrame) || 0)
  var out = []

  for (var i = 0; i < frame.length; i++) {
    var was = previous && previous.length === frame.length ? previous[i] : 0
    // A new high is taken immediately; otherwise the old one decays. Decaying
    // towards the bar rather than to zero keeps the marker from sinking below
    // the sound it is marking.
    out.push(frame[i] >= was ? frame[i] : Math.max(frame[i], was - fall))
  }

  return out
}

// --------------------------------------------------------------- palettes
//
// Two families on purpose: `intensity` and `urgent` move with the sound,
// `spectrum` and `gradient` are fixed to position. One gives colour motion and
// the other keeps the bar visually still, and which you want is taste.

var PALETTES = [
  "accent",      // the theme's accent, solid
  "foreground",  // the theme's foreground, solid
  "intensity",   // foreground -> accent with loudness
  "spectrum",    // hue swept across the bands, saturation from the theme
  "rainbow",     // the same sweep at full saturation, ignoring the theme
  "heat",        // cold at rest, hot at the peaks
  "gradient",    // between two colours you pick
  "solid",       // one colour you pick
  "urgent"       // accent, turning urgent above the threshold
]

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

// The two ends of one bar. The fill decides what the tip means:
//
//   barGradient    — the tip is the top of the palette, whatever this bar is
//                    doing. Every bar shows the whole range, normalised to its
//                    own length.
//   screenGradient — the tip is the colour at this bar's actual height, so the
//                    ramp is anchored to the drawing area and a quiet bar only
//                    ever reaches the low end of it.
//
// Those two were the same function once, which is why `fill` looked like it
// had three values and two behaviours.
function barGradientPair(palette, index, count, value, ctx, fill) {
  var reach = fill === "screenGradient" ? value : FRAME_MAX
  var base = paletteColor(palette, index, count, 0, ctx)
  var tip = paletteColor(palette, index, count, reach, ctx)

  // A palette that reads position rather than height — `rainbow`, `spectrum`,
  // a picked `solid` — hands back the same colour at both ends, and a gradient
  // between a colour and itself is a flat bar. Brightness stands in for the
  // height the palette has no opinion about, so the fill still does something
  // visible: otherwise the setting reads as broken in exactly the palettes
  // people pick first.
  if (sameColor(base, tip)) {
    base = dim(tip, FLAT_BASE_DIM)
    // Anchored, again: a quiet bar never reaches full brightness, where under
    // `barGradient` every bar tops out at the palette's own colour.
    if (fill === "screenGradient") {
      tip = dim(tip, FLAT_BASE_DIM
        + (1 - FLAT_BASE_DIM) * clamp(value / FRAME_MAX, 0, 1))
    }
  }

  return { base: base, tip: tip }
}

// How dark the foot of a bar goes when the palette itself has no opinion.
var FLAT_BASE_DIM = 0.32

function sameColor(a, b) {
  return Math.abs(a.r - b.r) < 0.002
    && Math.abs(a.g - b.g) < 0.002
    && Math.abs(a.b - b.b) < 0.002
}

function dim(color, amount) {
  var k = clamp(amount, 0, 1)
  return { r: color.r * k, g: color.g * k, b: color.b * k }
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

  if (palette === "rainbow") {
    // Full saturation on purpose: `spectrum` borrows the theme's restraint,
    // this one is the loud version, and having both is the point.
    return hsvToRgb(position * 0.85, 0.85, 1)
  }

  if (palette === "heat") {
    // Cold where it is quiet, hot where it peaks — the reading is the height
    // and the colour says the same thing twice, which is what makes a meter
    // legible out of the corner of an eye.
    return hsvToRgb((0.62 - fraction * 0.62 + 1) % 1, 0.75, 0.55 + fraction * 0.45)
  }

  if (palette === "solid") {
    return ctx.solidColor || ctx.accent
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

// The other direction from parseHex, for the picker: what the user chose has
// to go back into the settings file as text.
function toHex(color) {
  function channel(v) {
    var byte = Math.round(clamp(Number(v) || 0, 0, 1) * 255)
    var text = byte.toString(16)
    return text.length === 1 ? "0" + text : text
  }
  return "#" + channel(color.r) + channel(color.g) + channel(color.b)
}

// Which settings hold a colour, so the picker and the palettes agree on the
// list rather than each carrying their own copy of it.
var COLOR_KEYS = ["solidColor", "gradientFrom", "gradientTo"]

function isColorKey(key) {
  return COLOR_KEYS.indexOf(key) >= 0
}

// Which colour a palette actually reads, so the picker can offer the ones that
// will change something and say so about the ones that will not.
function colorKeysFor(palette) {
  if (palette === "solid") return ["solidColor"]
  if (palette === "gradient") return ["gradientFrom", "gradientTo"]
  return []
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

// The WLED JSON state API. One colour for the whole strip: the `solid` style,
// and what every style falls back to before the strip has said how long it is.
//
// `frz: false` because the band-by-band payload freezes the segment: falling
// back to solid without lifting that would leave the strip stuck on whichever
// spectrum frame happened to be the last one.
function wledPayload(brightness, color) {
  return JSON.stringify({
    on: true,
    bri: brightness,
    seg: [{ id: 0, frz: false, col: [toBytes(color)] }]
  })
}

// ------------------------------------------------------- the whole strip
//
// A strip is not a lamp. Sending it one colour throws away the only thing it
// can do that a bulb cannot: show the spectrum as a spectrum, low bands at one
// end and high at the other, each one lit by how loud it actually is.

var WLED_STYLES = ["spectrum", "mirror", "solid"]

// Colour never falls all the way to black. A band at rest that goes dark takes
// its stretch of the strip out of the picture entirely, and the strip stops
// reading as a spectrum and starts reading as a fault.
var WLED_FLOOR = 0.1

function wledHex(color) {
  var bytes = toBytes(color)
  var text = ""
  for (var i = 0; i < bytes.length; i++) {
    var part = bytes[i].toString(16)
    text += part.length === 1 ? "0" + part : part
  }
  return text.toUpperCase()
}

// Which band a given LED belongs to, for each style. `spectrum` lays the bands
// along the strip; `mirror` folds them so the low bands meet in the middle,
// which is what a strip behind a desk usually wants — the movement starts at
// the centre and travels out to both ends.
function wledBandAt(led, ledCount, bands, style) {
  var count = Math.max(1, ledCount)
  if (style === "mirror") {
    var half = count / 2
    var distance = led < half ? half - 1 - led : led - half
    return clamp(Math.floor(distance / Math.max(1, half) * bands), 0, bands - 1)
  }
  return clamp(Math.floor(led / count * bands), 0, bands - 1)
}

// WLED's range form: `[start, stop, "RRGGBB", start, stop, "RRGGBB", …]`, stop
// exclusive. Runs rather than one colour per LED because this goes out ten
// times a second over HTTP to a device with a few hundred kilobytes of RAM:
// fourteen triplets is a payload it can read, three hundred hex strings is one
// it drops.
function wledRuns(frame, palette, ctx, ledCount, style) {
  var count = Math.floor(Number(ledCount) || 0)
  var bands = frame ? frame.length : 0
  if (!bands || count < 1) return []

  var runs = []
  var start = 0
  var current = ""

  for (var led = 0; led < count; led++) {
    var band = wledBandAt(led, count, bands, style)
    var value = clamp(Number(frame[band]) || 0, 0, FRAME_MAX)
    var color = paletteColor(palette, band, bands, value, ctx)
    var lit = dim(color, WLED_FLOOR + (1 - WLED_FLOOR) * (value / FRAME_MAX))
    var hex = wledHex(lit)

    if (hex !== current) {
      if (current !== "") runs.push(start, led, current)
      start = led
      current = hex
    }
  }
  if (current !== "") runs.push(start, count, current)
  return runs
}

// `frz: true` is the whole trick, and the reason a first attempt at this drew
// nothing but one colour. WLED's effect engine owns the segment: it repaints
// every LED on its next tick, so individual LEDs written underneath it survive
// for a few milliseconds and are then painted over with the effect's own
// colour. Freezing the segment stops that loop and leaves the LEDs as written.
//
// Not `fx: 0`. Setting the effect to Solid also stops the pattern, but Solid
// is an effect like any other — it fills the segment with the primary colour,
// so it overwrites the spectrum just as surely — and it would quietly replace
// whatever effect the strip was set to, which is not this bridge's to change.
function wledLivePayload(brightness, runs) {
  return JSON.stringify({
    on: true,
    bri: brightness,
    seg: [{ id: 0, frz: true, i: runs }]
  })
}

// The strip has to say how long it is before it can be painted band by band.
// One process for every device, because a light that does not answer must not
// stop the others being asked.
function wledInfoCommand(hosts) {
  return ["sh", "-c",
    'for h in "$@"; do ' +
    '  printf "%s\t" "$h"; ' +
    '  curl -s -m 2 "http://$h/json/info" | tr -d "\r\n"; ' +
    '  printf "\n"; ' +
    'done',
    "omarchy-visualizer"].concat(hosts || [])
}

function parseWledInfo(line) {
  var at = String(line || "").indexOf("\t")
  if (at < 0) return null
  var host = line.slice(0, at)
  var body = line.slice(at + 1)
  if (!host || !body) return null

  var parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    return null
  }

  var count = parsed && parsed.leds ? Number(parsed.leds.count) : 0
  if (!count || count < 1) return null
  return { host: host, count: Math.floor(count) }
}

// Leaving a lamp frozen on a colour after the music stops is the worst thing
// this bridge can do, so the restore is explicit and idempotent.
function wledRestorePayload(previous) {
  // The freeze has to be lifted whatever else happens, or the strip keeps the
  // last frame of the spectrum for as long as it stays on and its own effects
  // never run again.
  if (!previous) return JSON.stringify({ on: false, seg: [{ id: 0, frz: false }] })
  return JSON.stringify({
    on: previous.on !== false,
    bri: Number(previous.bri) || 128,
    seg: previous.seg || []
  })
}

// ------------------------------------------------------------- the rows
//
// The settings pane and the key handler read the same list, so a new axis
// cannot arrive in one and not the other. It lives at the end of the file
// because it names every axis above it.
//
// `accel` is fixed across languages. Moving the keys when someone switches
// language would be the one thing worse than not having them: muscle memory
// outlives a translation table. It is drawn as a coloured letter inside the
// label where the label contains it, and as `label (k)` where it does not —
// which is most of Portuguese, and `fps` in any language.
//
// `key` is also the translation namespace: the label is `row.<key>` and each
// value is `<key>.<value>`.
var SETTING_ROWS = [
  { key: "base", accel: "b", values: BASES },
  { key: "cap", accel: "c", values: CAPS },
  { key: "fill", accel: "f", values: FILLS },
  { key: "palette", accel: "p", values: PALETTES },
  { key: "input", accel: "i", values: INPUTS },
  { key: "showPeaks", accel: "e", values: [false, true] },
  { key: "showWave", accel: "w", values: [false, true] },
  { key: "barCount", accel: "a", values: [8, 12, 14, 16, 20, 24] },
  { key: "smoothing", accel: "l", values: [0, 30, 60, 80, 95] },
  { key: "framerate", accel: "r", values: [15, 30, 45, 60] },
  { key: "language", accel: "g", values: LANGUAGES }
]

// The colour rows open a picker instead of cycling, and there is no letter
// left that is not already an axis, so they take digits in the order the
// palette asks for them.
var COLOR_ACCELS = ["1", "2", "3"]

// The WLED rows are their own list because they are only worth showing when
// there is a light to point them at. A pane offering a bridge to nothing
// teaches people its controls are decoration.
var WLED_ROWS = [
  { key: "wledEnabled", accel: "d", values: [false, true] },
  { key: "wledStyle", accel: "m", values: WLED_STYLES },
  // Filled in from the config: the values are the lights someone actually
  // has, and "" is all of them.
  { key: "wledDevices", accel: "v", values: [""] },
  { key: "wledRateHz", accel: "t", values: [5, 10, 15, 20] },
  { key: "wledRestore", accel: "o", values: [false, true] }
]

// The names in the WLED plugin's config, to the same depth the host list is
// read: a name past the ceiling is not selectable because it was never seen.
function wledDeviceNames(parsed) {
  var names = []
  var devices = (parsed && parsed.devices) || []
  var limit = Math.min(devices.length, MAX_WLED_DEVICES)
  for (var i = 0; i < limit; i++) {
    var device = devices[i] || {}
    var name = device.name || device.host
    if (name && names.indexOf(name) < 0) names.push(name)
  }
  return names
}

function wledRows(names) {
  var rows = []
  for (var i = 0; i < WLED_ROWS.length; i++) {
    var row = WLED_ROWS[i]
    if (row.key !== "wledDevices") { rows.push(row); continue }
    rows.push({ key: row.key, accel: row.accel, values: [""].concat(names || []) })
  }
  return rows
}

// Over the rows on screen rather than every row there is: a letter for a
// setting the pane is not showing must do nothing.
function rowForAccel(accel, rows) {
  var list = rows || SETTING_ROWS
  var wanted = String(accel || "").toLowerCase()
  for (var i = 0; i < list.length; i++) {
    if (list[i].accel === wanted) return list[i]
  }
  return null
}

// The label split around its accelerator, so the pane can paint that one letter
// in the accent colour. A label that does not contain the letter gets it in
// brackets rather than losing it.
function splitAccel(label, accel) {
  var text = String(label === undefined || label === null ? "" : label)
  var letter = String(accel || "")
  if (!letter) return { before: text, letter: "", after: "" }

  var at = text.toLowerCase().indexOf(letter.toLowerCase())
  if (at < 0) return { before: text + " (", letter: letter, after: ")" }

  return {
    before: text.slice(0, at),
    // The label's own casing, not the key's: a capitalised label keeps it.
    letter: text.slice(at, at + letter.length),
    after: text.slice(at + letter.length)
  }
}
