"use client";

import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { createContext, useContext, useMemo, useRef, useState, useEffect } from "react";

export interface BarProps {
  dataKey: string;
  fill?: string;
  lineCap?: "round" | "butt" | "square";
  radius?: number;
}

export interface BarXAxisProps {
  dataKey?: string;
  tickFormat?: (value: string) => string;
}

export interface GridProps {
  horizontal?: boolean;
  vertical?: boolean;
  stroke?: string;
  strokeDasharray?: string;
}

export interface ChartTooltipProps {
  content?: (props: { data: Record<string, unknown>; dataKey: string }) => React.ReactNode;
}

export interface BarChartProps {
  data: Record<string, unknown>[];
  xDataKey: string;
  children: React.ReactNode;
  width?: number;
  height?: number;
  className?: string;
}

const defaultTickFormat = (value: string) => value;

interface BarChartContextValue {
  xScale: ReturnType<typeof scaleBand<string>>;
  yScale: ReturnType<typeof scaleLinear<number>>;
  data: Record<string, unknown>[];
  xDataKey: string;
  innerWidth: number;
  innerHeight: number;
  margin: { top: number; right: number; bottom: number; left: number };
  width: number;
  height: number;
}

const BarChartContext = createContext<BarChartContextValue | null>(null);

export function useBarChart() {
  const ctx = useContext(BarChartContext);
  if (!ctx) throw new Error("useBarChart must be used within BarChart");
  return ctx;
}

export function BarChart({
  data,
  xDataKey,
  children,
  width: propWidth,
  height = 120,
  className,
}: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(propWidth ?? 280);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const margin = { top: 10, right: 10, bottom: 24, left: 10 };

  const xScale = useMemo(() => {
    return scaleBand<string>({
      domain: data.map((d) => String(d[xDataKey])),
      padding: 0.3,
    });
  }, [data, xDataKey]);

  const yScale = useMemo(() => {
    const maxVal = 100;
    return scaleLinear<number>({
      domain: [0, maxVal],
      nice: true,
    });
  }, []);

  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  xScale.range([0, innerWidth]);
  yScale.range([innerHeight, 0]);

  const chartContext = useMemo<BarChartContextValue>(
    () => ({
      xScale,
      yScale,
      data,
      xDataKey,
      innerWidth,
      innerHeight,
      margin,
      width,
      height,
    }),
    [xScale, yScale, data, xDataKey, innerWidth, innerHeight, margin, width, height]
  );

  return (
    <div ref={containerRef} className={className} style={{ width: '100%' }}>
      <svg width={width} height={height}>
        <BarChartContext.Provider value={chartContext}>
          <Group left={margin.left} top={margin.top}>
            {children}
          </Group>
        </BarChartContext.Provider>
      </svg>
    </div>
  );
}

export function Bar({ dataKey, fill = "var(--chart-line-primary)", radius = 4 }: BarProps) {
  const { xScale, data, xDataKey, innerHeight } = useBarChart();

  const allValues = data.map((d) => Math.max(Number(d[dataKey]) || 0, 1));
  const maxVal = Math.max(...allValues, 0);

  return (
    <>
      {data.map((d, i) => {
        const xVal = String(d[xDataKey]);
        const yVal = Math.max(Number(d[dataKey]) || 0, 1);
        const barX = xScale(xVal) ?? 0;
        const barWidth = xScale.bandwidth();
        const barHeight = maxVal > 0 ? (yVal / maxVal) * innerHeight : innerHeight;

        return (
          <rect
            key={`${dataKey}-${i}`}
            x={barX}
            y={innerHeight - barHeight}
            width={barWidth}
            height={barHeight}
            fill={fill}
            rx={radius}
            ry={radius}
          />
        );
      })}
    </>
  );
}

export function BarXAxis({ tickFormat = defaultTickFormat }: BarXAxisProps) {
  const { xScale, innerHeight } = useBarChart();
  const ticks = xScale.domain();

  return (
    <g transform={`translate(0, ${innerHeight})`}>
      <line stroke="var(--chart-grid)" x1={0} x2={xScale.range()[1]} />
      {ticks.map((tick) => (
        <text
          key={tick}
          x={(xScale(tick) ?? 0) + xScale.bandwidth() / 2}
          y={14}
          textAnchor="middle"
          fill="var(--chart-text)"
          fontSize={9}
        >
          {tickFormat(String(tick))}
        </text>
      ))}
    </g>
  );
}

export function Grid({
  horizontal = false,
  vertical = false,
  stroke = "var(--chart-grid)",
  strokeDasharray = "4 4",
}: GridProps) {
  const { yScale, innerWidth, innerHeight } = useBarChart();
  const yTicks = yScale.ticks(5);

  return (
    <g>
      {horizontal &&
        yTicks.map((tick) => (
          <line
            key={`h-${tick}`}
            x1={0}
            x2={innerWidth}
            y1={yScale(tick)}
            y2={yScale(tick)}
            stroke={stroke}
            strokeDasharray={strokeDasharray}
          />
        ))}
      {vertical && (
        <line
          x1={0}
          x2={0}
          y1={0}
          y2={innerHeight}
          stroke={stroke}
          strokeDasharray={strokeDasharray}
        />
      )}
    </g>
  );
}

export function ChartTooltip({ content }: ChartTooltipProps) {
  return null;
}
