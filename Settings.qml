// The settings, beside the spectrum rather than over it.
//
// Every row cycles on click — left forward, right back — because at this width
// a dropdown costs more than it gives, and there is no apply button: the
// visualiser next to the panel is the preview for every control in here.
//
// The colour rows only appear for the palettes that read a colour. Offering a
// picker that changes nothing is how a settings screen teaches people that its
// controls are decoration.

import QtQuick
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis
import "I18n.js" as I18n

Item {
  id: root

  property var widget: null
  readonly property var service: widget ? widget.service : null
  readonly property string palette: service ? service.value("palette") : "accent"
  readonly property var colorKeys: Vis.colorKeysFor(palette)

  property string editing: ""

  // `I18n.t()` is a function call, so nothing about it tells QML to
  // re-evaluate when the language changes. Reading the epoch first is what
  // makes these bindings depend on it.
  readonly property int languageEpoch: service ? service.languageEpoch : 0
  function tr(key) {
    var epoch = root.languageEpoch
    return I18n.t(key)
  }
  // A setting's value said in words: `mirror` reads as "espelho", `24` reads
  // as itself.
  function trValue(key, raw) {
    var epoch = root.languageEpoch
    return I18n.value(key, raw)
  }

  signal closeRequested()

  function set(key, value) {
    if (!service) return
    var patch = {}
    patch[key] = value
    service.save(patch)
  }

  Rectangle {
    anchors.fill: parent
    color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.04)
    radius: Style.space(6)
  }

  Flickable {
    id: flick
    anchors.fill: parent
    anchors.margins: Style.space(10)
    contentWidth: width
    contentHeight: column.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: flick.width
      spacing: Style.space(2)

      Text {
        text: root.tr("settings.title")
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.bold: true
        bottomPadding: Style.space(4)
      }

      Repeater {
        model: [
          // `key` is both the setting and the translation namespace: the row
          // label is `row.<key>` and each value is `<key>.<value>`. One name
          // rather than three keeps a new axis from arriving half-translated.
          { key: "base", values: Vis.BASES },
          { key: "cap", values: Vis.CAPS },
          { key: "fill", values: Vis.FILLS },
          { key: "palette", values: Vis.PALETTES },
          { key: "input", values: Vis.INPUTS },
          { key: "showPeaks", values: [false, true] },
          { key: "showWave", values: [false, true] },
          { key: "barCount", values: [8, 12, 14, 16, 20, 24] },
          { key: "smoothing", values: [0, 30, 60, 80, 95] },
          { key: "framerate", values: [15, 30, 45, 60] },
          { key: "language", values: Vis.LANGUAGES }
        ]

        Rectangle {
          required property var modelData

          readonly property var current: root.service
            ? root.service.value(modelData.key) : modelData.values[0]

          width: column.width
          height: cycleRow.implicitHeight + Style.space(8)
          radius: Style.space(3)
          color: hover.hovered
            ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.07)
            : "transparent"

          HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }

          TapHandler {
            acceptedButtons: Qt.LeftButton | Qt.RightButton
            onTapped: function(point, button) {
              root.set(modelData.key,
                Vis.cycle(modelData.values, current, button === Qt.RightButton ? -1 : 1))
            }
          }

          Row {
            id: cycleRow
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(6)
            anchors.rightMargin: Style.space(6)

            Text {
              text: root.tr("row." + modelData.key)
              color: Qt.darker(Color.foreground, 1.4)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              width: parent.width - Style.space(110)
              elide: Text.ElideRight
            }

            Text {
              text: root.trValue(modelData.key, parent.parent.current)
              color: Color.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignRight
              width: Style.space(104)
              elide: Text.ElideLeft
            }
          }
        }
      }

      // ------------------------------------------------------- colours

      Repeater {
        // Only what the current palette actually reads. A picker that changes
        // nothing teaches people the controls are decoration.
        model: root.colorKeys

        Column {
          required property string modelData

          readonly property string label: root.tr("row." + modelData)
          readonly property string value:
            root.service ? String(root.service.value(modelData) || "") : ""
          readonly property bool open: root.editing === modelData

          width: column.width
          spacing: Style.space(4)

          Rectangle {
            width: parent.width
            height: swatchRow.implicitHeight + Style.space(8)
            radius: Style.space(3)
            color: parent.open || swatchHover.hovered
              ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.07)
              : "transparent"

            HoverHandler { id: swatchHover; cursorShape: Qt.PointingHandCursor }
            TapHandler {
              onTapped: root.editing = parent.parent.open ? "" : parent.parent.modelData
            }

            Row {
              id: swatchRow
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              spacing: Style.space(6)

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: parent.parent.parent.label
                color: Qt.darker(Color.foreground, 1.4)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                width: parent.width - Style.space(90)
                elide: Text.ElideRight
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                // An empty setting says so rather than showing a swatch of the
                // colour it would fall back to, which would read as a choice
                // someone made.
                text: parent.parent.parent.value || root.tr("settings.themed")
                color: Qt.darker(Color.foreground, 1.6)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(18)
                height: Style.space(18)
                radius: Style.space(3)
                color: {
                  var parsed = Vis.parseHex(parent.parent.parent.value)
                  return parsed ? Qt.rgba(parsed.r, parsed.g, parsed.b, 1) : Color.accent
                }
                border.width: 1
                border.color: Color.popups.border
              }
            }
          }

          ColorPicker {
            width: parent.width
            visible: parent.open
            value: parent.value
            fallback: Color.accent
            onPicked: function(hex) { root.set(parent.modelData, hex) }
          }
        }
      }

      Text {
        topPadding: Style.space(8)
        width: column.width
        wrapMode: Text.WordWrap
        text: root.tr("settings.help")
        color: Qt.darker(Color.foreground, 1.9)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }
}
