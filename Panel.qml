// The bar widget.
//
// Fixed width, always. A visualiser whose width followed the sound would shove
// every widget to its right across the bar sixty times a second, which is the
// classic way this kind of thing gets uninstalled.

import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis

BarWidget {
  id: root
  moduleName: "avila.visualizer"

  readonly property var service: bar && bar.shell
    ? bar.shell.serviceFor(root.moduleName) : null

  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Four axes rather than a menu of finished styles: they combine, so the
  // shapes people recognise from a reference sheet are arrangements of these
  // rather than fifteen separate code paths.
  readonly property string base: {
    var wanted = String(value("base", "bottom"))
    return Vis.isBase(wanted) ? wanted : "bottom"
  }
  readonly property string cap: {
    var wanted = String(value("cap", "flat"))
    return Vis.isCap(wanted) ? wanted : "flat"
  }
  readonly property string fillStyle: {
    var wanted = String(value("fill", "solid"))
    return Vis.isFill(wanted) ? wanted : "solid"
  }
  readonly property string palette: {
    var wanted = String(value("palette", "accent"))
    return Vis.isPalette(wanted) ? wanted : "accent"
  }
  readonly property bool showPeaks: value("showPeaks", false) === true
  readonly property bool showWave: value("showWave", false) === true
  readonly property real spread: Math.max(0.1, Math.min(1, Number(value("spread", 1))))
  readonly property real innerRadius: Math.max(0, Math.min(0.8, Number(value("innerRadius", 0.3))))

  readonly property int spectrumWidth: Math.max(40, Number(value("widgetWidth", 90)))
  readonly property int barWidth: Math.max(1, Number(value("barWidth", 3)))
  readonly property int segments: Math.max(3, Number(value("segments", 8)))
  readonly property real spectrumHeight: Math.max(6, Math.round(barSize - Style.space(10)))

  // Colours by binding, never copied once at startup — otherwise a theme change
  // repaints everything except this.
  readonly property var paletteContext: ({
    foreground: { r: foreground.r, g: foreground.g, b: foreground.b },
    accent: { r: Color.accent.r, g: Color.accent.g, b: Color.accent.b },
    urgent: { r: Color.urgent.r, g: Color.urgent.g, b: Color.urgent.b },
    gradientFrom: Vis.parseHex(value("gradientFrom", "")),
    gradientTo: Vis.parseHex(value("gradientTo", "")),
    solidColor: Vis.parseHex(value("solidColor", "")),
    peakThreshold: Number(value("peakThreshold", 85))
  })

  readonly property var frame: service ? service.frame : []
  readonly property var peaks: service ? service.peaks : []
  readonly property bool running: service ? service.running : false
  readonly property string idleReason: service ? service.idleReason : ""

  // shell.json seeds; the panel's own file wins. Reading through the service
  // means one merge, not one per file that happens to have an opinion.
  function pushSettings() {
    if (!service) return
    service.seed = settings || ({})
    service.paletteName = palette
    service.paletteContext = paletteContext
  }

  function value(key, fallback) {
    if (!service) return fallback
    var v = service.value(key)
    return v === undefined ? fallback : v
  }

  onSettingsChanged: pushSettings()
  onPaletteContextChanged: if (service) service.paletteContext = paletteContext

  // The host injects `bar` after construction, so the service resolves later
  // than Component.onCompleted — registering only there loses the count.
  property bool registered: false

  function syncVisibility() {
    if (!service) return
    if (visible === registered) return
    service.setWidgetVisible(visible)
    registered = visible
  }

  onServiceChanged: {
    pushSettings()
    syncVisibility()
  }
  onVisibleChanged: syncVisibility()
  Component.onCompleted: {
    pushSettings()
    syncVisibility()
  }
  Component.onDestruction: if (service && registered) service.setWidgetVisible(false)

  Stage {
    id: stage
    widget: root
  }

  // Reachable from a Hyprland binding: "show me the spectrum" is a thing to
  // bind a key to, not only something to click.
  IpcHandler {
    target: "avila.visualizer"

    function open(): void { stage.open() }
    function close(): void { stage.close() }
    function toggle(): void { stage.visible ? stage.close() : stage.open() }
    function fullscreen(): void {
      stage.open()
      stage.fullscreen = true
    }
    function settings(): void {
      stage.open()
      stage.settingsOpen = true
    }
  }

  implicitWidth: vertical ? barSize : spectrumWidth + Style.space(12)
  implicitHeight: barSize

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    fixedWidth: root.implicitWidth
    fixedHeight: root.barSize
    tooltipText: {
      if (root.idleReason === "missing") return "cava não está instalado — omarchy pkg add cava"
      if (root.idleReason === "silent") return "nada tocando"
      if (root.idleReason === "battery") return "pausado na bateria"
      return root.base + " · " + root.palette + " · clique para abrir"
    }
    // Middle click swaps the shape without opening anything, which is the one
    // setting anyone fiddles with.
    onPressed: function(code) {
      if (code === Qt.LeftButton) stage.open()
    }

    Spectrum {
      id: spectrum
      anchors.centerIn: parent
      width: root.spectrumWidth
      height: root.spectrumHeight
      visible: root.idleReason !== "missing"

      // At rest the shape is still drawn, flat: the widget keeps its place in
      // the bar instead of collapsing and reflowing everything beside it.
      frame: root.running && root.frame.length > 0
        ? root.frame
        : new Array(Math.max(6, Number(root.value("barCount", 14)))).fill(0)

      peaks: root.running ? root.peaks : []
      base: root.base
      cap: root.cap
      fill: root.fillStyle
      palette: root.palette
      paletteContext: root.paletteContext
      barWidth: root.barWidth
      segments: root.segments
      showPeaks: root.showPeaks
      showWave: root.showWave
      spread: root.spread
      innerRadius: root.innerRadius
      devicePixelRatio: Screen.devicePixelRatio
      opacity: root.running ? 1 : 0.35

      Behavior on opacity { NumberAnimation { duration: 220 } }
    }

    // Drawn, not typed: a missing glyph renders as nothing at all, and a widget
    // that shows nothing is indistinguishable from one that failed to load.
    Rectangle {
      anchors.centerIn: parent
      visible: root.idleReason === "missing"
      width: root.spectrumHeight
      height: root.spectrumHeight
      color: "transparent"
      border.width: 1
      border.color: root.dim
      radius: 2

      Rectangle {
        anchors.centerIn: parent
        width: parent.width * 1.25
        height: 1
        rotation: -45
        color: root.dim
      }
    }
  }
}
