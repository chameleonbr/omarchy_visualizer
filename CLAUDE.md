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
Stage.qml        the toplevel window and its lifetime
StageBody.qml    what it draws: spectrum, keys, the settings pane
I18n.js          every string the plugin says, en + pt
Settings.qml     the overlay itself
Spectrum.qml     the drawing, and nothing else
Visualizer.js    all the logic, and the only part with tests
```

## Things that will bite you

- **`SETTING_ROWS` is not the whole list any more.** The WLED rows live in
  `WLED_ROWS` and only join the pane when `wled.json` names a light, so a
  letter has to be resolved against the rows *on screen* — `Settings.cycleAccel`
  — rather than against every row that exists. Resolving against the full list
  would flip a setting nobody can see. Any new accelerator has to be unique
  across both lists; the check covers the concatenation.

- **A ceiling you check separately is not a ceiling.** Stat-then-open is a
  race: the file that was measured and the file that gets opened need not be
  the same one, and a same-user writer only has to grow it in between. The read
  itself has to be the limit — `head -c maxBytes + 1` through a `Process`, with
  the extra byte as the proof it did not fit. `FileView` has no size ceiling of
  its own and is kept only for `watchChanges` and `setText`; nothing reads
  through it, which is why `preload` stays off and `reload()` is never called.
  Clearing the `path` for a refused file would be worse than useless: the
  watcher needs it, and without it a file that grew could never be seen to
  shrink.

- **`SETTING_ROWS` is not the whole list any more.** The WLED rows live in
  `WLED_ROWS` and only join the pane when `wled.json` names a light, so a
  letter has to be resolved against the rows *on screen* — `Settings.cycleAccel`
  — rather than against every row that exists. Resolving against the full list
  would flip a setting nobody can see. Any new accelerator has to be unique
  across both lists; the check covers the concatenation.

- **`FileView` reads on demand, and that is the only gate there is.** There is
  no size ceiling on the type, so `SizedFile` keeps `preload` off until a
  `stat` probe has passed and only then opens it — the flag *is* the gate. Two
  consequences: `reload()` on a `FileView` whose `preload` is false invalidates
  without reading, so `onLoaded` never fires and the settings silently stay at
  their defaults; and `watchChanges` needs the `path` set to notice anything,
  so a refused file must keep its path rather than have it cleared, or trimming
  the file back would never be seen.

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

**The stage is a `FloatingWindow`, not a layer surface.** It was a
`PanelWindow` once; that is why it used to hover over every other window and
could never be anything but a card in the middle of an output. Placement,
tiling and floating belong to the compositor and the user's window rules — the
plugin only sets a title and an implicit size. The open and settings state
live on `Stage.qml` rather than inside `StageBody.qml`, because the body dies
with its window.

**`I18n.t()` is a function call, so a binding that calls it has no dependency
on the language.** Every file that renders a string reads `service.languageEpoch`
first, inside a `tr()` helper. Without that read the language setting appears
to do nothing while every piece works when tested alone.

**`Vis.SETTING_ROWS` is the one list.** The pane renders from it and
`StageBody.qml`'s key handler looks accelerators up in it, so an axis cannot
arrive in one and not the other. The checks assert every row is a real setting
whose default is inside its own value list, and that no two rows — or the
colour digits, or `s` — claim the same key.

**A QML color stringifies to `#aarrggbb`, and rich text ignores it.** The
accelerator letter is painted with `<font color=...>`, so it goes through
`Vis.toHex` first. With the raw colour the letter comes out the same grey as
the label and the whole feature looks like it was never wired up — no warning,
no error.

**A focused `TextField` swallows every accelerator.** The colour picker's hex
field is `focus: false` and takes the keyboard only on a click; escape inside
it hands focus back through `dismissed()`. Opening a picker with a digit
leaves focus on the body deliberately — the next letter is still a setting.

**`barGradientPair` has to be told which fill asked for it.** It was not, once,
which is why `fill` had three values and two behaviours — `barGradient` and
`screenGradient` rendered the same picture, and under a position palette like
`rainbow` neither rendered a gradient at all. The checks now assert that the
two tips differ for every palette, that a `barGradient` tip never depends on
the value while a `screenGradient` tip always does, and that no palette draws a
gradient between a colour and itself.

**A QML binding that only calls a function has no dependency on what the
function reads.** `Spectrum.qml`'s `pair` reads `root.fill` in its own
expression for that reason; without it, switching the fill left every bar
painted from the pair it was built with.

**The cava config must never live in a shared directory.** It fell back to
`/tmp/omarchy-visualizer/cava.conf` when `XDG_RUNTIME_DIR` was unset — a
predictable path in a world-writable namespace, created with a bare `mkdir -p`
and written with a plain write. Another local user can win that race: leave a
directory or a symlink there first and a shell that lives for the whole
session writes the config through it into a file of their choosing.

`Vis.configDir` now takes `XDG_RUNTIME_DIR` (0700, ours) or `$HOME/.cache`, and
returns `""` when it has neither — `shouldRun` reads `configReady` and the
plugin stays off rather than reaching for `/tmp`. `Vis.configDirCommand`
creates the directory `mkdir -m 700` and refuses a path that is a symlink or
that someone else owns, and removes a `cava.conf` that is a symlink or not a
plain file of ours instead of writing through it. The directory name is passed
as an argument, never spliced into the script.
