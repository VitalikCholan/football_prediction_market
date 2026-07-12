"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  LineSeries,
  ColorType,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
  type LineData,
} from "lightweight-charts";
import type { HistoryPointDto } from "@fpm/shared";

/**
 * Hero price-history chart (DESIGN_SPEC 1c). Multi-line: the leading side in
 * green, the trailing side in red, and a dashed grey draw line — mirroring the
 * wireframe legend "Brazil 46¢ / Argentina 33¢ / Draw 24¢". lightweight-charts
 * v5 (`addSeries(LineSeries, …)`). Dynamically imported with ssr:false by the
 * parent so the TradingView lib never runs on the server.
 */
export default function PriceChart({
  points,
  homeLabel,
  awayLabel,
}: {
  points: HistoryPointDto[];
  homeLabel: string;
  awayLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#8f8b83",
        fontFamily: "var(--font-inter), sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#f0ede7" },
        horzLines: { color: "#f0ede7" },
      },
      rightPriceScale: { borderColor: "#e6e2da" },
      timeScale: { borderColor: "#e6e2da", timeVisible: true },
      crosshair: { mode: 0 },
      height: 320,
      autoSize: true,
    });
    chartRef.current = chart;

    const toLine = (pick: (p: HistoryPointDto) => number): LineData[] =>
      points.map((p) => ({
        time: p.time as UTCTimestamp,
        value: pick(p) / 100,
      }));

    // Three real softmax series: home (Team1), away (Team2), draw (dashed).
    const homeSeries = chart.addSeries(LineSeries, {
      color: "#2f9e5f",
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(0)}¢` },
    });
    const awaySeries = chart.addSeries(LineSeries, {
      color: "#d1495b",
      lineWidth: 2,
      priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(0)}¢` },
    });
    const drawSeries = chart.addSeries(LineSeries, {
      color: "#b8b2a7",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(0)}¢` },
    });

    homeSeries.setData(toLine((p) => p.team1PriceBps));
    drawSeries.setData(toLine((p) => p.drawPriceBps));
    awaySeries.setData(toLine((p) => p.team2PriceBps));

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [points]);

  return (
    <div>
      <div
        ref={ref}
        className="h-[320px] w-full"
        role="img"
        aria-label={`Price history for ${homeLabel} vs ${awayLabel}`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[12px]">
        <Legend color="#2f9e5f" label={homeLabel} />
        <Legend color="#b8b2a7" label="Draw" dashed />
        <Legend color="#d1495b" label={awayLabel} />
      </div>
    </div>
  );
}

function Legend({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 text-muted">
      <span
        className="inline-block h-0.5 w-4"
        style={{
          background: dashed
            ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`
            : color,
        }}
        aria-hidden
      />
      {label}
    </span>
  );
}
