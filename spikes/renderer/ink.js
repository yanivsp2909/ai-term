import React from 'react';
import { Box, Text, render } from 'ink';
import { runs } from './screen.js';
export function inkFrame(grid) {
  return React.createElement(Box, { flexDirection: 'column', width: grid[0].length, height: grid.length },
    grid.map((row, y) => React.createElement(Box, { key: y, height: 1, flexShrink: 0 },
      runs(row).map((run, x) => React.createElement(Text, { key: x, color: run.fg, backgroundColor: run.bg, bold: run.bold, wrap: 'truncate' }, run.text)))));
}
export function startInk(grid) {
  return render(inkFrame(grid), { maxFps: 0, interactive: true, incrementalRendering: true, isScreenReaderEnabled: false, patchConsole: false, exitOnCtrlC: false, alternateScreen: false });
}
