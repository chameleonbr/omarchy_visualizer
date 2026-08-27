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
import QtQuick.Shapes
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
  //
  // COUNT, never the frame itself. A Repeater given a JS array does not diff
  // it: a new array is a reset, so every delegate is destroyed and rebuilt.
  // Thirty frames a second of fourteen columns of eight blocks, on three
  // monitors, is ten thousand Rectangles created per second and it cost most
  // of a core. The count only moves when `barCount` does, so the tree is built
  // once and the values arrive as property changes — which is what bindings
  // are for.

  Repeater {
    model: !root.radial && root.cap !== "segments" ? root.count : 0

    Rectangle {
      id: bar
      required property int index

      // Read inline rather than through a helper: the binding has to touch
      // `root.frame` itself to depend on it, and a short frame during a resize
      // must read as silence rather than as undefined.
      readonly property real value: {
        var v = root.frame[index]
        return v === undefined ? 0 : v
      }

      readonly property var geometry: Vis.barGeometry(
        root.base, value, root.height, root.minBar, root.devicePixelRatio)
      // `root.fill` is read here as well as inside gradientPair, so switching
      // the fill re-evaluates the pair. A function call is not a dependency.
      readonly property var pair: root.fill === root.fill
        ? root.gradientPair(index, value) : null

      x: root.barX(index)
      // Already on the device grid: barGeometry rounds the length once and
      // derives the position, so rounding again here would put the base back
      // on the loose footing this was fixing.
      y: geometry.y
      width: root.drawWidth
      height: geometry.height
      radius: root.cap === "round" ? Math.min(width, height) / 2 : 0
      color: root.fill === "solid" ? root.colorAt(index, value) : "transparent"

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
    model: !root.radial && root.cap === "segments" ? root.count : 0

    Item {
      id: column
      required property int index

      readonly property real value: {
        var v = root.frame[index]
        return v === undefined ? 0 : v
      }

      readonly property int lit: Vis.litSegments(value, root.segments)
      // Mirror splits the height between two columns of blocks, so the span
      // one column is laid out in is not always the widget's own height.
      readonly property real span: Vis.segmentSpan(root.base, root.height)
      readonly property real unit: Vis.floorToDevice(
        Math.max(1, (span - root.gap * (root.segments - 1)) / root.segments),
        root.devicePixelRatio)
      readonly property color tint: root.colorAt(index, value)

      x: root.barX(index)
      y: 0
      width: root.drawWidth
      height: root.height

      Repeater {
        model: Vis.segmentCount(root.base, root.segments)

        Rectangle {
          required property int index

          // Positioned rather than stacked: a Column lays out from the top and
          // the reconciliation is where this went wrong the first time. The
          // step is what decides whether a block is lit, and it is not the
          // index under `mirror` — the second half counts from the middle
          // again going the other way.
          readonly property var place: Vis.segmentGeometry(
            root.base, index, root.segments, column.unit, root.gap, column.height)

          x: 0
          y: place.y
          width: column.width
          height: column.unit
          radius: 0
          color: column.tint
          // Unlit segments stay faintly drawn so the column keeps its shape and
          // reads as a meter rather than as loose blocks.
          opacity: place.step < column.lit ? 1 : 0.1
        }
      }
    }
  }

  // ------------------------------------------------------ peak markers

  Repeater {
    model: root.showPeaks && !root.radial ? root.peaks.length : 0

    Rectangle {
      required property int index

      readonly property real value: {
        var v = root.peaks[index]
        return v === undefined ? 0 : v
      }

      readonly property var geometry: Vis.barGeometry(
        root.base, value, root.height, root.minBar, root.devicePixelRatio)

      x: root.barX(index)
      // Sits at the far end of where the bar would reach, which is what makes
      // it read as a high-water mark rather than as another bar.
      y: root.base === "top" ? geometry.height : geometry.y - root.minBar
      width: root.drawWidth
      height: root.minBar
      radius: root.cap === "round" ? height / 2 : 0
      color: root.colorAt(index, value)
      opacity: 0.75
      visible: root.base !== "mirror"
    }
  }

  // ------------------------------------------------------- radial bars

  Repeater {
    model: root.radial ? root.count : 0

    Item {
      required property int index

      readonly property real value: {
        var v = root.frame[index]
        return v === undefined ? 0 : v
      }

      readonly property var arc: Vis.radialBar(index, root.count, value, {
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
        color: root.colorAt(parent.index, parent.value)
      }
    }
  }

  // -------------------------------------------------------- wave under

  // A Shape, not a Canvas. `Canvas.Cooperative` paints on the GUI thread — the
  // same thread every binding in here runs on — into a software image that is
  // then uploaded. It was repainted once per frame, which the old comment
  // called "the frame rate rather than the compositor's" as though that were
  // cheap; on three monitors at thirty frames a second it was most of ten
  // points of a core. A ShapePath is tessellated on the render thread and
  // drawn by the GPU, and the only work left on this side is turning the frame
  // into a list of points.
  Shape {
    anchors.fill: parent
    visible: root.showWave && root.count > 0
    // Only while it is on screen: the geometry is rebuilt from a binding, and
    // a hidden Shape would still be rebuilding it thirty times a second.
    asynchronous: false

    ShapePath {
      strokeColor: Qt.alpha(root.colorAt(Math.floor(root.count / 2), 60), 0.55)
      strokeWidth: Math.max(1, root.barWidth / 2)
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      joinStyle: ShapePath.RoundJoin

      PathPolyline {
        // Reads `root.frame`, `width` and `height` in its own expression, so
        // it follows all three without anything having to ask it to.
        path: {
          if (!root.showWave || root.count === 0) return []
          var points = Vis.wavePoints(root.frame)
          var out = []
          for (var i = 0; i < points.length; i++) {
            out.push(Qt.point(points[i].x * root.width, points[i].y * root.height))
          }
          return out
        }
      }
    }
  }
}
