# Visualizer

The sound, in the Omarchy bar. Five shapes, six palettes, and the same colours
mirrored onto your WLED lights.

![four of the styles: pills with peak markers, a mirrored gradient with a wave under it, a segmented meter, and a ring](preview.png)

Four combinations of the same four axes.

It does not resolve a problem. It is an ornament, and the design assumes that:
every decision below chooses between *prettier* and *does not burn the
battery*, and the second one wins whenever it can.

## Install

```bash
omarchy plugin add \
  https://github.com/chameleonbr/omarchy_visualizer.git \
  --enable \
  --yes
```

Needs `cava`, which the plugin does not install for you:

```bash
omarchy pkg add cava
```

Without it the widget shows a crossed box and says so on hover, rather than
disappearing — a widget that shows nothing is indistinguishable from one that
failed to load.

## Styles

Four axes rather than a list of finished styles. They combine, so the shapes
people recognise from a reference sheet are arrangements of these rather than
fifteen separate things to maintain.

| Axis | Values |
|---|---|
| **base** | `bottom` · `top` · `mirror` · `radial` |
| **cap** | `flat` · `round` · `segments` |
| **fill** | `solid` · `barGradient` · `screenGradient` |
| **extras** | peak markers · a wave underneath |

`radial` is a base like any other, so a full ring and an open fan are the same
geometry with a different `spread`.

The peak marker rises instantly and sinks slowly: the bars say what is happening
now, the markers say what just happened, and that is what makes a meter readable
at a glance.

## Palettes

| Palette | What it does |
|---|---|
| `accent` · `foreground` | the theme's colours, solid |
| `intensity` | foreground → accent as a band gets louder |
| `spectrum` | hue swept across the bands, **saturation from the theme** |
| `rainbow` | the same sweep at full saturation, ignoring the theme |
| `heat` | cold at rest, hot at the peaks |
| `gradient` | between two colours you pick |
| `solid` | one colour you pick |
| `urgent` | accent, turning urgent above the threshold |

Two families on purpose: `intensity`, `heat` and `urgent` move with the sound;
`spectrum`, `rainbow` and `gradient` are fixed to position. One gives colour
motion, the other keeps the bar visually still.

`spectrum` takes its saturation from the theme, so a muted theme gets a muted
sweep. `rainbow` is the loud version, and having both is the point.

## The stage

Click the widget and the spectrum gets a window of its own.

| Key | What it does |
|---|---|
| `f` | fullscreen |
| `s` | settings, over the top |
| `esc` | steps back one layer — out of the settings, then out of fullscreen, then closed |

Every settings row cycles on click, left forward and right back. There is no
apply button: the visualiser behind the panel is the preview.

It can be bound too:

```bash
omarchy-shell avila.visualizer toggle
omarchy-shell avila.visualizer fullscreen
omarchy-shell avila.visualizer settings
```

## Where it listens

| `input` | What it hears |
|---|---|
| `system` | what the machine is playing |
| `mic` | the microphone |
| `both` | the two summed together |

`both` is not a cava setting: cava reads one device, and a device that hears
both does not exist. The plugin builds one — a null sink fed by two loopbacks —
while the setting is on, and removes it when you change it or the shell exits. A
stray sink left in someone's audio graph outlives the widget.

## Settings live in their own file

`~/.config/omarchy/visualizer.json`. The bar host has no way for a widget to
write its own `shell.json` entry, and a plugin editing that file races the shell
whenever the bar is dragged. The `shell.json` entry seeds the defaults; the
file wins.

## What it costs you## What it costs you

This runs on a laptop, so the guards are most of the design.

**The process is killed, not paused.** A paused cava still holds the audio
capture open, which is most of what it costs. It stops when nothing is playing,
when you are on battery, and when no copy of the widget is on screen. Each of
those is a setting, and each is on by default.

**30 frames a second, not 60.** At the size of a bar the difference is
invisible; in the power draw it is not.

**The width never changes.** A visualiser whose width followed the sound would
shove every widget to its right across the bar on every frame.

At rest the shape is still drawn, flat and dimmed. The widget keeps its place
rather than collapsing and reflowing everything beside it.

## WLED

Turn on `wledEnabled` and the lights configured for the
[WLED plugin](https://github.com/chameleonbr/omarchy_wled) show the colour the
bar is showing. That file is read, never written — it belongs to that plugin.

Three things this gets right, and they are all about the hardware:

**Brightness follows the mean, not the peak.** Tracking the peak makes the lamp
follow the kick drum alone, which reads as strobing rather than as music.

**Frames above `wledRateHz` are dropped, never queued.** WLED over HTTP stops
answering long before a frame rate, and the symptom looks like a broken lamp
rather than a busy one. A queue would only move the backlog to the end of the
song.

**The lights are put back when the music stops.** Leaving a lamp frozen on some
colour after you close the player is the worst thing this bridge can do.

A light that does not answer never holds up a frame: the sends are detached, and
a failure there never touches what the bar draws.

## Settings

Everything is in the widget's settings screen. The ones worth knowing:

| Setting | Default | Why you might change it |
|---|---|---|
| `shape` · `palette` | `bars` · `accent` | taste |
| `barCount` | 14 | more bands, finer detail, more to draw |
| `smoothing` | 60 | how gently a bar falls; the rise is always immediate |
| `floor` | 3 | below this a band reads as zero, so room noise lets it rest |
| `framerate` | 30 | the cost knob |
| `pauseWhenSilent` · `pauseOnBattery` | on | the two guards |
| `wledEnabled` | off | mirror onto the lights |
| `wledRateHz` | 10 | how fast the lamp is asked to follow |

## Development

```bash
node test_visualizer.js
```

35 checks, no framework, no audio, no cava, no network. See `CLAUDE.md` for how
the pieces fit and `SPEC.md` for why they are shaped this way.

## License

MIT
