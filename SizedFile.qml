// A file the long-lived shell reads, through a ceiling it cannot be argued
// out of.
//
// The obvious shape — stat in one process, open in another — is a race: the
// file that was measured and the file that gets opened need not be the same
// one, and a same-user writer only has to grow it in between. So the read is
// the ceiling. `Vis.readCappedCommand` asks for at most `maxBytes + 1` bytes
// and hands them back on stdout, which means the bytes that arrive are the
// bytes that were counted, whatever happened to the file in the meantime.
//
// FileView stays for the two things it is still good at — watching the path,
// and writing to it. Nothing here ever reads through it, which is why
// `preload` is off and `reload()` is never called.

import QtQuick
import Quickshell.Io
import "Visualizer.js" as Vis

Item {
  id: root

  property alias path: file.path
  property int maxBytes: Vis.MAX_CONFIG_BYTES

  signal fileLoaded(string text)

  function setText(value) { file.setText(value) }

  // Changes arrive in bursts — an editor writing, then truncating, then
  // writing again — so a read already in flight queues one rerun rather than
  // spawning one process per notification.
  function load() {
    if (!file.path) return
    if (reader.running) { reader.queued = true; return }
    reader.running = true
  }

  onPathChanged: load()

  FileView {
    id: file
    preload: false
    watchChanges: true
    printErrors: false
    onFileChanged: root.load()
  }

  Process {
    id: reader
    property bool queued: false
    command: Vis.readCappedCommand(file.path, root.maxBytes)
    stdout: StdioCollector { id: sink }
    onExited: function(code) {
      // One byte over is exactly what `head` was asked for, and it is the
      // proof the file did not fit. Refused rather than truncated: half a
      // JSON file is a corrupt one, and pretending otherwise would silently
      // reset every setting past the cut.
      if (code === 0 && sink.text.length <= root.maxBytes) root.fileLoaded(sink.text)
      if (queued) { queued = false; running = true }
    }
  }
}
