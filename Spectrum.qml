// The drawing.
//
// Four axes rather than a list of finished styles: where a bar grows from
// (base), what its end looks like (cap), how it is filled, and whether it
// carries a peak marker or a wave underneath. The named styles people recognise
// are combinations of those, which is why they are settings and not a menu of
// nine.
//
// Everything is sized on the device pixel grid. A pitch of width/count is
// fractional, and identical bars then rasterise at different widths — the exact
// bug the docker mosaic had, with the exact same fix.

import QtQuick
import qs.Commons
import "Visualizer.js" as Vis

Item {
  id: root

  property var frame: []
  property var peaks: []

  property string base: "bottom"
  property string cap: "flat"
  property string fill: "solid"
  property string palette: "accent"
  property var paletteContext: ({})

  property int barWidth: 3
  property int segments: 8
  property real gap: 2
  property bool showPeaks: false
  property bool showWave: false
  property real spread: 1
  property real innerRadius: 0.3
  property real devicePixelRatio: 1

  readonly property int count: frame.length
  readonly property bool radial: base === "radial"

  readonly property var layout: Vis.barLayout(width, count, barWidth, gap, devicePixelRatio)
  readonly property real pitch: layout.pitch
  readonly property real drawWidth: layout.width
  readonly property real minBar: Vis.floorToDevice(2, devicePixelRatio)

  function barX(index) {
    return layout.offset + index * pitch + (pitch - drawWidth) / 2
  }

  function colorAt(index, value) {
    var c = Vis.paletteColor(root.palette, index, root.count, value, root.paletteContext)
    return Qt.rgba(c.r, c.g, c.b, 1)
  }

  function gradientPair(index, value) {
    var pair = Vis.barGradientPair(root.palette, index, root.count, value,
      root.paletteContext, root.fill)
    return {
      base: Qt.rgba(pair.base.r, pair.base.g, pair.base.b, 1),
      tip: Qt.rgba(pair.tip.r, pair.tip.g, pair.tip.b, 1)
    }
  }

  // ------------------------------------------------------- linear bars
  //
  // Two separate repeaters rather than one with a branch inside it. The
  // segmented cap needs the FULL height to lay its segments out, while a solid
  // bar is only as tall as its value — reconciling those in one delegate meant
  // reparenting children out of it, and a Repeater delegate that reparents
  // rebinds every child on every frame. At sixteen bars of eight segments that
  // is enough to stall the shell.

  Repeater {
    model: !root.radial && root.cap !== "segments" ? root.frame : []

    Rectangle {
      id: bar
      required property int index
      required property real modelData

      readonly property var geometry: Vis.barGeometry(
        root.base, modelData, root.height, root.minBar, root.devicePixelRatio)
      // `root.fill` is read here as well as inside gradientPair, so switching
      // the fill re-evaluates the pair. A function call is not a dependency.
      readonly property var pair: root.fill === root.fill
        ? root.gradientPair(index, modelData) : null

      x: root.barX(index)
      // Already on the device grid: barGeometry rounds the length once and
      // derives the position, so rounding again here would put the base back
      // on the loose footing this was fixing.
      y: geometry.y
      width: root.drawWidth
      height: geometry.height
      radius: root.cap === "round" ? Math.min(width, height) / 2 : 0
      color: root.fill === "solid" ? root.colorAt(index, modelData) : "transparent"

      gradient: root.fill === "solid" ? null : barFill

      Gradient {
        id: barFill
        GradientStop { position: 0; color: bar.pair.tip }
        GradientStop { position: 1; color: bar.pair.base }
      }
    }
  }

  // ---------------------------------------------------- segmented bars

  Repeater {
    model: !root.radial && root.cap === "segments" ? root.frame : []

    Item {
      id: column
      required property int index
      required property real modelData

      readonly property int lit: Vis.litSegments(modelData, root.segments)
      readonly property real unit: Vis.floorToDevice(
        Math.max(1, (root.height - root.gap * (root.segments - 1)) / root.segments),
        root.devicePixelRatio)
      readonly property color tint: root.colorAt(index, modelData)

      x: root.barX(index)
      y: 0
      width: root.drawWidth
      height: root.height

      Repeater {
        model: root.segments

        Rectangle {
          required property int index

          // Counted up from the floor, and positioned rather than stacked: a
          // Column lays out from the top and the reconciliation is where this
          // went wrong the first time.
          x: 0
          y: column.height - (index + 1) * column.unit - index * root.gap
          width: column.width
          height: column.unit
          radius: 0
          color: column.tint
          // Unlit segments stay faintly drawn so the column keeps its shape and
          // reads as a meter rather than as loose blocks.
          opacity: index < column.lit ? 1 : 0.1
        }
      }
    }
  }

  // ------------------------------------------------------ peak markers

  Repeater {
    model: root.showPeaks && !root.radial ? root.peaks : []

    Rectangle {
      required property int index
      required property real modelData

      readonly property var geometry: Vis.barGeometry(
        root.base, modelData, root.height, root.minBar, root.devicePixelRatio)

      x: root.barX(index)
      // Sits at the far end of where the bar would reach, which is what makes
      // it read as a high-water mark rather than as another bar.
      y: root.base === "top" ? geometry.height : geometry.y - root.minBar
      width: root.drawWidth
      height: root.minBar
      radius: root.cap === "round" ? height / 2 : 0
      color: root.colorAt(index, modelData)
      opacity: 0.75
      visible: root.base !== "mirror"
    }
  }

  // ------------------------------------------------------- radial bars

  Repeater {
    model: root.radial ? root.frame : []

    Item {
      required property int index
      required property real modelData

      readonly property var arc: Vis.radialBar(index, root.count, modelData, {
        spread: root.spread,
        innerRadius: root.innerRadius,
        outerRadius: 1
      })
      readonly property real radius: Math.min(root.width, root.height) / 2

      // The bar is drawn straight up from the centre and the whole item is
      // rotated into place: one rotation per bar instead of trigonometry per
      // frame, and the cap and gradient work unchanged.
      x: root.width / 2
      y: root.height / 2
      width: 0
      height: 0
      rotation: arc.angle * 360

      Rectangle {
        x: -root.drawWidth / 2
        y: -parent.radius * parent.arc.outer
        width: root.drawWidth
        height: Math.max(root.minBar, parent.radius * (parent.arc.outer - parent.arc.inner))
        radius: root.cap === "round" ? width / 2 : 0
        color: root.colorAt(parent.index, parent.modelData)
      }
    }
  }

  // -------------------------------------------------------- wave under

  Canvas {
    id: wave
    anchors.fill: parent
    visible: root.showWave && root.count > 0
    renderStrategy: Canvas.Cooperative

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      if (root.count === 0) return

      var points = Vis.wavePoints(root.frame)
      ctx.beginPath()
      for (var i = 0; i < points.length; i++) {
        var x = points[i].x * width
        var y = points[i].y * height
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }

      ctx.strokeStyle = root.colorAt(Math.floor(root.count / 2), 60)
      ctx.lineWidth = Math.max(1, root.barWidth / 2)
      ctx.lineJoin = "round"
      ctx.globalAlpha = 0.55
      ctx.stroke()
    }
  }

  // The canvas repaints only when the frame changes, so the one expensive part
  // costs the frame rate rather than the compositor's.
  onFrameChanged: if (root.showWave) wave.requestPaint()
}
