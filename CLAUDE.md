# CLAUDE.md

Working notes for **Visualizer** (`avila.visualizer`), an Omarchy shell plugin.
Read this before changing anything here.

## Development loop

Installed as a symlink:

```
~/.config/omarchy/plugins/avila.visualizer -> ~/orca/omarchy_visualizer
```

**The shell's file watcher does not follow that symlink**, and neither does
`rescanPlugins`. Editing here reloads nothing.

```bash
node test_visualizer.js    # first, always: the logic runs without a shell
omarchy restart shell      # the only reliable way to load edited QML
```

Nothing draws without sound, so testing the rendering needs audio. A pure sine
lights exactly one band and makes the widget look broken; generate something
broadband — a bass pulse, a sustained chord and some hiss — or play music.

`pkill -f pw-play` kills the shell running the command, because the pattern
matches its own command line. Use `pkill -x pw-play`.

Reading the journal for errors: `grep` is rewritten by a hook on this machine
and chokes on some patterns. Filter with python instead.

## Checks

`node test_visualizer.js` — 57 checks, no framework, no audio, no cava, no
network. `.pragma library` is stripped before `eval`; it has to stay in the file.

## Architecture

```
manifest.json    kinds: service + bar-widget
Service.qml      one per session: cava, the guards, the WLED bridge, settings
Panel.qml        one per monitor: the bar widget, and it owns the Stage
Stage.qml        picks the window: a layer-shell card or a real toplevel
StageBody.qml    what either one draws: spectrum, keys, the settings pane
Settings.qml     the overlay itself
Spectrum.qml     the drawing, and nothing else
Visualizer.js    all the logic, and the only part with tests
```

## Things that will bite you

- **`.pragma library` is not optional.** Without it each importing QML file gets
  its own copy of the module, and a setting applied in the service is invisible
  to the panel.

- **Bars must be sized on the DEVICE pixel grid.** A pitch of `width/count` is
  fractional, and identical bars then rasterise at different widths — under
  `QT_SCALE_FACTOR` a whole logical pixel is not a whole real one either.
  `barLayout()` owns this; the PITCH is the number that has to be whole, because
  that is what makes every bar share one sub-pixel phase.

- **`Number(undefined) === undefined` is never true.** It is `NaN`. A default
  written that way turned the whole radial ring into `NaN` angles. Check the
  setting itself.

- **An object declaration is not an expression.**
  `gradient: cond ? null : Gradient { … }` is a syntax error, not a conditional
  gradient. Declare it with an id and reference it.

- **Pin the base edge, derive the far end.** Rounding `y` and `height`
  independently made the floor of every bar wander by a pixel as the value
  changed, and the bars looked like they were standing on something loose.
  `barGeometry` rounds the LENGTH once and derives the position from it; for
  `mirror` the centre line is what gets pinned. The QML must not round again.

- **A Repeater delegate must not reparent its children.** The segmented cap
  needs the full height while a solid bar is only as tall as its value, and
  reconciling those in one delegate meant `parent: bar.parent` — which rebinds
  every child on every frame. At sixteen bars of eight segments that stalls the
  shell outright. Two repeaters, one per case.

- **Device names arrive after the setting changes.** `pactl` answers a moment
  later, and the config had already been written with an empty source, so "mic"
  silently fell back to cava's own default — the system audio. The config is
  rewritten when the name lands, and the name is re-asked every time rather than
  cached, because plugging in a headset changes it.

- **The process is killed, not paused.** A paused cava still holds the audio
  capture open, which is most of what it costs.

- **`~/.config/cava` belongs to the user.** The config goes under
  `XDG_RUNTIME_DIR`. Someone who runs cava in a terminal must not find their
  setup rewritten by a bar widget.

- **The bar host cannot write a widget's shell.json entry**, and a plugin that
  edits that file races the shell whenever the bar is dragged. Settings the
  panel changes live in the plugin's own file; shell.json seeds the defaults.

- **The stage needs an explicit `screen`.** Without it the window opens on
  whichever monitor Quickshell picks first, and the click looks like it did
  nothing.

- **Exclusive focus locks the desktop.** Held for the life of the window, the
  compositor routes every key to it and nothing else on screen can be used.
  The stage primes Exclusive for a moment on open — so `f` and `s` work
  immediately — then settles on OnDemand, which is the dance qs.Ui's
  KeyboardPanel does. The trade is that after clicking another window the keys
  need a click back on the stage; that is the correct half to give up.

- **Windowed, the stage is the size of its own content.** A layer surface
  covering the screen swallows every click even when it is fully transparent,
  so the earlier full-screen scrim made the desktop unusable while the
  visualiser was open. `tile` is a `FloatingWindow` instead, so the
compositor places it and the layer rules do not apply at all.

- **A popup cannot take keyboard focus.** The stage is a `PanelWindow` with
  `WlrKeyboardFocus.Exclusive`; that is what makes `f` and `s` work at all.

- **Escape steps back one layer.** Out of the settings should leave the
  visualiser up, not close everything.

- **The mix device must be torn down.** "Both" loads a null sink and two
  loopbacks; leaving them in someone's audio graph outlives the widget.
  `Component.onDestruction` unloads them, and the teardown is by module name so
  it is safe to run when nothing is loaded.

- **WLED cannot follow the frame rate.** Frames above `wledRateHz` are dropped
  rather than queued — a queue moves the backlog to the end of the song. And the
  lamp is restored when the music stops: leaving it frozen on a colour is the
  worst thing the bridge can do.

- **Brightness is the mean, not the peak.** The peak makes the lamp follow the
  kick drum alone, which reads as strobing.

- **Attack immediate, release eased.** Matching the attack is what makes it look
  connected to the sound; easing the release is what stops it looking like
  noise. Do not "fix" the asymmetry.

- **Drop the first frames.** `autosens` spikes while it calibrates, and without
  the warmup the widget lurches every time it wakes.

- **A floor is not cosmetic.** Room noise keeps the bars trembling at one or two
  forever, and with the bridge on it keeps a lamp flickering all night.

**`anchors.left: cond ? undefined : parent.left` does not clear the anchor.**
Assigning `undefined` to an anchor line from inside a binding leaves whatever
was there — so a pane meant to switch from full-width to a right-hand sidebar
ends up anchored to both edges at once and silently spans the window. It is a
layout bug, not an error: nothing is logged. `StageBody.qml` sets `x`, `y`,
`width` and `height` directly for exactly this reason.

**A `FloatingWindow` and a `PanelWindow` are not two configurations of one
window.** Switching between the stage's two modes destroys one and builds the
other, which is why the open state and the settings state live on `Stage.qml`
rather than inside the body: the body does not survive the switch.
