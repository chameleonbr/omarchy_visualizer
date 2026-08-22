// The cava process, the guards that decide whether it runs at all, and the
// bridge that mirrors what the bar draws onto WLED lights.
//
// One per shell session (kind: "service"), so a machine with three monitors
// runs one cava rather than three.

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Pipewire
import Quickshell.Services.UPower
import "Visualizer.js" as Vis

Item {
  id: root

  // ------------------------------------------------------------ settings

  property int barCount: 14
  property int framerate: 30
  property int smoothing: 60
  property int floorLevel: 3
  property bool pauseOnBattery: true
  property bool pauseWhenSilent: true

  property bool wledEnabled: false
  property int wledRateHz: 10
  property string wledDevices: ""
  property bool wledRestore: true

  function configure(settings) {
    var nextBars = Math.max(6, Math.min(24, Number(settings.barCount) || 14))
    var nextRate = Math.max(10, Math.min(60, Number(settings.framerate) || 30))
    // cava is told these at startup, so changing them means restarting it.
    var restart = nextBars !== barCount || nextRate !== framerate

    barCount = nextBars
    framerate = nextRate
    smoothing = Math.max(0, Math.min(95, Number(settings.smoothing) || 60))
    floorLevel = Math.max(0, Math.min(20, Number(settings.floor) || 0))
    pauseOnBattery = settings.pauseOnBattery !== false
    pauseWhenSilent = settings.pauseWhenSilent !== false

    wledEnabled = settings.wledEnabled === true
    wledRateHz = Math.max(1, Math.min(20, Number(settings.wledRateHz) || 10))
    wledDevices = String(settings.wledDevices || "")
    wledRestore = settings.wledRestore !== false

    if (restart) writeConfig()
  }

  // -------------------------------------------------------------- state

  property var frame: []
  property int frameNumber: 0
  // -1 until the check answers: "not installed" and "not asked yet" are
  // different, and only one of them is worth telling the user about.
  property int installed: -1
  property int visibleWidgets: 0

  readonly property bool playing: {
    var nodes = Pipewire.nodes ? Pipewire.nodes.values : []
    for (var i = 0; i < nodes.length; i++) {
      // An application playing audio shows up as a stream on the sink side.
      if (nodes[i] && nodes[i].isStream && nodes[i].isSink) return true
    }
    return false
  }

  readonly property var guardState: ({
    installed: installed === 1,
    visible: visibleWidgets > 0,
    playing: playing,
    onBattery: UPower.onBattery,
    pauseWhenSilent: pauseWhenSilent,
    pauseOnBattery: pauseOnBattery
  })

  readonly property bool running: Vis.shouldRun(guardState)
  readonly property string idleReason: Vis.idleReason(guardState)

  function setWidgetVisible(visible) {
    visibleWidgets = Math.max(0, visibleWidgets + (visible ? 1 : -1))
  }

  // ------------------------------------------------------------- cava

  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
  readonly property string configFilePath: Vis.configPath(runtimeDir)

  Process {
    id: installCheck
    command: Vis.cavaCheckCommand()
    running: true
    stdout: SplitParser {
      onRead: function(line) { root.installed = line.trim() === "yes" ? 1 : 0 }
    }
  }

  // Written under XDG_RUNTIME_DIR, never to ~/.config/cava: that file belongs
  // to whoever runs cava in a terminal, and a bar widget has no business
  // rewriting it.
  FileView {
    id: configFile
    path: root.configFilePath
  }

  // FileView cannot create the directory, and the first write happens before
  // anything else has had a reason to make it.
  Process {
    id: makeDir
    command: ["mkdir", "-p", Vis.configDir(root.runtimeDir)]
    running: true
    onExited: root.writeConfig()
  }

  function writeConfig() {
    if (makeDir.running) return
    configFile.setText(Vis.cavaConfig({ barCount: barCount, framerate: framerate }))
    if (cava.running) restartCava()
  }

  function restartCava() {
    cava.running = false
    restartTimer.restart()
  }

  Timer {
    id: restartTimer
    interval: 120
    onTriggered: if (root.running) cava.running = true
  }

  Process {
    id: cava
    command: Vis.cavaCommand(root.configFilePath)

    stdout: SplitParser {
      onRead: function(line) {
        var next = Vis.parseFrame(line, root.barCount)
        if (!next) return

        root.frameNumber++
        // autosens spikes while it calibrates; a third of a second of silence
        // beats a lurch every time the widget wakes up.
        if (Vis.isWarmup(root.frameNumber)) return

        var floored = Vis.applyFloor(next, root.floorLevel)
        root.frame = Vis.smoothFrame(root.frame, floored, root.smoothing)
        root.pushToWled()
      }
    }
  }

  // The process is killed, not paused. A paused cava still holds the audio
  // capture open, which is most of what it costs.
  onRunningChanged: {
    if (running) {
      frameNumber = 0
      cava.running = true
    } else {
      cava.running = false
      frame = []
      restoreWled()
    }
  }


  // ------------------------------------------------------------- WLED
  //
  // The differentiator, and the half with real hardware on the other end.

  readonly property string wledConfigPath:
    Quickshell.env("HOME") + "/.config/omarchy/wled.json"

  // Read, never written: the WLED plugin owns this file.
  FileView {
    id: wledConfig
    path: root.wledConfigPath
    watchChanges: true
    onFileChanged: reload()
  }

  readonly property var wledHosts: {
    if (!wledEnabled) return []

    var wanted = []
    var parts = wledDevices.split(",")
    for (var p = 0; p < parts.length; p++) {
      var name = parts[p].trim()
      if (name) wanted.push(name)
    }

    var text = wledConfig.text()
    if (!text) return []

    var parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return []
    }

    var hosts = []
    var devices = parsed.devices || []
    for (var i = 0; i < devices.length; i++) {
      var host = devices[i].address || devices[i].host
      if (!host) continue
      if (wanted.length > 0 && wanted.indexOf(devices[i].host) < 0
        && wanted.indexOf(devices[i].name) < 0) continue
      hosts.push(host)
    }
    return hosts
  }

  property real lastSentMs: 0
  property bool wledTouched: false

  function pushToWled() {
    if (!wledEnabled || wledHosts.length === 0 || frame.length === 0) return

    var now = Date.now()
    // Frames above the rate are dropped rather than queued: a queue would just
    // move the backlog to the end of the song, and WLED over HTTP stops
    // answering long before the frame rate.
    if (!Vis.shouldSendToWled(lastSentMs, now, wledRateHz)) return
    lastSentMs = now

    var energy = Vis.frameEnergy(frame)
    var color = Vis.wledColor(paletteName, energy, paletteContext)
    var payload = Vis.wledPayload(Vis.wledBrightness(energy, 0, 255), color)

    wledTouched = true
    for (var i = 0; i < wledHosts.length; i++) send(wledHosts[i], payload)
  }

  function restoreWled() {
    if (!wledRestore || !wledTouched || wledHosts.length === 0) return
    wledTouched = false
    // Nothing was remembered, so the honest restore is off rather than a guess
    // at what the lamp was doing before.
    var payload = Vis.wledRestorePayload(null)
    for (var i = 0; i < wledHosts.length; i++) send(wledHosts[i], payload)
  }

  // Detached and fire-and-forget: a light that does not answer must not hold up
  // the next frame, and a failure here never touches what the bar draws.
  function send(host, payload) {
    Quickshell.execDetached(["curl", "-s", "-m", "1", "-X", "POST",
      "-H", "Content-Type: application/json",
      "-d", payload, "http://" + host + "/json/state"])
  }

  // Colours come from the panel, which owns the theme bindings.
  property string paletteName: "accent"
  property var paletteContext: ({})
}
