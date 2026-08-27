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

  // The WLED rows join the list only when the WLED plugin's config names a
  // light, on the same principle as the colour rows: a control that cannot
  // change anything is worse than an absent one.
  readonly property var wledNames: service ? service.wledNames : []
  // Only under `params`: the row names sliders of the light's own effect, and
  // no other style touches them.
  readonly property var wledKnobLabels:
    service && service.value("wledStyle") === "params" ? service.wledKnobLabels : []
  readonly property var micNames: service ? service.micNames : []
  readonly property string input: service ? service.value("input") : "system"

  readonly property var rows: {
    var out = Vis.SETTING_ROWS
    // Same principle: offered only when the input uses a microphone at all, and
    // only when there is something to pick besides the system default.
    if (root.input !== "system" && root.micNames.length > 0)
      out = out.concat(Vis.micRows(root.micNames))
    if (root.wledNames.length > 0) out = out.concat(Vis.wledRows(root.wledNames))
    out = out.concat(Vis.wledKnobRows(root.wledKnobLabels))
    return out
  }

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

  // The label with its accelerator painted in the accent colour.
  //
  // `Vis.toHex` rather than the colour itself: a QML color stringifies to
  // `#aarrggbb`, and rich text silently ignores an eight-digit colour — the
  // letter comes out the same grey as the rest and the whole feature looks
  // like it was never wired up.
  //
  // Escaped first: StyledText would read a `<` in a translation as a tag.
  readonly property string accentHex: Vis.toHex(Color.accent)

  function accelLabel(key, accel) {
    var parts = Vis.splitAccel(root.tr(key), accel)
    return escapeMarkup(parts.before)
      + "<font color=\"" + root.accentHex + "\"><b>" + escapeMarkup(parts.letter) + "</b></font>"
      + escapeMarkup(parts.after)
  }

  function escapeMarkup(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  // Cycling from the keyboard rather than the mouse. Shift walks back, which
  // matters on a nine-value axis like the palette.
  function cycleSetting(row, backwards) {
    if (!root.service) return
    root.set(row.key, Vis.cycle(row.values, root.service.value(row.key), backwards ? -1 : 1))
  }

  // Letters are resolved against the rows on screen, so `d` does nothing at
  // all on a machine with no lights rather than quietly flipping a setting
  // nobody can see. Answers whether it handled the key.
  function cycleAccel(typed, backwards) {
    var row = Vis.rowForAccel(typed, root.rows)
    if (!row) return false
    cycleSetting(row, backwards)
    return true
  }

  // Which colour row a digit opens. The list is whatever the current palette
  // reads, so `1` is the first one on screen rather than a fixed setting.
  function openColorAt(index) {
    var keys = root.colorKeys
    if (index < 0 || index >= keys.length) return
    root.editing = root.editing === keys[index] ? "" : keys[index]
  }

  signal closeRequested()
  // The pane is done with the keyboard: whoever handles the accelerators
  // should take it back.
  signal focusReturned()

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
        model: root.rows

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

            // The accelerator is one letter of the label in the accent
            // colour. StyledText rather than three Text items so it elides as
            // one string when the pane is narrow.
            Text {
              textFormat: Text.StyledText
              text: root.accelLabel("row." + modelData.key, modelData.accel)
              color: Qt.darker(Color.foreground, 1.4)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              width: parent.width - Style.space(110)
              elide: Text.ElideRight
            }

            Text {
              // Plain, not AutoText: a value can be a name someone typed into
              // another plugin's config, and AutoText would sniff it for
              // markup and render whatever it found.
              textFormat: Text.PlainText
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

          readonly property int digit: root.colorKeys.indexOf(modelData)
          readonly property string label: root.accelLabel("row." + modelData,
            Vis.COLOR_ACCELS[digit] || "")
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
                textFormat: Text.StyledText
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
                textFormat: Text.PlainText
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
            onDismissed: root.focusReturned()
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
