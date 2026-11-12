import { sceneViewBox } from "./park-layout";
import { useId, type CSSProperties } from "react";

// Each face is anchored to a screen in the image. Local coordinates are 100 x 30.
const displays = [
  { id: "control", x: 842, y: 216, w: 63, h: 16, skew: -0.055 },
  { id: "monitor", x: 1015, y: 666, w: 183, h: 24, skew: -0.07 },
  ...[
    [410, 744],
    [490, 737],
    [570, 733],
    [646, 728],
  ].map(([x, y]) => ({ id: "runtime", x, y, w: 45, h: 16, skew: -0.065 })),
  { id: "quality", x: 1298, y: 445, w: 28, h: 13, skew: -0.075 },
] as const;
type Load = {
  control: boolean;
  runtime: boolean;
  line: boolean;
  quality: boolean;
  monitor: boolean;
};
export function ParkLights({ load }: { load: Load }) {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  return (
    <svg
      className="fc-illum"
      viewBox={sceneViewBox}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={uid + "halo"}>
          <stop stopColor="#adfff2" stopOpacity=".92" />
          <stop offset=".32" stopColor="#43fff0" stopOpacity=".6" />
          <stop offset="1" stopColor="#09f5ed" stopOpacity="0" />
        </radialGradient>
      </defs>
      {displays.map((s, i) => (
        <g
          key={i}
          data-equipment={s.id}
          data-loaded={load[s.id as keyof Load]}
          className="fc-display"
          style={{ "--phase": -i * 0.91 + "s" } as CSSProperties}
          transform={`matrix(${s.w / 100} ${(s.skew * s.w) / 100} 0 ${s.h / 30} ${s.x} ${s.y})`}
        >
          <ellipse
            className="fc-aura"
            cx="50"
            cy="14"
            rx="75"
            ry="43"
            fill={`url(#${uid}halo)`}
          />
          <rect width="100" height="30" rx="3" className="fc-face" />
          {Array.from({ length: s.id === "runtime" ? 6 : 10 }, (_, n) => (
            <rect
              className="fc-level"
              key={n}
              x={4 + n * (s.id === "runtime" ? 14 : 9)}
              y={7 + (n % 3) * 3}
              width={s.id === "runtime" ? 8 : 3}
              height={17 - (n % 3) * 3}
              style={{ animationDelay: -0.37 * n - 0.52 * i + "s" }}
            />
          ))}
          <path className="fc-readout" d="M1 26h98" />
          <circle className="fc-pilot" cx="93" cy="5" r="2.7" />
        </g>
      ))}
      <g className={"fc-equipment-dots" + (load.line ? " loaded" : "")}>
        {[
          [663, 488],
          [805, 479],
          [937, 469],
          [1072, 462],
        ].map(([x, y], i) => (
          <g
            transform={`translate(${x} ${y})`}
            style={{ "--phase": -i * 0.6 + "s" } as CSSProperties}
            key={x}
          >
            <circle className="fc-pilot" r="5.8" fill="#6effc8" opacity=".55" />
            <circle r="2.2" fill="#edfff5" />
          </g>
        ))}
      </g>
    </svg>
  );
}
