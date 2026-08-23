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

  SizedFile {
    id: settingsFile
    path: root.settingsPath
    onFileLoaded: function(text) {
      root.fileSettings = Vis.parseSettingsFile(text) || ({})
    }
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
    var wantedStyle = String(settings.wledStyle || "spectrum")
    wledStyle = Vis.WLED_STYLES.indexOf(wantedStyle) >= 0 ? wantedStyle : "spectrum"
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
    // Written, never read: nothing here ever calls text().
    preload: false
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
      onRead: function(line) {
        var name = line.trim()
        if (!name) return
        // Its own monitor is a feedback loop, so the last real sink is kept
        // instead. Not building the mix is the safe way to be wrong here.
        if (Vis.isMixMonitor(name)) return
        root.sinkMonitor = name + ".monitor"
      }
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
  //
  // A device name that changed is a device that moved, and what that costs
  // depends on the input. `auto` is resolved once, inside a cava that is
  // already running. The mix's loopback is pinned once, inside a module that is
  // already loaded. Neither notices a headset arriving on its own.
  onMicSourceChanged: {
    if (!micSource) return
    if (input === "mic") writeConfig()
    else if (input === "both") rebuildMix()
  }

  onSinkMonitorChanged: {
    if (!sinkMonitor) return
    if (input === "both") rebuildMix()
    else if (input === "system" && cava.running) restartCava()
  }

  // `pactl subscribe` is not the answer: switching the default sink emits no
  // event for it at all. So the question is asked again, at a rate a person
  // plugging in headphones would not notice.
  Timer {
    id: deviceWatch
    running: root.running
    interval: 3000
    repeat: true
    onTriggered: {
      sinkQuery.running = false
      sinkQuery.running = true
      if (root.input !== "system") {
        sourceQuery.running = false
        sourceQuery.running = true
      }
    }
  }

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
    // Appended, not assigned: a teardown queued by rebuildMix has to run first,
    // and replacing the queue would drop it and load a second set of modules.
    mixQueue = mixQueue.concat(Vis.mixSetupCommands(sinkMonitor, micSource))
    pumpMix()
  }

  // Tear the mix down and put it back around the device that is default now.
  // Both halves go through the same queue, so the unload cannot land after the
  // load it was supposed to precede.
  function rebuildMix() {
    if (mixBuilt) {
      mixBuilt = false
      mixQueue = mixQueue.concat([Vis.mixTeardownCommand()])
      pumpMix()
    }
    buildTimer.restart()
  }

  function pumpMix() {
    if (mixProcess.running || mixQueue.length === 0) return
    var next = mixQueue.shift()
    mixProcess.command = next
    mixProcess.running = true
  }

  Connections {
    target: mixProcess
    function onExited() {
      root.pumpMix()
      // The null sink cava was capturing has just been destroyed and remade, so
      // the capture it still holds is on a device that no longer exists.
      if (!mixProcess.running && root.mixQueue.length === 0
        && root.mixBuilt && cava.running) root.restartCava()
    }
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
  SizedFile {
    id: wledConfig
    path: root.wledConfigPath
    onFileLoaded: function(text) { root.wledParsed = Vis.parseConfigFile(text) }
  }

  property var wledParsed: null

  // The lights the WLED plugin knows about, for the settings pane to offer.
  readonly property var wledNames: Vis.wledDeviceNames(wledParsed)

  readonly property var wledHosts: {
    if (!wledEnabled) return []
    return Vis.wledHostList(wledParsed, Vis.wledWantedNames(wledDevices))
  }

  property string wledStyle: "spectrum"

  // How long each strip is, by host. A strip cannot be painted band by band
  // until it has said, and it is asked once per set of hosts rather than per
  // frame — the answer does not change while the lights are on.
  property var wledLedCounts: ({})

  onWledHostsChanged: askWledSizes()
  onWledEnabledChanged: if (wledEnabled) askWledSizes()

  function askWledSizes() {
    if (!wledEnabled || wledHosts.length === 0) return
    wledInfo.running = false
    wledInfo.command = Vis.wledInfoCommand(wledHosts)
    wledInfo.running = true
  }

  Process {
    id: wledInfo
    command: Vis.wledInfoCommand([])
    stdout: SplitParser {
      onRead: function(line) {
        var found = Vis.parseWledInfo(line)
        if (!found) return
        // Replaced rather than mutated: QML does not notice a property of a
        // property changing, and the payload would go on using the old length.
        var next = {}
        for (var host in root.wledLedCounts) next[host] = root.wledLedCounts[host]
        next[found.host] = found.count
        root.wledLedCounts = next
      }
    }
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
    var solid = Vis.wledPayload(Vis.wledBrightness(energy, 0, 255),
      Vis.wledColor(paletteName, energy, paletteContext))

    wledTouched = true
    for (var i = 0; i < wledHosts.length; i++) {
      var host = wledHosts[i]
      var leds = Number(wledLedCounts[host]) || 0

      // A strip that has not answered yet gets the one-colour payload rather
      // than nothing: the bridge works from the first frame and sharpens when
      // the strip says how long it is.
      if (wledStyle === "solid" || leds < 2) { send(host, solid); continue }

      var runs = Vis.wledRuns(frame, paletteName, paletteContext, leds, wledStyle)
      if (runs.length === 0) { send(host, solid); continue }

      // The colours already carry how loud each band is, so global brightness
      // only follows the room: dropping it to nothing as well would leave a
      // quiet passage invisible rather than dim.
      send(host, Vis.wledLivePayload(Vis.wledBrightness(energy, 96, 255), runs))
    }
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
