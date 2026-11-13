// Desolate Lab — the facility telemetry strip behind the app bar, the way
// VegasSky is Bookworm Studio's. A graticule, a scope trace with a phosphor
// beam sweeping it, a ruler with the one event marked in signal red, and an
// instrument readout paging through Annex 07's channels: time unattended,
// the local clock and cycle, power source, and the uplink (navigator.onLine —
// the lamp is the only colour on the bar, and it only shouts when you are
// actually offline). Pure CSS/SVG, one 1s timer, paused while hidden.
import { useEffect, useMemo, useState } from "react";
import "@/styles/themes/desolate-lab-art.css";
import { channelIndex, channels, cycleOf, trace, TRACE_H, TRACE_W } from "./desolateLabTelemetry";

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let id: number | undefined;
    const start = () => {
      stop();
      setNow(new Date());
      id = window.setInterval(() => setNow(new Date()), 1000);
    };
    const stop = () => { if (id !== undefined) window.clearInterval(id); id = undefined; };
    const onVis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  return now;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

export default function DesolateLabArt() {
  const now = useNow();
  const online = useOnline();
  const { d, eventX } = useMemo(() => trace(), []);
  const chans = channels(now, online);
  const i = channelIndex(now.getTime(), chans.length);
  const ch = chans[i];
  const cycle = cycleOf(now.getHours());
  const scope = (cls: string) => (
    <svg className={cls} viewBox={`0 0 ${TRACE_W} ${TRACE_H}`} preserveAspectRatio="none">
      <path d={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );

  return (
    <div
      className="dla-art"
      data-desolate-art
      data-cycle={cycle}
      data-uplink={online ? "ok" : "lost"}
      aria-hidden="true"
    >
      <div className="dla-grid" />
      <div className="dla-scope">
        {scope("dla-trace")}
        <div className="dla-beam">
          <div className="dla-beam-inner">{scope("dla-trace dla-trace-lit")}</div>
        </div>
      </div>
      <div className="dla-ruler">
        <span className="dla-event" style={{ left: `${(eventX / TRACE_W) * 100}%` }} />
      </div>
      <div className="dla-readout">
        <span className="dla-lamp" />
        {/* keyed so each page change replays the phosphor settle */}
        <span key={ch.key} className="dla-page" data-alarm={ch.alarm || undefined}>
          <span className="dla-label">{ch.label}</span>
          <span className="dla-value">{ch.value}</span>
        </span>
        <span className="dla-pips">
          {chans.map((c, n) => <span key={c.key} data-on={n === i || undefined} />)}
        </span>
      </div>
    </div>
  );
}
