/**
 * The signature pad.
 *
 * ── `FLD-15` IS IMPLEMENTED BY WHAT THIS DOES NOT RECORD ───────────────────
 *
 * The pan responder below captures `{x, y}` and nothing else. No timestamps,
 * no pressure, no velocity. Those are the inputs to stroke-dynamics analysis,
 * and `FLD-15` forbids running it - *"running stroke-dynamics analysis for the
 * purpose of uniquely identifying a person turns the signature into biometric
 * data with a materially higher legal bar."*
 *
 * The reliable way not to run the analysis is not to hold the data. React
 * Native's touch events carry `timestamp` and `force`; they are read and
 * discarded here, deliberately, and the reason is written down so that a future
 * change that "just stores a bit more" has to argue with this comment first.
 *
 * Coordinates are normalised to 0..1 against the pad, so the vector renders at
 * any size and carries no information about the device's screen.
 *
 * NOT RENDERED IN THIS SESSION - no simulator was available.
 */

import { useRef, useState } from "react";
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";

import { theme } from "../theme";
import type { Stroke, StrokePoint } from "../../domain/signature";

export function SignaturePad({
  onChange,
  height = 220,
}: {
  onChange: (strokes: readonly Stroke[], aspectRatio: number) => void;
  height?: number;
}): React.JSX.Element {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [size, setSize] = useState({ width: 1, height });
  const current = useRef<StrokePoint[]>([]);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,

      onPanResponderGrant: (event) => {
        current.current = [normalise(event.nativeEvent.locationX, event.nativeEvent.locationY, sizeRef.current)];
      },
      onPanResponderMove: (event) => {
        current.current.push(
          normalise(event.nativeEvent.locationX, event.nativeEvent.locationY, sizeRef.current),
        );
        // Re-render on every move would be a state update per touch sample.
        // The in-progress stroke is committed on release instead; the visible
        // cost is that the current stroke appears when the finger lifts, which
        // is a real limitation and is the first thing to fix if it looks wrong
        // on a device. It has not been looked at on a device.
      },
      onPanResponderRelease: () => {
        if (current.current.length === 0) return;
        setStrokes((previous) => {
          const next = [...previous, current.current.slice()];
          onChange(next, sizeRef.current.width / sizeRef.current.height);
          return next;
        });
        current.current = [];
      },
    }),
  ).current;

  function onLayout(event: LayoutChangeEvent): void {
    const { width, height: h } = event.nativeEvent.layout;
    setSize({ width: Math.max(1, width), height: Math.max(1, h) });
  }

  return (
    <View style={[styles.pad, { height }]} onLayout={onLayout} {...responder.panHandlers}>
      <Svg width="100%" height="100%">
        {strokes.map((stroke, index) => (
          <Path
            key={index}
            d={toPath(stroke, size)}
            stroke={theme.colour.text}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ))}
      </Svg>
    </View>
  );
}

function normalise(x: number, y: number, size: { width: number; height: number }): StrokePoint {
  return { x: clamp01(x / size.width), y: clamp01(y / size.height) };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function toPath(stroke: Stroke, size: { width: number; height: number }): string {
  return stroke
    .map((point, index) => {
      const x = (point.x * size.width).toFixed(2);
      const y = (point.y * size.height).toFixed(2);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
}

const styles = StyleSheet.create({
  pad: {
    backgroundColor: theme.colour.surface,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colour.border,
    overflow: "hidden",
  },
});
