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
    var pair = Vis.barGradientPair(root.palette, index, root.count, value, root.paletteContext)
    return {
      base: Qt.rgba(pair.base.r, pair.base.g, pair.base.b, 1),
      tip: Qt.rgba(pair.tip.r, pair.tip.g, pair.tip.b, 1)
    }
  }

  // ------------------------------------------------------- linear bars

  Repeater {
    model: root.radial ? [] : root.frame

    Item {
      id: bar
      required property int index
      required property real modelData

      readonly property var geometry:
        Vis.barGeometry(root.base, modelData, root.height, root.minBar)
      readonly property var pair: root.gradientPair(index, modelData)

      x: root.barX(index)
      y: Vis.floorToDevice(geometry.y, root.devicePixelRatio)
      width: root.drawWidth
      height: Vis.floorToDevice(geometry.height, root.devicePixelRatio)

      // ---- flat and round caps

      Rectangle {
        anchors.fill: parent
        visible: root.cap !== "segments"
        // A round cap is the same rectangle with its corners taken off, which
        // costs nothing and is most of what makes the reference sheets look
        // designed rather than plotted.
        radius: root.cap === "round" ? Math.min(width, height) / 2 : 0
        color: root.fill === "solid" ? root.colorAt(bar.index, bar.modelData) : "transparent"

        // Declared once and referenced, never inlined into the binding: an
        // object declaration is not an expression in QML, and
        // `cond ? null : Gradient { … }` is a syntax error rather than a
        // conditional gradient.
        gradient: root.fill === "solid" ? null : barFill

        Gradient {
          id: barFill
          // Top to bottom, so the tip carries the current reading and the base
          // carries the resting colour: the bar says the same thing twice.
          GradientStop { position: 0; color: bar.pair.tip }
          GradientStop { position: 1; color: bar.pair.base }
        }
      }

      // ---- segmented cap

      Repeater {
        model: root.cap === "segments" ? root.segments : 0

        Rectangle {
          required property int index

          readonly property real unit:
            Math.max(1, (root.height - root.gap * (root.segments - 1)) / root.segments)
          readonly property int lit: Vis.litSegments(bar.modelData, root.segments)

          // Positioned from the bottom, because segments count up from the
          // floor and a Column lays out from the top.
          parent: bar.parent
          x: bar.x
          y: root.height - (index + 1) * unit - index * root.gap
          width: bar.width
          height: unit
          radius: root.cap === "round" ? width / 2 : 0
          color: root.colorAt(bar.index, bar.modelData)
          // Unlit segments stay faintly drawn so the column keeps its shape and
          // the whole thing reads as a meter rather than as loose blocks.
          opacity: index < lit ? 1 : 0.12
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

      readonly property var geometry:
        Vis.barGeometry(root.base, modelData, root.height, root.minBar)

      x: root.barX(index)
      // Sits at the far end of where the bar would reach, which is what makes
      // it read as a high-water mark rather than as another bar.
      y: root.base === "top"
        ? Vis.floorToDevice(geometry.height, root.devicePixelRatio)
        : Vis.floorToDevice(geometry.y - root.minBar, root.devicePixelRatio)
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
