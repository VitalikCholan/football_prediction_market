import { OUTRIGHT } from "@/lib/fixtures";

/** Outright market card (1b) — World Cup Winner ranked list. */
export function OutrightCard() {
  return (
    <div className="scr reveal flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <span className="tag">Outright</span>
        <span className="text-[12px] text-muted">Live odds</span>
      </div>
      <div className="text-[16px] font-700 leading-tight">
        {OUTRIGHT.title}
      </div>
      <ul className="flex flex-col gap-1.5">
        {OUTRIGHT.entries.map((e) => (
          <li
            key={e.team}
            className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-black/[0.03]"
          >
            <span className="text-[13px] font-500">{e.team}</span>
            <span className="chip yc tnum px-2.5 py-1 text-[14px] font-700">
              {e.cents}¢
            </span>
          </li>
        ))}
      </ul>
      <button className="link mt-1 self-start text-[13px] font-600">
        +{OUTRIGHT.more} more →
      </button>
    </div>
  );
}
