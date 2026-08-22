# Visualizer

The sound, in the Omarchy bar. Five shapes, six palettes, and the same colours
mirrored onto your WLED lights.

![the spectrum in the bar](preview.png)

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

## Shapes

| Shape | What it draws |
|---|---|
| `bars` | bars growing from the floor — the most legible on a thin bar |
| `mirror` | bars growing from the centre, up and down |
| `blocks` | each bar cut into lit and unlit segments, like a stereo meter |
| `dots` | one dot per band, riding the value — the quiet option |
| `wave` | a line joining the peaks; less ink, for a minimal theme |

Middle click cycles them without opening anything.

Four of them are rectangles, which for this many bands costs far less than a
canvas. `wave` is the only one that needs a canvas, and that is why it is not
the default.

## Palettes

| Palette | What it does |
|---|---|
| `accent` | the theme's accent, solid |
| `foreground` | the theme's foreground, solid — the soberest |
| `intensity` | foreground → accent as a band gets louder |
| `spectrum` | hue swept low to high across the bands |
| `gradient` | between two hex colours you pick |
| `urgent` | accent, turning urgent above the peak threshold |

Two families on purpose: `intensity` and `urgent` move with the sound,
`spectrum` and `gradient` are fixed to position. One gives colour motion and the
other keeps the bar visually still. Which you want is taste.

`spectrum` takes its saturation from the theme's accent, so a muted theme gets a
muted sweep rather than a rainbow borrowed from someone else's desktop.

## What it costs you

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
