/*
canvas.mjs - <short description TODO>
Copyright (C) 2022 Strudel contributors - see <https://github.com/tidalcycles/strudel/blob/main/packages/canvas/canvas.mjs>
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import ml5 from 'ml5';
import { Pattern, noteToMidi, freqToMidi, isPattern, set } from '@strudel/core';
import { getTheme, getDrawContext } from './draw.mjs';

const scale = (normalized, min, max) => normalized * (max - min) + min;
const getValue = (e) => {
  let { value } = e;
  if (typeof e.value !== 'object') {
    value = { value };
  }
  let { note, n, freq, s } = value;
  if (freq) {
    return freqToMidi(freq);
  }
  note = note ?? n;
  if (typeof note === 'string') {
    try {
      // TODO: n(run(32)).scale("D:minor") fails when trying to query negative time..
      return noteToMidi(note);
    } catch (err) {
      // console.warn(`error converting note to midi: ${err}`); // this spams to crazy
      return 0;
    }
  }
  if (typeof note === 'number') {
    return note;
  }
  if (s) {
    return '_' + s;
  }
  return value;
};

/**
 * Visualises a pattern as a scrolling 'canvas', displayed in the background of the editor. To show a canvas for all running patterns, use `all(canvas)`. To have a canvas appear below
 * a pattern instead, prefix with `_`, e.g.: `sound("bd sd").canvas()`.
 *
 * @name canvas
 * @synonyms punchcard
 * @param {Object} options Object containing all the optional following parameters as key value pairs:
 * @param {integer} cycles number of cycles to be displayed at the same time - defaults to 4
 * @param {number} playhead location of the active notes on the time axis - 0 to 1, defaults to 0.5
 * @param {boolean} vertical displays the roll vertically - 0 by default
 * @param {boolean} labels displays labels on individual notes (see the label function) - 0 by default
 * @param {boolean} flipTime reverse the direction of the roll - 0 by default
 * @param {boolean} flipValues reverse the relative location of notes on the value axis - 0 by default
 * @param {number} overscan lookup X cycles outside of the cycles window to display notes in advance - 1 by default
 * @param {boolean} hideNegative hide notes with negative time (before starting playing the pattern) - 0 by default
 * @param {boolean} smear notes leave a solid trace - 0 by default
 * @param {boolean} fold notes takes the full value axis width - 0 by default
 * @param {string} active hexadecimal or CSS color of the active notes - defaults to #FFCA28
 * @param {string} inactive hexadecimal or CSS color of the inactive notes - defaults to #7491D2
 * @param {string} background hexadecimal or CSS color of the background - defaults to transparent
 * @param {string} playheadColor hexadecimal or CSS color of the line representing the play head - defaults to white
 * @param {boolean} fill notes are filled with color (otherwise only the label is displayed) - 0 by default
 * @param {boolean} fillActive active notes are filled with color - 0 by default
 * @param {boolean} stroke notes are shown with colored borders - 0 by default
 * @param {boolean} strokeActive active notes are shown with colored borders - 0 by default
 * @param {boolean} hideInactive only active notes are shown - 0 by default
 * @param {boolean} colorizeInactive use note color for inactive notes - 1 by default
 * @param {string} fontFamily define the font used by notes labels - defaults to 'monospace'
 * @param {integer} minMidi minimum note value to display on the value axis - defaults to 10
 * @param {integer} maxMidi maximum note value to display on the value axis - defaults to 90
 * @param {boolean} autorange automatically calculate the minMidi and maxMidi parameters - 0 by default
 * @see canvas
 */

Pattern.prototype.canvas = function (options = {}) {
  let { cycles = 4, playhead = 0.5, overscan = 0, hideNegative = false, ctx = getDrawContext(), id = 1 } = options;

  let from = -cycles * playhead;
  let to = cycles * (1 - playhead);
  const inFrame = (hap, t) => (!hideNegative || hap.whole.begin >= 0) && hap.isWithinTime(t + from, t + to);
  this.draw(
    (haps, time) => {
      _canvas({
        ...options,
        time,
        ctx,
        haps: haps.filter((hap) => inFrame(hap, time)),
      });
    },
    {
      lookbehind: from - overscan,
      lookahead: to + overscan,
      id,
    },
  );
  return this;
};

export function canvas(arg) {
  if (isPattern(arg)) {
    // Single argument as a pattern
    // (to support `all(canvas)`)
    return arg.canvas();
  }
  // Single argument with option - return function to get the pattern
  // (to support `all(canvas(options))`)
  return (pat) => pat.canvas(arg);
}

let webcamVideo = null;
let webcamStream = null;
let webcamReady = false;
let webcamDrawLoopStarted = false;
let detectedHands = [];
let handposeModel = null;

async function setupHandPose(video) {
  if (!handposeModel) {
    // If using npm import, ml5 is imported at the top
    // If using CDN, ml5 is global
    handposeModel = await ml5.handPose(video, { flipped: false });
    while (!handposeModel.model) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    handposeModel.detectStart(video, (results) => {
      detectedHands = results;
    });
  }
}

export async function _canvas({ ctx, ...options } = {}) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // Only request webcam and create video once
  if (!webcamVideo) {
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
      webcamVideo = document.createElement('video');
      webcamVideo.srcObject = webcamStream;
      webcamVideo.autoplay = true;
      webcamVideo.playsInline = true;
      webcamVideo.addEventListener('loadedmetadata', () => {
        webcamReady = true;
      });
    } catch (err) {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'white';
      ctx.font = '16px monospace';
      ctx.fillText('Webcam permission denied', 10, 30);
      console.error('Webcam access error:', err);
      return;
    }
  }

  // Start the draw loop only once
  if (!webcamDrawLoopStarted) {
    webcamDrawLoopStarted = true;

    // Setup handpose model once video is ready
    if (webcamVideo) {
      console.log('Setting up handpose model...');
      setupHandPose(ctx.canvas);
    }
    // MediaPipe-style hand landmark connections
    const handConnections = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4], // Thumb
      [5, 6],
      [6, 7],
      [7, 8], // Index
      [9, 10],
      [10, 11],
      [11, 12], // Middle
      [13, 14],
      [14, 15],
      [15, 16], // Ring
      [17, 18],
      [18, 19],
      [19, 20], // Pinky
      [0, 5],
      [5, 9],
      [9, 13],
      [13, 17],
      [17, 0], // Palm
    ];

    function drawFrame() {
      if (webcamReady) {
        ctx.drawImage(webcamVideo, 0, 0, w, h);

        if (detectedHands.length > 0) {
          for (const hand of detectedHands) {
            if (hand.confidence > 0.8) {
              const keypoints = hand.keypoints;

              // Set color based on handedness
              ctx.lineWidth = 5;
              ctx.strokeStyle =
                hand.handedness === 'Left'
                  ? 'rgb(255, 0, 255)' // Magenta
                  : 'rgb(255, 255, 0)'; // Yellow

              // Draw connections
              ctx.beginPath();
              for (const [startIdx, endIdx] of handConnections) {
                const start = keypoints[startIdx];
                const end = keypoints[endIdx];
                if (start && end) {
                  ctx.moveTo(start.x, start.y);
                  ctx.lineTo(end.x, end.y);
                }
              }
              ctx.stroke();

              // === Draw thumb to index distance ===
              const thumbTip = keypoints[4];
              const indexTip = keypoints[8];

              if (thumbTip && indexTip) {
                // Draw line between fingertips
                ctx.strokeStyle = 'cyan';
                ctx.beginPath();
                ctx.moveTo(thumbTip.x, thumbTip.y);
                ctx.lineTo(indexTip.x, indexTip.y);
                ctx.stroke();

                // Compute distance
                const dx = indexTip.x - thumbTip.x;
                const dy = indexTip.y - thumbTip.y;
                const distance = Math.sqrt(dx * dx + dy * dy).toFixed(1);

                // Draw distance text at midpoint
                const midX = (thumbTip.x + indexTip.x) / 2;
                const midY = (thumbTip.y + indexTip.y) / 2;

                ctx.fillStyle = 'cyan';
                ctx.font = '16px sans-serif';
                ctx.fillText(`${distance}px`, midX + 5, midY - 5);
                if (options.callback) {
                  options.callback(distance, hand);
                }
              }
            }
          }
        }
      }

      requestAnimationFrame(drawFrame);
    }
    drawFrame();
  }
}

export function getDrawOptions(drawTime, options = {}) {
  let [lookbehind, lookahead] = drawTime;
  lookbehind = Math.abs(lookbehind);
  const cycles = lookahead + lookbehind;
  const playhead = cycles !== 0 ? lookbehind / cycles : 0;
  return { fold: 1, ...options, cycles, playhead };
}

export const getCanvasPainter =
  (options = {}) =>
  (ctx, time, haps, drawTime) =>
    _canvas({ ctx, time, haps, ...getDrawOptions(drawTime, options) });

Pattern.prototype.punchcard = function (options) {
  return this.onPaint(getCanvasPainter(options));
};

/**
 * Displays a vertical canvas with event labels.
 * Supports all the same options as canvas.
 *
 * @name wordfall
 */
Pattern.prototype.wordfall = function (options) {
  return this.punchcard({ vertical: 1, labels: 1, stroke: 0, fillActive: 1, active: 'white', ...options });
};

/* Pattern.prototype.canvas = function (options) {
  return this.onPaint((ctx, time, haps, drawTime) =>
    canvas({ ctx, time, haps, ...getDrawOptions(drawTime, { fold: 0, ...options }) }),
  );
}; */

export function drawcanvas(options) {
  const { drawTime, ...rest } = options;
  _canvas({ ...getDrawOptions(drawTime), ...rest });
}
