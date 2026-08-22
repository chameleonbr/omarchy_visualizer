// The drawing. Five shapes over one frame of numbers.
//
// Four of them are a Repeater of Rectangles, which for N <= 24 costs far less
// than a Canvas. `wave` is the only one that needs a Canvas, and that is why it
// is opt-in rather than the default.

import QtQuick
import qs.Commons
import "Visualizer.js" as Vis

Item {
  id: root

  property var frame: []
  property string shape: "bars"
  property string palette: "accent"
  property var paletteContext: ({})
  property int barWidth: 3
  property int segments: 8
  property real gap: 2

  readonly property int count: frame.length
  readonly property real pitch: count > 0 ? width / count : 0
  readonly property real drawWidth: Math.max(1, Math.min(barWidth, pitch - gap))

  function colorAt(index, value) {
    var c = Vis.paletteColor(root.palette, index, root.count, value, root.paletteContext)
    return Qt.rgba(c.r, c.g, c.b, 1)
  }

  function heightAt(value) {
    return Math.max(1, (value / 100) * height)
  }

  // ------------------------------------------------------------ bars

  Repeater {
    model: root.shape === "bars" || root.shape === "dots" ? root.frame : []

    Rectangle {
      required property int index
      required property real modelData

      readonly property real barHeight: root.shape === "dots"
        ? root.drawWidth : root.heightAt(modelData)

      x: index * root.pitch + (root.pitch - root.drawWidth) / 2
      // dots ride the value instead of growing from the floor, which is what
      // makes them the quiet option.
      y: root.shape === "dots"
        ? (root.height - barHeight) * (1 - modelData / 100)
        : root.height - barHeight
      width: root.drawWidth
      height: barHeight
      radius: root.shape === "dots" ? width / 2 : (width > 4 ? 1 : 0)
      color: root.colorAt(index, modelData)
    }
  }

  // ---------------------------------------------------------- mirror

  Repeater {
    model: root.shape === "mirror" ? root.frame : []

    Item {
      required property int index
      required property real modelData

      readonly property real half: Math.max(1, root.heightAt(modelData) / 2)

      x: index * root.pitch + (root.pitch - root.drawWidth) / 2
      y: 0
      width: root.drawWidth
      height: root.height

      Rectangle {
        x: 0
        y: parent.height / 2 - parent.half
        width: parent.width
        height: parent.half * 2
        radius: width > 4 ? 1 : 0
        color: root.colorAt(parent.index, parent.modelData)
      }
    }
  }

  // ---------------------------------------------------------- blocks

  Repeater {
    model: root.shape === "blocks" ? root.frame : []

    Item {
      id: column
      required property int index
      required property real modelData

      readonly property int lit: Vis.litSegments(modelData, root.segments)
      readonly property real segmentHeight:
        Math.max(1, (root.height - root.gap * (root.segments - 1)) / root.segments)
      readonly property color tint: root.colorAt(index, modelData)

      x: index * root.pitch + (root.pitch - root.drawWidth) / 2
      y: 0
      width: root.drawWidth
      height: root.height

      Repeater {
        model: root.segments

        Rectangle {
          required property int index
          readonly property int segment: index

          // Positioned rather than stacked in a Column: the segments count from
          // the bottom and a Column lays out from the top, and reconciling the
          // two through parent chains was where this first broke.
          y: column.height - (segment + 1) * column.segmentHeight - segment * root.gap
          width: column.width
          height: column.segmentHeight
          color: column.tint
          // An unlit segment stays faintly drawn so the column keeps its shape
          // and the whole thing reads as a meter rather than as loose blocks.
          opacity: segment < column.lit ? 1 : 0.12
        }
      }
    }
  }

  // ------------------------------------------------------------ wave

  Canvas {
    id: wave
    anchors.fill: parent
    visible: root.shape === "wave"
    renderStrategy: Canvas.Cooperative

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      if (root.count === 0) return

      var points = Vis.wavePoints(root.frame)
      var color = root.colorAt(Math.floor(root.count / 2), 50)

      ctx.beginPath()
      for (var i = 0; i < points.length; i++) {
        var x = points[i].x * width
        var y = points[i].y * height
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }

      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, root.barWidth / 2)
      ctx.lineJoin = "round"
      ctx.stroke()
    }
  }

  // The Canvas only repaints when told, which is what keeps the cost of the
  // one expensive shape proportional to the frame rate rather than to the
  // compositor's.
  onFrameChanged: if (root.shape === "wave") wave.requestPaint()
}
