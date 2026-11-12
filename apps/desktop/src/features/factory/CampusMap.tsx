import { useState, type CSSProperties } from "react";
import campus from "./river-valley.webp";
import { ValleyActivity, ValleyEnvironment } from "./ValleyScene";
import {
  areas,
  steps,
  statusName,
  usesArea,
  type Area,
  type Job,
  type World,
} from "./simulation";
import { Traffic } from "./Traffic";
import { ParkLights } from "./ParkLights";
import { lots } from "./park-layout";
import "./campus.css";

const knowledge = ["栖知产品", "项目档案", "供应商资料", "质量规范"];
const channels = ["邮件", "飞书", "微信", "UI"];
function extra(area: Area) {
  switch (area) {
    case "intake":
      return "接待窗口 · " + channels.join(" / ");
    case "assets":
      return knowledge.length + " 个模拟知识库 · " + knowledge.join("、");
    case "runtime":
      return "演示运行环境 · Codex / Native";
    case "delivery":
      return "点击查看归档工单与交付记录";
    default:
      return undefined;
  }
}
export function CampusMap({
  world,
  job,
  area,
  onArea,
  speed,
}: {
  world: World;
  job?: Job;
  area: Area | null;
  onArea: (a: Area) => void;
  speed: number;
}) {
  const [hover, setHover] = useState<Area | null>(null);
  const [focus, setFocus] = useState<Area | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const inspect = dismissed ? null : (hover ?? focus);
  const section = areas.find((a) => a.id === inspect);
  const total = world.jobs.filter((j) => j.status === "working").length;
  const local = section
    ? world.jobs.filter((j) => usesArea(j, section.id))
    : [];
  const watches = job ? [job] : world.jobs;
  const receiving = world.jobs.some(
    (j) => j.step === 0 && j.status === "working",
  );
  const working = world.jobs.filter((j) => j.status === "working");
  const at = (...stages: number[]) =>
    working.some((j) => stages.includes(j.step));
  const load = {
    control: at(1),
    runtime: at(1, 3, 4),
    line: at(2, 3),
    quality: at(4),
    monitor: working.length > 0,
  };
  return (
    <div className={"fc-map fc-day" + (!speed ? " paused" : "")}>
      <div className="fc-plate">
        <img
          src={campus}
          alt="生态河谷智能工厂：左侧河流、湿地与步道，远山和右侧光伏充电棚环绕厂区。左上接待大厅，右上企业资产仓，中排生产线和质检中心，底部运行时支撑、监控与交付站"
          draggable={false}
        />
        <ValleyEnvironment planning={load.control} />
        <ParkLights load={load} />
        <ValleyActivity
          world={world}
          watches={watches}
          speed={speed}
          hover={inspect}
        />
        <Traffic active={total} speed={speed} />
        <div
          className={"fc-ports" + (receiving ? " receiving" : "")}
          aria-hidden="true"
        >
          {channels.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        {areas.map((a) => {
          const here = watches.filter((j) => usesArea(j, a.id));
          const status =
            (["blocked", "review", "working", "done"] as const).find((s) =>
              here.some((j) => j.status === s),
            ) ?? "idle";
          const [x, y, w, h, tagX, tagY] = lots[a.id];
          const current = job && steps[job.step].area === a.id;
          return (
            <button
              key={a.id}
              className={
                "fc-lot " +
                status +
                (current || area === a.id ? " selected" : "") +
                (inspect === a.id ? " inspecting" : "")
              }
              data-area={a.id}
              aria-label={
                a.name +
                "，" +
                (status === "idle" ? "空闲" : statusName[status])
              }
              aria-describedby={
                inspect === a.id ? "fc-building-tip" : undefined
              }
              onMouseEnter={() => {
                setDismissed(false);
                setHover(a.id);
              }}
              onMouseLeave={() => setHover(null)}
              onFocus={(e) => {
                if (e.currentTarget.matches(":focus-visible")) {
                  setFocus(a.id);
                  setDismissed(false);
                }
              }}
              onBlur={() => setFocus(null)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDismissed(true);
              }}
              onClick={() => {
                setDismissed(true);
                onArea(a.id);
              }}
              style={
                {
                  left: x + "%",
                  top: y + "%",
                  width: w + "%",
                  height: h + "%",
                  "--tag-x": ((tagX - x) / w) * 100 + "%",
                  "--tag-y": ((tagY - y) / h) * 100 + "%",
                } as CSSProperties
              }
            >
              <span className="fc-sign">
                <i />
                {a.id === "line" ? "智能体生产线" : a.name}
                {here.length > 0 && (
                  <b>
                    {status === "blocked" || status === "review"
                      ? statusName[status] +
                        " " +
                        here.filter((j) => j.status === status).length
                      : here.length}
                  </b>
                )}
                {current && <span className="fc-ticket">{job.title}</span>}
              </span>
            </button>
          );
        })}
        {section && (
          <div
            role="tooltip"
            id="fc-building-tip"
            className="fc-building-tip"
            style={{
              left: `clamp(5px, calc(${lots[section.id][4]}% - var(--tip-width) / 2), calc(100% - var(--tip-width) - 5px))`,
              ...(lots[section.id][1] < 60
                ? { top: lots[section.id][1] + lots[section.id][3] + 1 + "%" }
                : { bottom: 101 - lots[section.id][1] + "%" }),
            }}
          >
            <strong>{section.name}</strong>
            <div>{section.description}</div>
            {extra(section.id) && (
              <div className="fc-tip-extra">{extra(section.id)}</div>
            )}
            <p>
              {section.id === "delivery" ? "已交付" : "关联工单"}{" "}
              <b>{local.length}</b> 张
            </p>
            {local.slice(0, 2).map((j) => (
              <div className="fc-tip-job" key={j.id}>
                <span>{statusName[j.status]}</span>
                {j.title} · {steps[j.step].name}
              </div>
            ))}
            {local.length === 0 && <div className="fc-tip-job">当前空闲</div>}
          </div>
        )}
      </div>
    </div>
  );
}
