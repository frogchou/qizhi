import { useId, type CSSProperties } from "react";
import { sceneViewBox, lots, feeds, reports, routes } from "./park-layout";
import {
  statusName,
  steps,
  type Area,
  type Job,
  type World,
} from "./simulation";
import "./valley.css";

// Local water patches keep moving caustics out of the reeds, bridge and boardwalk.
const pools = [
  "M112 109 Q175 82 229 100 Q268 122 220 154 Q176 181 94 193 L24 202 Q132 168 162 141 Q185 118 112 109Z",
  "M4 212 Q67 193 115 188 Q135 192 112 216 L64 246 Q31 240 4 255Z",
  "M134 266 Q189 272 165 311 L116 341 Q87 347 38 338 L66 322 Q136 320 134 266Z",
  "M5 373 Q58 353 115 350 L98 381 Q87 412 130 436 L124 451 Q83 446 40 457 Q9 460 1 470Z",
  "M4 500 Q35 492 66 493 Q60 531 91 542 Q128 559 142 592 L145 624 Q92 599 47 589 L5 576Z",
  "M91 717 Q152 682 198 712 Q219 741 232 763 L232 784 Q197 757 148 758 L93 754Z",
  "M78 765 Q131 754 183 774 Q244 795 259 827 L276 856 L196 856 Q167 824 111 824 L63 808Z",
];
const graph = [
  [0, -82],
  [-39, -57],
  [36, -52],
  [-61, -31],
  [-20, -34],
  [16, -25],
  [58, -30],
];
const links = [
  [0, 1],
  [0, 2],
  [1, 3],
  [1, 4],
  [2, 5],
  [2, 6],
];
export function ValleyEnvironment({ planning }: { planning: boolean }) {
  const clip = useId().replace(/[^\w-]/g, "");
  return (
    <svg
      className="eco-environment"
      viewBox={sceneViewBox}
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <defs>
        <clipPath id={clip}>
          {pools.map((d) => (
            <path key={d} d={d} />
          ))}
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`} data-layer="river">
        {Array.from({ length: 50 }, (_, i) => {
          const x = (i * 73) % 263,
            y = 95 + ((i * 59) % 766);
          return (
            <path
              key={i}
              className="eco-ripple"
              d={`M${x - 55} ${y} q15 -4 28 0 t31 0 t26 -2`}
              style={{
                animationDelay: (-i % 11) + "s",
                animationDuration: 9 + (i % 5) + "s",
              }}
            />
          );
        })}
      </g>
      <g
        transform="translate(929 150)"
        data-layer="hologram"
        data-planning={planning}
        className="eco-graph"
      >
        <ellipse className="eco-orbit" cx="0" cy="-39" rx="77" ry="20" />
        <path
          className="eco-cone"
          d="M-74 -39 L0 0 75 -39 M-27 -29 0 0 31 -29"
        />
        {links.map(([a, b]) => (
          <path
            className="eco-link"
            key={a + "-" + b}
            d={`M${graph[a].join(" ")} L${graph[b].join(" ")}`}
          />
        ))}
        {graph.map(([cx, cy], i) => (
          <circle
            key={i}
            className="eco-node"
            cx={cx}
            cy={cy}
            r={i === 0 ? 5 : 3.8}
            style={{ animationDelay: -i * 0.3 + "s" }}
          />
        ))}
      </g>
    </svg>
  );
}

const colors = {
  task: "#008479",
  asset: "#265dba",
  power: "#cf8d16",
  monitor: "#8154a8",
};
type Stream = { d: string; kind: keyof typeof colors; live: boolean };
export function ValleyActivity({
  world,
  watches,
  speed,
  hover,
}: {
  world: World;
  watches: Job[];
  speed: number;
  hover: Area | null;
}) {
  const uid = useId().replace(/[^\w-]/g, "");
  const active = watches.filter((j) => j.status === "working");
  const events = watches
    .flatMap((j) => j.events.map((e, i) => ({ ...e, id: j.id, seq: i })))
    .filter((e) => world.time - e.at < 5 && e.area !== hover)
    .sort((a, b) => b.at - a.at || b.seq - a.seq);
  const seen = new Set<Area>();
  const notes = events
    .filter((e) => {
      if (seen.has(e.area)) return false;
      seen.add(e.area);
      return true;
    })
    .slice(0, 2);
  const streams: Stream[] = routes.map((d, i) => ({
    d,
    kind: i === 2 || i === 3 ? "asset" : "task",
    live:
      active.some((j) => j.step === i) ||
      (i === 5 &&
        watches.some((j) => j.status === "done" && world.time - j.entered < 3)),
  }));
  for (const r of reports)
    streams.push({
      d: r.d,
      kind: "monitor",
      live: active.some(
        (j) => steps[j.step].area === r.area && world.time - j.beat <= 1,
      ),
    });
  streams.push(
    {
      d: feeds.line,
      kind: "power",
      live: active.some((j) => j.step === 3 || j.step === 4),
    },
    { d: feeds.control, kind: "power", live: active.some((j) => j.step === 1) },
  );
  const period =
    2.5 / ((1 + 0.27 * Math.min(4, active.length)) * Math.sqrt(speed || 1));
  return (
    <>
      <svg
        className="eco-flows"
        viewBox={sceneViewBox}
        aria-hidden="true"
        preserveAspectRatio="none"
      >
        <defs>
          {Object.entries(colors).map(([kind, color]) => (
            <marker
              key={kind}
              id={uid + kind}
              markerWidth="3.5"
              markerHeight="3.5"
              refX="3"
              refY="2"
              orient="auto"
            >
              <path d="M0 0 4 2 0 4 1 2Z" fill={color} />
            </marker>
          ))}
        </defs>
        {streams.map((s, i) => (
          <g
            key={s.d}
            data-flow={s.live ? "live" : "idle"}
            data-kind={s.kind}
            style={
              {
                "--flow": colors[s.kind],
                "--period": period + "s",
                "--offset": -i * 0.2 + "s",
              } as CSSProperties
            }
          >
            <path className="eco-guide" d={s.d} />
            {s.live && (
              <>
                <path
                  className="eco-core"
                  d={s.d}
                  markerEnd={`url(#${uid + s.kind})`}
                />
                <path className="eco-packets" d={s.d} />
              </>
            )}
          </g>
        ))}
      </svg>
      <div className="eco-notes" aria-hidden="true">
        {notes.map((e) => {
          const [, y, , h, x] = lots[e.area];
          return (
            <div
              className={"eco-note " + e.status}
              key={e.id + "-" + e.at + "-" + e.seq}
              data-age={world.time - e.at}
              style={{
                left: `clamp(82px,${x}%,calc(100% - 82px))`,
                top: (y < 58 ? y + h + 1 : y - 4) + "%",
              }}
            >
              <small>
                #{e.id} · {statusName[e.status]}
              </small>
              <strong>{e.message}</strong>
            </div>
          );
        })}
      </div>
    </>
  );
}
