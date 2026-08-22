// The bar widget.
//
// Fixed width, always. A visualiser whose width followed the sound would shove
// every widget to its right across the bar sixty times a second, which is the
// classic way this kind of thing gets uninstalled.

import QtQuick
import Quickshell
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

  readonly property string shape: {
    var wanted = String(setting("shape", "bars"))
    return Vis.isShape(wanted) ? wanted : "bars"
  }
  readonly property string palette: {
    var wanted = String(setting("palette", "accent"))
    return Vis.isPalette(wanted) ? wanted : "accent"
  }
  readonly property int spectrumWidth: Math.max(40, Number(setting("widgetWidth", 90)))
  readonly property int barWidth: Math.max(1, Number(setting("barWidth", 3)))
  readonly property int segments: Math.max(3, Number(setting("segments", 8)))
  readonly property real spectrumHeight: Math.max(6, Math.round(barSize - Style.space(10)))

  // Colours by binding, never copied once at startup — otherwise a theme change
  // repaints everything except this.
  readonly property var paletteContext: ({
    foreground: { r: foreground.r, g: foreground.g, b: foreground.b },
    accent: { r: Color.accent.r, g: Color.accent.g, b: Color.accent.b },
    urgent: { r: Color.urgent.r, g: Color.urgent.g, b: Color.urgent.b },
    gradientFrom: Vis.parseHex(setting("gradientFrom", "")),
    gradientTo: Vis.parseHex(setting("gradientTo", "")),
    peakThreshold: Number(setting("peakThreshold", 85))
  })

  readonly property var frame: service ? service.frame : []
  readonly property bool running: service ? service.running : false
  readonly property string idleReason: service ? service.idleReason : ""

  function pushSettings() {
    if (!service) return
    service.configure(settings || ({}))
    service.paletteName = palette
    service.paletteContext = paletteContext
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
      return root.shape + " · " + root.palette
    }
    // Middle click swaps the shape without opening anything, which is the one
    // setting anyone fiddles with.
    onPressed: function(code) {
      if (code !== Qt.MiddleButton) return
      var next = (Vis.SHAPES.indexOf(root.shape) + 1) % Vis.SHAPES.length
      if (root.bar && root.bar.setWidgetSetting)
        root.bar.setWidgetSetting(root.moduleName, "shape", Vis.SHAPES[next])
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
        : new Array(Math.max(6, Number(root.setting("barCount", 14)))).fill(0)

      shape: root.shape
      palette: root.palette
      paletteContext: root.paletteContext
      barWidth: root.barWidth
      segments: root.segments
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
