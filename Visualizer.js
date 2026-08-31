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
// The plugin's own loopbacks are not somebody playing music.
//
// `input: both` loads a null sink and two loopbacks into the graph, and the
// loopbacks are streams on the sink side — which is exactly what `playing`
// looks for. So the plugin created the evidence that convinced it something
// was playing, `pauseWhenSilent` never fired once, and cava ran for the life
// of the session. It could not have fired: the condition became true the
// moment the plugin acted on it.
//
// pipewire names the sink each loopback feeds in `target.object`, which is
// this plugin's own sink and needs nothing added to the module load to see.
function isOwnMixNode(properties, name) {
  var props = properties || {}
  if (String(props["target.object"] || "") === MIX_SINK) return true
  return String(name || "") === MIX_SINK
}

function isPlaying(nodes) {
  var list = nodes || []
  for (var i = 0; i < list.length; i++) {
    var node = list[i]
    // An application playing audio shows up as a stream on the sink side.
    if (!node || !node.isStream || !node.isSink) continue
    if (isOwnMixNode(node.properties, node.name)) continue
    return true
  }
  return false
}

// Silence is not a picture. Nothing in a frame of zeroes differs from the
// frame of zeroes before it, so assigning it changes a property, re-evaluates
// every binding under it and repaints every bar on every monitor to draw the
// same nothing.
//
// This is not the floor's job and does not replace it: the floor decides what
// counts as quiet, this decides that quiet twice running is not news.
function isSilentFrame(frame) {
  var list = frame || []
  for (var i = 0; i < list.length; i++) {
    if ((Number(list[i]) || 0) > 0) return false
  }
  return true
}

function mixTeardownCommand() {
  return ["sh", "-c",
    "pactl list short modules"
    + " | awk '$2 ~ /^module-(null-sink|loopback)$/ && /" + MIX_SINK + "/ { print $1 }'"
    + " | xargs -r -n1 pactl unload-module 2>/dev/null; true"]
}

function defaultSinkCommand() {
  return ["sh", "-c", "pactl get-default-sink 2>/dev/null"]
}

var MAX_SOURCES = 32

// Monitors are left out on purpose: a monitor is what a sink is already
// playing, which is the other half of the mix and not a microphone.
function sourceListCommand() {
  return ["sh", "-c",
    "pactl list short sources 2>/dev/null"
    + " | awk '$2 !~ /[.]monitor$/ { print $2 }'"]
}

function parseSourceList(text) {
  var out = []
  if (!text) return out
  var lines = String(text).split("\n")
  for (var i = 0; i < lines.length && out.length < MAX_SOURCES; i++) {
    var name = lines[i].trim()
    if (name && out.indexOf(name) < 0) out.push(name)
  }
  return out
}

// pactl names carry the whole card in them, and the settings pane has one row
// to say it in. What tells two microphones apart is the short part, so that is
// what is offered and what gets written down.
function sourceLabel(name) {
  var text = String(name || "")
  var parts = text.split("__")
  if (parts.length >= 3) return parts[parts.length - 2]
  return text.split(".")[0] || text
}

function sourceLabels(names) {
  var out = []
  for (var i = 0; i < (names || []).length; i++) {
    var label = sourceLabel(names[i])
    if (label && out.indexOf(label) < 0) out.push(label)
  }
  return out
}

// The full name is found again from the list rather than stored, so a device
// that is gone resolves to nothing and the system default is used instead —
// which is what a microphone that was unplugged should do.
function resolveSource(label, names) {
  if (!label) return ""
  for (var i = 0; i < (names || []).length; i++) {
    if (sourceLabel(names[i]) === label) return names[i]
  }
  return ""
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
  micDevice: "",
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
  wledRestore: true,
  wledSpan: 40,
  wledKnob: "",
  wledFlip: ""
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

// ------------------------------------------------------------- segments
//
// The segmented cap draws a column of fixed blocks rather than one bar, so it
// cannot use `barGeometry` — nothing about it varies with the value except how
// many blocks are lit. It still has to obey `base`, which it did not: the
// blocks were always counted up from the floor, so `top` and `mirror` looked
// like settings that did nothing at all while every other cap honoured them.
//
// `mirror` needs twice the blocks — one column each side of the centre line —
// so the count is asked for separately rather than assumed to be `segments`.

function segmentCount(base, segments) {
  var count = Math.max(1, Math.floor(Number(segments) || 1))
  return base === "mirror" ? count * 2 : count
}

// How tall the drawing area is for ONE column of blocks. Mirror splits the
// height between two, so its blocks are half as tall and the pair of them
// still fills the widget.
function segmentSpan(base, height) {
  var full = Math.max(0, Number(height) || 0)
  return base === "mirror" ? full / 2 : full
}

// Where block `index` sits, and which step of the meter it is — the two are
// the same number everywhere except `mirror`, where the second half counts
// from the centre again going the other way.
//
// The pinned edge is the base edge, as everywhere else here: `bottom` grows
// off the floor, `top` off the ceiling, `mirror` off the middle. Deriving the
// position from the step rather than stacking is what keeps a block on the
// same pixel whatever its neighbours do.
function segmentGeometry(base, index, segments, unit, gap, height) {
  var per = Math.max(1, Math.floor(Number(segments) || 1))
  var step = base === "mirror" ? index % per : index
  var offset = step * (unit + gap)

  if (base === "top") return { y: offset, step: step }

  if (base === "mirror") {
    var middle = Math.max(0, Number(height) || 0) / 2
    return index < per
      ? { y: middle - unit - offset, step: step }
      : { y: middle + offset, step: step }
  }

  return { y: Math.max(0, Number(height) || 0) - unit - offset, step: step }
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
  // fx and pal go with the colour or the colour is decoration: an unfrozen
  // segment still running its own effect repaints every LED on the next tick,
  // and any palette but Default ignores col[0] outright. The live payload can
  // leave both alone because it freezes the segment; this one cannot.
  return JSON.stringify({
    on: true,
    bri: brightness,
    seg: [{ id: 0, frz: false, fx: 0, pal: 0, col: [toBytes(color)] }]
  })
}

// ------------------------------------------------------- the whole strip
//
// A strip is not a lamp. Sending it one colour throws away the only thing it
// can do that a bulb cannot: show the spectrum as a spectrum, low bands at one
// end and high at the other, each one lit by how loud it actually is.

var WLED_STYLES = ["spectrum", "mirror", "solid", "params", "bars"]

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

// The strip used to be painted here too, with run-length `seg.i` indices under
// a frozen segment. It is streamed like the panel now: one paint path, and no
// freeze to lift afterwards. A frozen segment that is never unfrozen keeps the
// last frame of the music for as long as the light stays on, which is what a
// session that died without running its teardown left behind more than once.


// The strip has to say how long it is before it can be painted band by band.
// One process for every device, because a light that does not answer must not
// stop the others being asked.
// One probe, one line per host, and the hosts arrive as arguments rather than
// spliced into the script: a device name comes out of someone else's config
// file and is not this plugin's to trust.
//
// Retried, because the board truncates. Asked for `/json/fxdata` twelve times
// this light returned 9205 bytes ten times and 5514 twice — the same answer,
// cut off mid-array. Half a JSON document does not parse, and the effect's
// slider layout is asked for once per effect change, so one short answer left
// `params` with no knobs and nothing to say about it until the effect changed
// again. `/json/si` is a quarter of the size and never came back short.
//
// The last character is the test: a complete document ends with its own
// closer, and a truncated one does not. It is not a validator and does not
// need to be — the parse is still the thing that decides, this only stops the
// probe from settling for an answer that visibly did not finish.
var WLED_PROBE_TRIES = 4

function wledProbeCommand(hosts, path, closer) {
  return ["sh", "-c",
    'for h in "$@"; do ' +
    '  i=0; body=""; ' +
    '  while [ $i -lt ' + WLED_PROBE_TRIES + ' ]; do ' +
    '    body=$(curl -s -m 3 "http://$h' + path + '" | tr -d "\r\n"); ' +
    '    case "$body" in *"' + closer + '") break ;; esac; ' +
    '    i=$((i+1)); ' +
    '  done; ' +
    '  printf "%s\t%s\n" "$h" "$body"; ' +
    'done',
    "omarchy-visualizer"].concat(hosts || [])
}

// /json/si is state and info in one request, around 2KB. It carries both
// things the bridge needs — how long the strip is, and what segment 0 is
// currently set to — where /json/info carried only the first.
function wledInfoCommand(hosts) { return wledProbeCommand(hosts, "/json/si", "}") }

// The slider layout of every effect the firmware has, which depends on the
// firmware and the board. Asked once per host and only for `params`: it is
// around 15KB, where every other probe here is measured in hundreds of bytes.
function wledFxDataCommand(hosts) { return wledProbeCommand(hosts, "/json/fxdata", "]") }

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

  var info = parsed && parsed.info ? parsed.info : null
  var count = info && info.leds ? Number(info.leds.count) : 0
  if (!count || count < 1) return null

  var segments = parsed.state && parsed.state.seg ? parsed.state.seg : []
  var seg = segments.length > 0 ? segments[0] : null
  var shape = wledSegmentShape(seg, info, count)
  if (!shape) return null

  var fx = seg ? Number(seg.fx) : NaN
  return {
    host: host,
    // What gets painted, and how far a realtime frame is allowed to reach.
    //
    // On a STRIP they differ: the segment may be a slice of a longer run, and
    // every LED outside it still has to be written or it freezes holding
    // whatever an effect last left there.
    //
    // On a MATRIX they are the same, and that is not a shortcut. WLED maps a
    // realtime index row-major over the panel, so an index past width x height
    // belongs nowhere — writing there is what turned the picture blue and
    // stuck. The other outputs on that controller drive 576 LEDs that DNRGB
    // simply cannot reach; they are not in a segment either, so nothing else
    // lights them.
    count: shape.width * shape.height,
    total: shape.height > 1
      ? shape.width * shape.height : Math.floor(count),
    width: shape.width,
    height: shape.height,
    matrix: shape.height > 1,
    fx: isFinite(fx) ? Math.floor(fx) : -1,
    seg: seg || {},
    baseline: wledBaseline(parsed.state)
  }
}

// A strip is not a matrix, and the difference is not cosmetic: the pixel a
// paint index lands on is derived from it.
//
// Segment 0 is what every style here writes to, and the segment bounds the
// paint — `i` indices are relative to it and WLED drops the ones past its end.
// On a strip that bound is `stop - start`. On a matrix `stop`/`start` are the
// COLUMNS and `stopY`/`startY` the rows, so the same subtraction gives the
// width and nothing else: a 32x24 panel reported 32, and every band but the
// first fell off the end. `info.leds.count` is no better — that light counts
// 1344 LEDs behind a 768-pixel panel.
function wledSegmentShape(seg, info, count) {
  var matrix = info && info.leds ? info.leds.matrix : null
  var width = seg ? Number(seg.stop) - Number(seg.start) : NaN
  if (!isFinite(width) || width < 1) width = count

  var height = 1
  if (matrix && Number(matrix.h) > 1) {
    var rows = seg ? Number(seg.stopY) - Number(seg.startY) : NaN
    height = isFinite(rows) && rows >= 1 ? rows : Math.floor(Number(matrix.h))
    width = Math.min(width, Math.floor(Number(matrix.w)) || width)
  } else {
    // No panel behind it, so the strip is the only other ceiling there is.
    width = Math.min(width, count)
  }
  if (width < 1 || height < 1) return null
  return { width: Math.floor(width), height: Math.floor(height) }
}

// The whole effect table comes back; only the entry for the effect that host
// is actually running is kept. Holding 220 strings per light so the bridge can
// read one of them is not a cache, it is a leak with a lookup on it.
function parseWledFxData(line, effectByHost) {
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
  if (!Array.isArray(parsed)) return null

  var fx = Number((effectByHost || {})[host])
  if (!isFinite(fx) || fx < 0 || fx >= parsed.length) return null
  return { host: host, meta: String(parsed[fx]) }
}

// Leaving a lamp frozen on a colour after the music stops is the worst thing
// this bridge can do, so the restore is explicit and idempotent.
// ------------------------------------------------------------------ params
//
// The other styles take the strip away from the light and paint it. This one
// leaves the light's own effect running and moves its knobs instead, which is
// the only style that keeps whatever the strip was already good at.
//
// WLED describes each effect's sliders in `/json/fxdata`: one string per
// effect whose first field is a comma-separated list of labels, positionally
// mapped onto these five keys. An empty label — or "!" — means the effect does
// not use that slider at all.
var WLED_SLIDERS = [
  { key: "sx", max: 255 },
  { key: "ix", max: 255 },
  { key: "c1", max: 255 },
  { key: "c2", max: 255 },
  { key: "c3", max: 31 }
]

// Which kinds of knob do not take modulation. Not a list of effects — there
// are 220 of those and their slider labels barely repeat — but the few label
// families that repeat across all of them:
//
//   blur/fade/trail  decay knobs. Jittering them reads as flicker, not motion.
//   speed            the effect owns its own clock; fighting it looks broken.
//   bin/sensitivity  an audio-reactive effect's own listening controls, which
//                    this bridge would be fighting for the same signal.
//   colour           the palette's job, and the palette is a setting here.
//   select/id/font   a slider that picks rather than scales: it jumps.
var WLED_BLOCKED_KNOBS = [
  "blur", "fade", "trail", "decay", "smooth", "speed",
  "bin", "sensitivity", "volume", "sound effect", "pre-amp",
  "color", "colour", "hue", "saturation", "palette",
  "font", "rotate", "flip", "id", "select"
]

function wledKnobModulatable(label) {
  var low = String(label || "").toLowerCase()
  for (var i = 0; i < WLED_BLOCKED_KNOBS.length; i++) {
    if (low.indexOf(WLED_BLOCKED_KNOBS[i]) >= 0) return false
  }
  return true
}

// The sliders one effect declares, with the value the light already had on
// each. `meta` is that effect's entry in /json/fxdata; `seg` is segment 0 as
// /json/si reported it.
function wledDeclaredKnobs(meta, seg) {
  var labels = String(meta || "").split(";")[0].split(",")
  var source = seg || {}
  var out = []
  for (var i = 0; i < WLED_SLIDERS.length; i++) {
    var label = String(labels[i] === undefined ? "" : labels[i]).replace(/^\s+|\s+$/g, "")
    if (!label || label === "!") continue
    var slider = WLED_SLIDERS[i]
    var base = Number(source[slider.key])
    out.push({
      key: slider.key,
      max: slider.max,
      label: label,
      base: clamp(isFinite(base) ? Math.round(base) : Math.round(slider.max / 2), 0, slider.max)
    })
  }
  return out
}

// Empty is a real answer, not a failure: an effect whose only knobs are Fade
// rate and Blur has nothing the audio can move without making it look broken,
// and roughly a third of WLED's effects are exactly that. The caller falls
// back to the one-colour payload rather than driving them anyway.
function wledPickKnobs(knobs) {
  var out = []
  for (var i = 0; i < (knobs || []).length; i++) {
    if (wledKnobModulatable(knobs[i].label)) out.push(knobs[i])
  }
  return out
}

// What the spectrum actually drives: the one knob that was asked for, or the
// blocklist's guess when nothing was.
//
// Named by LABEL rather than by key, because the label is the only part of a
// slider that means anything — `c1` is "Flame Height" on PS Fire, "Low bin" on
// Freqwave and "Arms" on PS Vortex. It is also what the light itself calls it,
// so the pane can offer the same words the WLED app does.
//
// A label that no longer exists is not an error: the effect on the light was
// changed and this one has different knobs. Falling back to the guess beats
// driving nothing and beats guessing which of the new ones was meant.
function wledDriveKnobs(declared, wanted) {
  var name = String(wanted || "")
  if (name) {
    for (var i = 0; i < (declared || []).length; i++) {
      if (declared[i].label === name) return [declared[i]]
    }
  }
  return wledPickKnobs(declared)
}

function wledKnobLabels(declared) {
  var out = []
  for (var i = 0; i < (declared || []).length; i++) out.push(declared[i].label)
  return out
}

// Offered only when a light has said what its effect has. Before that answer —
// and on an effect with no sliders at all — there is nothing to choose between,
// and a row of one option teaches people the control is decoration.
function wledKnobRows(labels) {
  if (!labels || labels.length === 0) return []
  return [{ key: "wledKnob", accel: "k", values: [""].concat(labels) }]
}

// Each knob gets its own slice of the spectrum, low bands first, so the knobs
// move independently. One number driving all of them is what the brightness
// already does, and it makes the whole effect pulse in phase.
function wledKnobLevel(frame, index, count) {
  var bands = (frame || []).length
  if (!bands || count < 1) return 0
  var from = Math.floor(index * bands / count)
  var to = Math.max(from + 1, Math.floor((index + 1) * bands / count))
  var total = 0
  for (var i = from; i < to && i < bands; i++) {
    total += clamp(Number(frame[i]) || 0, 0, FRAME_MAX)
  }
  return clamp(total / (to - from) / FRAME_MAX, 0, 1)
}

// Around the value the light already had rather than across the whole range:
// silence has to give back exactly what the user tuned, or the bridge is not
// modulating the effect so much as replacing it. Bipolar for the same reason —
// a knob that only ever rises has its floor at the user's setting and spends
// the quiet half of the song pinned there.
function wledParamsPayload(knobs, frame, span) {
  var seg = { id: 0 }
  var reach = clamp(Number(span), 0, 1)
  for (var i = 0; i < knobs.length; i++) {
    var knob = knobs[i]
    var swing = (wledKnobLevel(frame, i, knobs.length) * 2 - 1) * reach * knob.max
    seg[knob.key] = Math.round(clamp(knob.base + swing, 0, knob.max))
  }
  // No frz, no fx, no col: the effect is the point of this style, and the
  // segment has to keep running for the knobs to mean anything.
  return JSON.stringify({ on: true, seg: [seg] })
}

// -------------------------------------------------------------------- bars
//
// The one picture a panel can draw that a strip cannot: a column per band,
// lit from the floor to however loud that band is. A strip has to spend its
// whole length on the spectrum's width and has nothing left for its height.
//
// It goes out over DNRGB rather than the JSON API. Measured on a 32x24 panel,
// the same frame as `seg.i` is around 4KB of JSON that the light answers in
// 150ms — six frames a second, for something whose whole job is to keep up
// with music. It is also what makes the restore disappear: a realtime packet
// carries a timeout, so when the frames stop the light goes back to its own
// effect without being told.

// Whether a light can be streamed at all.
//
// A strip always can: DNRGB indexes LEDs in order, so the segment's own start
// is just the index the frame is written at. A panel can only from the origin
// — which LED a panel pixel lands on is the light's own ledmap, unknowable
// from here, and a segment starting anywhere else would be painted through a
// mapping this plugin invented, which is a picture of nothing.
function wledCanStream(shape, seg) {
  if (!shape) return false
  var start = Math.max(0, Math.floor(Number((seg || {}).start) || 0))
  if (!shape.matrix) return true
  var startY = Number((seg || {}).startY) || 0
  return start === 0 && startY === 0
}

// Where in the strip the painted region begins. Zero for a panel, which is the
// only place it is allowed to be.
function wledStreamStart(shape, seg) {
  if (!shape || shape.matrix) return 0
  return Math.max(0, Math.floor(Number((seg || {}).start) || 0))
}

// A realtime frame is the whole strip, not the part of it worth looking at.
//
// A DNRGB packet overrides the controller's own output, and every LED it does
// not carry keeps whatever was in the buffer — frozen, because effects do not
// run while realtime is on. That light drives 1344 LEDs across three outputs
// and only 768 of them are the panel, so the other 576 sat holding the last
// colour an effect left on them for as long as the music played, and no amount
// of turning the light off touched them.
//
// ponytail: this costs a packet. 1344 pixels is three where 768 was two, which
// is 16 frames a second instead of 25 inside the budget. Sending the blanking
// only on the first frame of a realtime session would buy that back, and would
// lose it for the whole session to one dropped packet. Not worth it.
function wledStreamFrame(hex, start, total) {
  var painted = String(hex || "")
  if (!painted) return ""
  var pixels = painted.length / 6
  var strip = Math.max(pixels, Math.floor(Number(total) || 0))
  var before = clamp(Math.floor(Number(start) || 0), 0, strip - pixels)
  var after = strip - before - pixels

  var out = ""
  for (var i = 0; i < before; i++) out += "000000"
  out += painted
  for (var j = 0; j < after; j++) out += "000000"
  return out
}

// Row-major, y=0 at the top, which is how WLED indexes a panel and therefore
// which pixel each byte lands on. The bars grow from the bottom, so the row a
// pixel is in is counted from the far end.
// The three styles a panel can draw, and the only difference between them is
// what a column does with its band's value:
//
//   bars       height. The one picture a strip cannot draw at all.
//   spectrum   brightness, over the full height — the strip's own style, with
//              the bands running along the width instead of along the wire.
//   mirror     the same, folded, so the low bands meet in the middle.
//
// `spectrum` and `mirror` used to go out as run-length indices over all 768
// pixels, which is a line that snakes across the rows: the bands did not line
// up with the columns and nothing lined up with the height. They were on the
// JSON path too, so they moved at `wledRateHz`. Both were the same mistake —
// treating a rectangle as a long strip.
var WLED_PANEL_STYLES = ["bars", "spectrum", "mirror"]

function isWledPanelStyle(style) {
  return WLED_PANEL_STYLES.indexOf(String(style || "")) >= 0
}

// Which way up the panel is.
//
// The wiring decides, not the plugin: WLED's own matrix config on one panel
// here has three sub-panels with `b` (bottom-start) and `r` (right-start) set
// on two of the three, and a realtime frame goes in by index without passing
// through any of that. So the picture arrives however the wire runs, and the
// only honest answer is a knob.
var WLED_FLIPS = ["", "v", "h", "vh"]

function wledFlipIndex(x, y, cols, rows, flip) {
  var mode = String(flip || "")
  return {
    x: mode.indexOf("h") >= 0 ? cols - 1 - x : x,
    y: mode.indexOf("v") >= 0 ? rows - 1 - y : y
  }
}

function wledPanelFrame(frame, palette, ctx, width, height, fill, style, flip) {
  var bands = (frame || []).length
  var cols = Math.floor(width) || 0
  var rows = Math.floor(height) || 0
  if (!bands || cols < 1 || rows < 1) return ""

  // The same two ends the screen paints each bar between, run up the column
  // instead of up the bar. A panel bar has a height, so it can show the whole
  // gradient rather than one colour off it — which is the point: the strip is
  // meant to be the picture on screen, in the room.
  //
  // Per column rather than per pixel: every pixel in a column shares one band,
  // one pair and one height, and working those out once each is the difference
  // between 32 palette lookups a frame and 768.
  // A strip is one row: there is no second direction to put a height in, so
  // `bars` is `spectrum` there rather than a row of blocks that are either on
  // or off. On a panel the height is the whole point.
  var standing = style === "bars" && rows > 1


  var tops = []
  var pairs = []
  var flats = []
  for (var x = 0; x < cols; x++) {
    // The same fold the strip uses, over the width instead of over the wire:
    // one band per column, and `mirror` puts the low bands in the middle.
    var band = wledBandAt(x, cols, bands, style === "mirror" ? "mirror" : "spectrum")
    var value = clamp(Number(frame[band]) || 0, 0, FRAME_MAX)

    // A full column carries its value in brightness, so it is lit whenever the
    // strip version would be — down to the floor, never to black, or a quiet
    // band takes its stretch of the panel out of the picture entirely.
    tops.push(standing ? Math.round(value / FRAME_MAX * rows) : rows)

    if (standing) {
      // Exactly the branch Spectrum.qml takes: `solid` is one colour up the
      // whole bar, and only the gradient fills get two ends. Taking the pair
      // in both cases would give `solid` a gradient the screen never draws,
      // which is the same mismatch this is here to remove.
      pairs.push(fill === "solid"
        ? null : barGradientPair(palette, band, bands, value, ctx, fill))
      flats.push(wledHex(paletteColor(palette, band, bands, value, ctx)))
      continue
    }

    pairs.push(null)
    flats.push(wledHex(dim(paletteColor(palette, band, bands, value, ctx),
      WLED_FLOOR + (1 - WLED_FLOOR) * (value / FRAME_MAX))))
  }

  var out = ""
  for (var y = 0; y < rows; y++) {
    for (var x = 0; x < cols; x++) {
      // The flip is applied to the pixel being asked about, not to the
      // picture afterwards: the frame still goes out row-major, and the only
      // thing that changes is which part of the drawing lands where.
      var at = wledFlipIndex(x, y, cols, rows, flip)
      var col = at.x
      var fromBottom = rows - 1 - at.y

      var top = tops[col]
      if (top <= fromBottom) { out += "000000"; continue }
      var pair = pairs[col]
      if (!pair) { out += flats[col]; continue }
      // The tip is the top of THIS bar, not the top of the panel: a quiet band
      // that only reaches two pixels still shows both ends of its gradient,
      // the same way a short bar on screen does.
      out += wledHex(top < 2 ? pair.tip : mix(pair.base, pair.tip, fromBottom / (top - 1)))
    }
  }
  return out
}

// What the bridge is allowed to send is measured in PACKETS a second, not
// frames a second, and the budget is the board's, not the picture's.
//
// DNRGB carries 489 pixels, so a 768-pixel panel is two packets per frame and
// a strip of fifty is one. Sweeping one panel from 10 to 40 frames a second
// and watching how long it took to answer an unrelated HTTP request:
//
//     10 fps   20 packets/s    103 ms
//     15 fps   30 packets/s     73 ms
//     20 fps   40 packets/s     66 ms
//     25 fps   50 packets/s     68 ms
//     30 fps   60 packets/s    199 ms
//     40 fps   80 packets/s   1663 ms, and a quarter of them never answered
//
// Flat to 50 and then a cliff. Past it the board is behind on its receive
// queue, and what it drops is what arrived last — the second packet of each
// frame, which on a bar chart is the half the bars stand on. That is what "the
// panel is a second behind" was.
//
// `info.leds.fps` looks like the number to use and is not: it reports 30 under
// one effect and 70 under another, and under realtime it just echoes whatever
// it is being fed, so pacing on it is a loop measuring itself.
//
// ponytail: one budget for every board. An ESP8266 is slower than an ESP32 and
// would want its own; the upgrade is to find the knee per host by watching how
// long that light takes to answer, which is what the table above did by hand.
// Measured two ways, and they disagreed. Sweeping the rate and watching how
// long an unrelated HTTP request took said flat to fifty packets a second and
// a cliff past it — but that measures how loaded the board is, not whether it
// is consuming what arrives. Under realtime the same board reports rendering
// 37 frames a second, and packets past that pile up in its receive queue: what
// it drops is what arrived last, which on a bar chart is the half the bars
// stand on. They freeze while the mostly-dark top keeps moving.
//
// So the budget is not the load ceiling. Sweeping the rate again and measuring
// what the light DROPS — pinging it while streaming — put the wall lower still
// and made it sharp:
//
//      4 fps    8 packets/s     6% lost
//      8 fps   16 packets/s     0%
//     12 fps   24 packets/s     0%
//     15 fps   30 packets/s    44% lost, and 3.9s round trips
//
// A frame is two packets there, and losing one of a pair freezes half the
// picture rather than skipping a frame — on a bar chart, the half the bars
// stand on. That is what "it keeps freezing" was, and it is a link, not a
// program: that light answers a ping in 700ms to 1.6s with nothing running,
// where the three strips beside it answer normally.
//
// `wledRateHz` caps the stream as well, which is what that setting already
// says it does and is the knob for a light on a worse link than this one.
var WLED_PACKET_BUDGET = 24
var WLED_PACKET_PIXELS = 489

function wledStreamPackets(pixels) {
  return Math.max(1, Math.ceil((Number(pixels) || 0) / WLED_PACKET_PIXELS))
}

function wledStreamFps(pixels, rateHz) {
  var budget = WLED_PACKET_BUDGET / wledStreamPackets(pixels)
  var asked = Number(rateHz)
  return asked > 0 ? Math.min(budget, asked) : budget
}

function wledStreamDue(lastSentMs, nowMs, pixels, rateHz) {
  return (nowMs - lastSentMs) >= (1000 / wledStreamFps(pixels, rateHz))
}

// How long a dark picture keeps being sent before the light is let go.
//
// A realtime packet holds the light in realtime for as long as they keep
// coming, so the alternative — stop sending the moment the picture goes dark —
// hands the light back within the packet timeout, which is two seconds. Music
// has quiet passages shorter than that, and the light spent them flipping into
// its own effect and back out again. Fifteen seconds of nothing is a song that
// ended; two is a bar rest.
var WLED_STREAM_HOLD_MS = 15000

function wledFrameIsDark(hex) {
  var text = String(hex || "")
  for (var i = 0; i < text.length; i++) {
    if (text[i] !== "0") return false
  }
  return true
}

// One line per frame, and the host travels as data on that line rather than
// in the command: it comes out of another plugin's config file and is not
// this one's to trust.
function wledStreamLine(host, hex) {
  return String(host) + "\t" + String(hex) + "\n"
}

// What `params` sends when the effect on the light has no knob worth driving.
// It must not be the one-colour payload: that carries fx 0 and would replace
// the effect it was asked to leave running, which turns "this effect has
// nothing to modulate" into "this effect is gone".
function wledBrightnessPayload(brightness) {
  return JSON.stringify({ on: true, bri: brightness })
}

// What has to be put back before the bridge writes over it. Every style here
// takes something: `solid` overwrites the effect and the palette, `spectrum`
// and `mirror` freeze the segment and paint it, `params` moves the sliders.
// None of that is the plugin's to keep. A visualiser that leaves the strip on
// Solid white after a song has not borrowed the light, it has taken it.
var WLED_RESTORED = ["fx", "pal", "sx", "ix", "c1", "c2", "c3", "o1", "o2", "o3"]

function wledBaseline(state) {
  var segments = (state && state.seg) || []
  if (segments.length === 0) return null
  var seg = segments[0] || {}
  var out = { id: 0, frz: false }
  for (var i = 0; i < WLED_RESTORED.length; i++) {
    var key = WLED_RESTORED[i]
    if (seg[key] !== undefined) out[key] = seg[key]
  }
  if (Array.isArray(seg.col)) out.col = seg.col
  return { on: state.on !== false, bri: Number(state.bri), seg: out }
}

// The freeze has to be lifted whatever else happens, or the strip keeps the
// last frame of the spectrum for as long as it stays on and its own effects
// never run again. Beyond that: what was recorded, or — with nothing recorded
// — off, which is the only honest answer when the plugin never learned what
// the light was doing before it started.
function wledRestorePayload(previous) {
  if (!previous || !previous.seg) {
    return JSON.stringify({ on: false, seg: [{ id: 0, frz: false }] })
  }
  var out = { on: previous.on !== false, seg: [previous.seg] }
  if (isFinite(previous.bri) && previous.bri > 0) out.bri = Math.round(previous.bri)
  return JSON.stringify(out)
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
  // How far `params` may swing a knob from where the light already had it,
  // as a percentage of that knob's own range. Only that style reads it, but
  // it stays on screen either way: a row that comes and goes with a sibling
  // setting is a row nobody can find twice.
  { key: "wledSpan", accel: "x", values: [20, 40, 60, 80] },
  // Which way up a panel is. The wiring decides and a realtime frame goes in
  // by index without passing through WLED's matrix config, so this is a knob
  // rather than something to work out.
  { key: "wledFlip", accel: "y", values: WLED_FLIPS },
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
// Offered only when there is more than the system default to choose from.
function micRows(names) {
  return [{ key: "micDevice", accel: "n", values: [""].concat(sourceLabels(names)) }]
}

var MIC_ROWS = micRows([])

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
