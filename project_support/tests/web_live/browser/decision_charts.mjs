// The real charts, read from the copy the exporter writes, so the drawing is
// checked against what the engine actually describes rather than against a
// chart chosen for being easy to draw. A pytest asserts this file is current.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const CHARTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./decision_charts.json', import.meta.url)), 'utf-8'));
