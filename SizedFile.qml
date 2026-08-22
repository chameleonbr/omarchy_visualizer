// A FileView that stats before it reads.
//
// `preload: false` is what makes the gate real: FileView only reads when it
// is asked to, so not calling reload() is not reading. Every load — the
// first one and every one a watched change asks for — goes through a probe
// that refuses anything that is not a regular file of at most `maxBytes`.
// Over the ceiling the last good text stands and nothing is allocated.

import QtQuick
import Quickshell.Io
import "Visualizer.js" as Vis

Item {
  id: root

  property alias path: file.path
  property int maxBytes: Vis.MAX_CONFIG_BYTES

  // False until a probe has passed. FileView reads on demand, so leaving
  // preload off is what keeps the file unread — the flag is the gate, not a
  // note about one.
  property bool allowed: false

  signal fileLoaded(string text)

  function text() { return file.text() }
  function setText(value) { file.setText(value) }

  // Changes arrive in bursts — an editor writing, then truncating, then
  // writing again — so a probe already in flight queues one rerun rather
  // than spawning one process per notification.
  function probe() {
    if (!file.path) return
    if (probeProcess.running) { probeProcess.queued = true; return }
    probeProcess.running = true
  }

  onPathChanged: probe()

  FileView {
    id: file
    preload: root.allowed
    watchChanges: true
    printErrors: false
    onFileChanged: root.probe()
    onLoaded: root.fileLoaded(file.text())
  }

  Process {
    id: probeProcess
    property bool queued: false
    command: Vis.sizeProbeCommand(file.path, root.maxBytes)
    onExited: function(code) {
      // The first pass opens the gate, which is itself the read. After that
      // the gate is already open and a re-read has to be asked for.
      if (code === 0) {
        if (root.allowed) file.reload()
        else root.allowed = true
      }
      if (queued) { queued = false; running = true }
    }
  }
}
