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
import "I18n.js" as I18n

Item {
  id: root

  // ------------------------------------------------------------ settings

  property int barCount: 14
  property int framerate: 30
  property int smoothing: 60
  property int floorLevel: 3
  property bool pauseOnBattery: true
  property bool pauseWhenSilent: true
  property real peakFall: 1.5
  property string input: "system"
  property string micSource: ""
  property string sinkMonitor: ""

  property bool wledEnabled: false
  property int wledRateHz: 10
  property string wledDevices: ""
  property bool wledRestore: true

  // ------------------------------------------------------------ language
  //
  // Bumped whenever the language changes, so every binding that renders a
  // translated string has something to depend on. `I18n.t()` is a function
  // call: nothing about it tells QML to re-evaluate when the table underneath
  // it is swapped.
  property int languageEpoch: 0

  readonly property string locale: Quickshell.env("LC_ALL")
    || Quickshell.env("LC_MESSAGES") || Quickshell.env("LANG") || ""

  function applyLanguage(name) {
    var wanted = name === "auto" ? I18n.detectLanguage(locale) : name
    if (I18n.language() === wanted) return
    I18n.setLanguage(wanted)
    languageEpoch++
  }

  // ------------------------------------------------------------ settings
  //
  // Two sources: the widget's entry in shell.json seeds the defaults, and the
  // panel's own file wins over it. The bar host has no API for a widget to
  // write its shell.json entry back, and a plugin editing that file races the
  // shell whenever someone drags the bar around.

  readonly property string settingsPath:
    Quickshell.env("HOME") + "/.config/omarchy/visualizer.json"

  property var seed: ({})
  property var fileSettings: ({})
  readonly property var merged: Vis.mergeSettings(seed, fileSettings)

  function value(key) {
    return merged[key]
  }

  FileView {
    id: settingsFile
    path: root.settingsPath
    watchChanges: true
    onFileChanged: reload()
    onLoaded: root.fileSettings = Vis.parseSettingsFile(settingsFile.text()) || ({})
  }

  // Written whole, from the merge, so a file that only ever held one key does
  // not quietly reset everything else on the next save.
  function save(patch) {
    var next = Vis.mergeSettings(merged, patch)
    fileSettings = next
    settingsFile.setText(Vis.serializeSettings(next))
    applySettings()
  }

  onMergedChanged: applySettings()

  function applySettings() {
    configure(merged)
  }

  function configure(settings) {
    applyLanguage(String(settings.language || "auto"))

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
    peakFall = Math.max(0.2, Math.min(10, Number(settings.peakFall) || 1.5))

    var wantedInput = String(settings.input || "system")
    if (!Vis.isInput(wantedInput)) wantedInput = "system"
    if (wantedInput !== input) {
      input = wantedInput
      restart = true
      applyInput()
    }

    wledEnabled = settings.wledEnabled === true
    wledRateHz = Math.max(1, Math.min(20, Number(settings.wledRateHz) || 10))
    wledDevices = String(settings.wledDevices || "")
    wledRestore = settings.wledRestore !== false

    if (restart) writeConfig()
  }

  // -------------------------------------------------------------- state

  property var frame: []
  property var peaks: []
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
    configReady: configReady,
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

  // No `/tmp` fallback: see Vis.configDir. An empty path means there is
  // nowhere private to write, and the plugin stays off.
  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || ""
  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string configDirPath: Vis.configDir(runtimeDir, homeDir)
  readonly property string configFilePath: Vis.configPath(runtimeDir, homeDir)

  // null until the directory has been made and checked; false if it could not
  // be. `shouldRun` reads it, so cava never starts without its own config.
  property var configReady: null

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
  // anything else has had a reason to make it. It is also where the directory
  // is made 0700 and checked for being ours rather than something left in the
  // way — see Vis.configDirCommand.
  Process {
    id: makeDir
    command: Vis.configDirCommand(root.configDirPath)
    running: root.configDirPath !== ""
    onExited: function(code) {
      root.configReady = code === 0
      if (root.configReady) root.writeConfig()
    }
  }

  function writeConfig() {
    if (makeDir.running || configReady !== true) return
    configFile.setText(Vis.cavaConfig({
      barCount: barCount, framerate: framerate,
      input: input, micSource: micSource
    }))
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
        // Peaks track the smoothed frame, not the raw one: a marker that
        // chased every spike would never sit still long enough to read.
        root.peaks = Vis.updatePeaks(root.peaks, root.frame, root.peakFall)
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
      peaks = []
      restoreWled()
    }
  }


  // ------------------------------------------------------- audio input
  //
  // "system" is cava's own default and needs no lookup. "mic" needs the name of
  // the default source. "both" needs a device that does not exist yet, so the
  // plugin builds one and takes it away again — leaving a stray sink in
  // someone's audio graph is a mess that outlives the widget.

  Process {
    id: sinkQuery
    command: Vis.defaultSinkCommand()
    stdout: SplitParser {
      onRead: function(line) { root.sinkMonitor = line.trim() + ".monitor" }
    }
  }

  Process {
    id: sourceQuery
    command: Vis.defaultSourceCommand()
    stdout: SplitParser {
      onRead: function(line) { root.micSource = line.trim() }
    }
  }

  // The device names arrive from pactl a moment after the setting changes, and
  // the config was written before they did — so "mic" wrote `source = ` and
  // cava fell back to its own default, which is the system audio. The config is
  // rewritten when the name lands, which is the only moment it can be correct.
  onMicSourceChanged: if (input === "mic" && micSource) writeConfig()
  onSinkMonitorChanged: if (input === "both" && sinkMonitor) buildTimer.restart()

  Process { id: mixProcess }
  property var mixQueue: []
  property bool mixBuilt: false

  function applyInput() {
    if (input === "system") {
      teardownMix()
      writeConfig()
      return
    }

    // Re-asked every time rather than cached: the default source changes when
    // someone plugs in a headset, and a name from ten minutes ago is a config
    // that silently reads the wrong device.
    sourceQuery.running = false
    sourceQuery.running = true
    if (input === "both") {
      sinkQuery.running = true
      buildTimer.restart()
    }
  }

  // Given a moment for the two queries to answer. Building the mix against an
  // empty device name would load a loopback from nothing.
  Timer {
    id: buildTimer
    interval: 400
    onTriggered: root.buildMix()
  }

  function buildMix() {
    if (mixBuilt || !sinkMonitor || !micSource) return
    mixBuilt = true
    mixQueue = Vis.mixSetupCommands(sinkMonitor, micSource)
    pumpMix()
  }

  function pumpMix() {
    if (mixProcess.running || mixQueue.length === 0) return
    var next = mixQueue.shift()
    mixProcess.command = next
    mixProcess.running = true
  }

  Connections {
    target: mixProcess
    function onExited() { root.pumpMix() }
  }

  function teardownMix() {
    if (!mixBuilt) return
    mixBuilt = false
    mixQueue = []
    Quickshell.execDetached(Vis.mixTeardownCommand())
  }

  // The mix is torn down when the widget stops for any reason, not only when
  // the setting changes: a shell restart with it still loaded would leave the
  // sink behind for good.
  Component.onDestruction: teardownMix()

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
